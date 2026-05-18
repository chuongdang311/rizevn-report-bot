/**
 * bot.js — thin relay layer around Claude's system-prompt-driven conversation
 *
 * Claude (via conductConversation) owns the entire collecting conversation.
 * This file owns only what must be programmatic:
 *   - Session persistence
 *   - Image capture (base64 never goes to Claude)
 *   - Parsing Claude's [REPORT_READY] completion signal
 *   - Photo prompt (if no images attached)
 *   - Email validation
 *   - Confirmation summary (Vietnamese)
 *   - Slack posting + report ID generation
 *
 * States: collecting → photo → email → confirm
 */

const fs   = require('fs');
const path = require('path');
const { postToSlack }                     = require('./slack');
const { saveReport, getReport, updateStatus } = require('./store');
const { conductConversation }             = require('./claude');

// ── Session persistence ───────────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let sessions = {};

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    Object.entries(raw).forEach(([k, v]) => {
      sessions[k] = {
        state:   v.state   || 'collecting',
        data:    { ...v.data, images: [] },
        history: migrateHistory(v.history || [])
      };
    });
  }
} catch (e) { sessions = {}; }

// Migrate old {role, text} format → proper API {role, content} format
function migrateHistory(history) {
  return history.map(h => ({
    role:    h.role === 'bot' ? 'assistant' : (h.role || 'user'),
    content: h.content || h.text || ''
  }));
}

function persistSessions() {
  const toSave = {};
  Object.entries(sessions).forEach(([k, v]) => {
    toSave[k] = {
      state:   v.state,
      data:    { ...v.data, images: [] },   // never persist base64 images
      history: (v.history || []).slice(-20) // keep last 20 turns
    };
  });
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(toSave, null, 2)); } catch (e) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────
const REPORT_ID_PATTERN = /^\d{8}-RPT-\d{3}$/;

const VALID_STATES = ['collecting', 'photo', 'email', 'confirm'];

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { state: 'collecting', data: { images: [] }, history: [] };
  }
  const s = sessions[sessionId];
  if (!s.data.images)              s.data.images = [];
  if (!s.history)                  s.history     = [];
  if (!VALID_STATES.includes(s.state)) s.state   = 'collecting';
  return s;
}

function greetMessage() {
  return (
    'Xin chào! 👋 Tôi là bot báo cáo lỗi của Rize Vietnam.\n\n' +
    'Bạn đang gặp vấn đề gì? Hãy mô tả tự nhiên — ' +
    'bao gồm màn hình nào, PG / nhóm nông dân liên quan, và điều gì đã xảy ra.\n\n' +
    '📎 Bạn có thể đính kèm ảnh chụp màn hình bất cứ lúc nào.'
  );
}

function generateReportId() {
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
  return `${date}-RPT-${suffix}`;
}

// Parse [REPORT_READY] signal from Claude's response.
// Returns extracted data object or null.
function parseCompletionSignal(text) {
  const marker = '[REPORT_READY]';
  const idx    = text.indexOf(marker);
  if (idx === -1) return null;

  const jsonStr = text.substring(idx + marker.length).trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[bot] Failed to parse REPORT_READY JSON:', e.message, '| snippet:', jsonStr.substring(0, 120));
    return null;
  }
}

// Parse [QR:a,b,c] quick-reply signal.
// Returns array of strings or null.
function parseQuickReplies(text) {
  const match = text.match(/\[QR:([^\]]+)\]/);
  if (!match) return null;
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

// Strip all bot signals from the display text.
function stripSignals(text) {
  return text
    .replace(/\[REPORT_READY\][\s\S]*/g, '') // everything from signal onwards
    .replace(/\[QR:[^\]]*\]/g, '')           // quick-reply markers
    .trim();
}

// Build the Vietnamese confirmation summary shown to the user before submit.
function buildSummary(data) {
  const urgencyLabel = data.urgency === 'High' ? '🔴 Cao'
    : data.urgency   === 'Low'  ? '🟢 Thấp' : '🟡 Trung bình';
  const photoNote = (data.images || []).length > 0
    ? `${data.images.length} ảnh đính kèm` : 'Không có ảnh';
  const stepsNote = data.steps
    ? `\n\n*Các bước tái hiện:*\n${data.steps}` : '';
  const catVi = {
    'App Bug':          'Lỗi ứng dụng',
    'Farmer Data':      'Dữ liệu nông dân',
    'AWD Task':         'AWD Task',
    'Farmer-Zoho Sync': 'Đồng bộ Zoho',
    'Admin Request':    'Yêu cầu Admin',
    'Integration':      'Tích hợp'
  }[data.category] || (data.category || 'Lỗi ứng dụng');

  return (
    `*Xác nhận báo cáo:*\n\n` +
    `[${catVi}] ${data.summary || (data.details || '').substring(0, 80)}\n\n` +
    `*Email:*               ${data.email}\n` +
    `*PG / Nông dân:*       ${data.account  || '—'}\n` +
    `*Nền tảng:*            ${data.platform || '—'}\n` +
    `*Mức độ khẩn cấp:*     ${urgencyLabel}\n` +
    `*Ảnh đính kèm:*        ${photoNote}\n\n` +
    `*Mô tả vấn đề:*\n${data.details}` +
    `${stepsNote}\n\n` +
    `_Nhấn Gửi để gửi hoặc Bắt đầu lại để làm lại._`
  );
}

// ── Main entry ────────────────────────────────────────────────────────────
async function processMessage(sessionId, text, images) {
  const session = getSession(sessionId);

  // Always capture images — accepted at any point in the conversation
  if (images && images.length > 0) {
    images.forEach(img => session.data.images.push(img));
  }

  // Restart command
  const upperText = (text || '').toUpperCase().trim();
  if (upperText.includes('BẮT ĐẦU LẠI') || upperText === 'RESTART') {
    sessions[sessionId] = { state: 'collecting', data: { images: [] }, history: [] };
    persistSessions();
    return { messages: [greetMessage()] };
  }

  // Report ID status lookup — works in any state
  if (text && REPORT_ID_PATTERN.test(text.trim())) {
    const reportId = text.trim();
    const report   = getReport(reportId);
    if (!report) return { messages: [`Không tìm thấy báo cáo *${reportId}*. Vui lòng kiểm tra lại mã.`] };

    const { getSlackReactionStatus } = require('./slack');
    const liveStatus = await getSlackReactionStatus(report.slackTs, report.slackChannel);
    const status     = liveStatus || report.status || 'In Progress';
    if (liveStatus && liveStatus !== report.status) updateStatus(reportId, liveStatus);

    const emoji = status === 'Fixed' ? '✅' : status === 'In Progress' ? '🔄' : '⏳';
    return {
      messages: [
        `${emoji} *Báo cáo ${reportId}*\n\n` +
        `Vấn đề: ${report.issue || report.summary}\n` +
        `Trạng thái: *${status}*\n` +
        `Gửi lúc: ${report.createdAt}\n\n` +
        `_Nhập BẮT ĐẦU LẠI để gửi báo cáo mới._`
      ]
    };
  }

  // Init call from UI on page load
  if (text === '__init__') return { messages: [greetMessage()] };

  // Route by state
  const { state } = session;
  if (state === 'collecting') return await handleCollecting(session, sessionId, text, images);
  if (state === 'photo')      return await handlePhoto(session, sessionId, text);
  if (state === 'email')      return await handleEmail(session, sessionId, text);
  if (state === 'confirm')    return await handleConfirm(session, sessionId, text);

  return { messages: [greetMessage()] };
}

// ── STATE: collecting — Claude drives the full conversation ───────────────
async function handleCollecting(session, sessionId, text, images) {
  const { data, history } = session;

  // Images sent with no text at the very start
  if ((!text || text.trim().length < 2) && data.images.length > 0 && history.length === 0) {
    const n       = data.images.length;
    const botMsg  = `Cảm ơn bạn đã gửi ${n > 1 ? n + ' ảnh' : 'ảnh'}! Bạn có thể mô tả vấn đề đang gặp không?`;
    history.push({ role: 'assistant', content: botMsg });
    persistSessions();
    return { messages: [botMsg] };
  }

  if (!text || text.trim().length < 2) {
    return { messages: [greetMessage()] };
  }

  // Build user content — append image note so Claude knows screenshots exist
  let userContent = text.trim();
  if (images && images.length > 0) {
    userContent += `\n(${images.length} screenshot${images.length > 1 ? 's' : ''} attached)`;
  }

  history.push({ role: 'user', content: userContent });

  // ── Hand off to Claude with the system prompt + full history ──────────
  const rawResponse = await conductConversation(history);

  if (!rawResponse) {
    // Fallback when Claude is unavailable (no API key or network issue)
    const missing = [];
    if (!data.details)  missing.push('mô tả vấn đề');
    if (!data.account)  missing.push('tên PG hoặc nông dân');
    if (!data.platform) missing.push('nền tảng (iOS / Android / Zoho)');

    const fallback = missing.length > 0
      ? `Bạn có thể cho tôi biết thêm: ${missing.join(', ')}?`
      : 'Bạn có thể mô tả thêm không?';

    history.push({ role: 'assistant', content: fallback });
    persistSessions();
    return {
      messages:     [fallback],
      quickReplies: !data.platform ? ['iOS', 'Android', 'Zoho'] : null
    };
  }

  // ── Check for completion signal ───────────────────────────────────────
  const reportData = parseCompletionSignal(rawResponse);

  if (reportData) {
    // Apply all fields Claude collected
    data.details  = reportData.details  || data.details  || '';
    data.account  = reportData.account  || data.account  || '';
    data.platform = reportData.platform || data.platform || '';
    data.urgency  = reportData.urgency  || 'Medium';
    data.steps    = reportData.steps    || '';
    data.category = reportData.category || 'App Bug';
    data.summary  = reportData.summary  || '';

    // Store only the visible part of Claude's message (before the signal)
    const visibleText = stripSignals(rawResponse);
    if (visibleText) history.push({ role: 'assistant', content: visibleText });
    persistSessions();

    // Transition: ask for photo if none attached yet
    if (!data.images || data.images.length === 0) {
      session.state = 'photo';
      persistSessions();
      const photoPrompt = visibleText
        ? `${visibleText}\n\nBạn có ảnh chụp màn hình nào muốn đính kèm không? Ảnh giúp kỹ thuật hiểu rõ hơn.`
        : 'Bạn có ảnh chụp màn hình nào muốn đính kèm không? Ảnh giúp kỹ thuật hiểu rõ hơn.';
      return {
        messages:   [photoPrompt],
        quickReplies: ['⏭️ Bỏ qua'],
        showUpload: true
      };
    }

    // Already have images — skip straight to email
    session.state = 'email';
    persistSessions();
    return {
      messages: [`Đã nhận ${data.images.length} ảnh chụp màn hình.\n\nCuối cùng, email công ty của bạn là gì? (ví dụ: ten@rize.farm)`]
    };
  }

  // ── Normal response — relay Claude's message as-is ────────────────────
  const quickReplies  = parseQuickReplies(rawResponse);
  const displayText   = stripSignals(rawResponse);

  history.push({ role: 'assistant', content: displayText || rawResponse });
  persistSessions();

  return {
    messages:     [displayText || rawResponse],
    quickReplies: quickReplies || null
  };
}

// ── STATE: photo ──────────────────────────────────────────────────────────
async function handlePhoto(session, sessionId, text) {
  // Images are captured at the top of processMessage regardless of state
  session.state = 'email';
  persistSessions();

  const n       = (session.data.images || []).length;
  const imgNote = n > 0 ? `Đã nhận ${n} ảnh chụp màn hình! 📸\n\n` : '';
  return {
    messages: [`${imgNote}Cuối cùng, email công ty của bạn là gì? (ví dụ: ten@rize.farm)`]
  };
}

// ── STATE: email ──────────────────────────────────────────────────────────
async function handleEmail(session, sessionId, text) {
  const { data } = session;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!text || !emailRegex.test(text.trim())) {
    return { messages: ['Vui lòng nhập địa chỉ email công ty hợp lệ (ví dụ: ten@rize.farm).'] };
  }

  data.email = text.trim().toLowerCase();

  // Fill any missing defaults
  if (!data.summary)  data.summary  = (data.details || '').split(/[.!?\n]/)[0].trim().substring(0, 100);
  if (!data.urgency)  data.urgency  = 'Medium';
  if (!data.category) data.category = 'App Bug';

  session.state = 'confirm';
  persistSessions();

  return {
    messages:     [buildSummary(data)],
    quickReplies: ['✅ Gửi báo cáo', '🔄 Bắt đầu lại'],
    isConfirm:    true
  };
}

// ── STATE: confirm ────────────────────────────────────────────────────────
async function handleConfirm(session, sessionId, text) {
  const { data } = session;
  const upper = (text || '').toUpperCase().trim();

  if (upper.includes('GỬI') || upper.includes('GUI') || upper.includes('✅') || upper.includes('SEND')) {
    const reportId    = generateReportId();
    const slackResult = await postToSlack({ ...data, reportId });

    saveReport(reportId, {
      email:        data.email,
      account:      data.account      || '',
      platform:     data.platform     || '',
      category:     data.category     || 'App Bug',
      summary:      data.summary      || '',
      issue:        data.summary      || '',
      details:      data.details      || '',
      steps:        data.steps        || '',
      urgency:      data.urgency      || 'Medium',
      imageCount:   (data.images || []).length,
      status:       'In Progress',
      slackTs:      slackResult?.ts       || null,
      slackChannel: slackResult?.channel  || null,
      createdAt:    new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      history:      (session.history || []).map(h => ({ role: h.role, content: h.content }))
    });

    delete sessions[sessionId];
    persistSessions();

    return {
      messages: [
        `✅ Báo cáo đã được gửi thành công!\n\n` +
        `Mã báo cáo của bạn:\n*${reportId}*\n\n` +
        `Lưu mã này để kiểm tra trạng thái sau. Nhập BẮT ĐẦU LẠI để gửi báo cáo mới.`
      ],
      done:     true,
      reportId
    };
  }

  // Any other input = restart
  sessions[sessionId] = { state: 'collecting', data: { images: [] }, history: [] };
  persistSessions();
  return { messages: [greetMessage()] };
}

module.exports = { processMessage, greetMessage };
