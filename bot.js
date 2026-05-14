/**
 * bot.js — Claude-driven conversational flow
 *
 * States:
 *   collecting  — Claude analyzes each message, extracts fields, asks naturally
 *   email       — simple validated email collection
 *   confirm     — show summary, wait for send / restart
 *
 * Required fields: details (sufficient quality), account, platform
 * Optional:        urgency (defaults Medium), steps
 * Final:           email (validated format)
 */

const fs   = require('fs');
const path = require('path');
const { postToSlack }            = require('./slack');
const { saveReport, getReport, updateStatus } = require('./store');
const { analyzeAndCollect }      = require('./claude');

// ── Session persistence ───────────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let sessions = {};

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    Object.entries(raw).forEach(([k, v]) => {
      sessions[k] = {
        state:   v.state   || 'collecting',
        data:    { ...v.data, images: [] },   // never persist base64
        history: v.history || []
      };
    });
  }
} catch (e) { sessions = {}; }

function persistSessions() {
  const toSave = {};
  Object.entries(sessions).forEach(([k, v]) => {
    toSave[k] = {
      state:   v.state,
      data:    { ...v.data, images: [] },
      history: (v.history || []).slice(-12)   // keep last 12 turns
    };
  });
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(toSave, null, 2)); } catch (e) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────
const REPORT_ID_PATTERN = /^\d{8}-RPT-\d{3}$/;

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { state: 'collecting', data: { images: [] }, history: [] };
  }
  const s = sessions[sessionId];
  if (!s.data.images) s.data.images = [];
  if (!s.history)     s.history     = [];
  // Backward-compat: map any old step-based states to 'collecting'
  if (!s.state || !['collecting','photo','email','confirm'].includes(s.state)) {
    s.state = 'collecting';
  }
  return s;
}

function greetMessage() {
  return (
    'Xin chào! 👋 Tôi là bot báo cáo lỗi của Rize Vietnam.\n\n' +
    'Bạn đang gặp vấn đề gì? Hãy mô tả tự nhiên — bao gồm màn hình nào, ' +
    'PG / nhóm nông dân liên quan, và điều gì đã xảy ra. ' +
    'Tôi sẽ hỏi thêm nếu cần.\n\n' +
    '📎 Bạn có thể đính kèm ảnh chụp màn hình bất cứ lúc nào.'
  );
}

function generateReportId() {
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
  return `${date}-RPT-${suffix}`;
}

function buildSummary(data) {
  const urgencyLabel = data.urgency === 'High' ? '🔴 Cao'
    : data.urgency === 'Low' ? '🟢 Thấp' : '🟡 Trung bình';
  const photoNote = (data.images || []).length > 0
    ? `${data.images.length} ảnh đính kèm` : 'Không có ảnh';
  const stepsNote = data.steps
    ? `\n\n*Các bước tái hiện:*\n${data.steps}` : '';
  const catVi = {
    'App Bug':         'Lỗi ứng dụng',
    'Farmer Data':     'Dữ liệu nông dân',
    'AWD Task':        'AWD Task',
    'Farmer-Zoho Sync':'Đồng bộ Zoho',
    'Admin Request':   'Yêu cầu Admin',
    'Integration':     'Tích hợp'
  }[data.category] || (data.category || 'Lỗi ứng dụng');

  return (
    `*Xác nhận báo cáo:*\n\n` +
    `[${catVi}] ${data.summary || (data.details || '').substring(0, 80)}\n\n` +
    `*Email:*                  ${data.email}\n` +
    `*PG / Nông dân:*          ${data.account  || '—'}\n` +
    `*Nền tảng:*               ${data.platform || '—'}\n` +
    `*Mức độ khẩn cấp:*        ${urgencyLabel}\n` +
    `*Ảnh đính kèm:*           ${photoNote}\n\n` +
    `*Mô tả vấn đề:*\n${data.details}` +
    `${stepsNote}\n\n` +
    `_Nhấn Gửi để gửi hoặc Bắt đầu lại để làm lại._`
  );
}

// ── Main entry ────────────────────────────────────────────────────────────
async function processMessage(sessionId, text, images) {
  const session = getSession(sessionId);

  // Always capture images (accepted at any point in the conversation)
  if (images && images.length > 0) {
    images.forEach(img => session.data.images.push(img));
  }

  // Restart command
  if (text && (text.toUpperCase().includes('BẮT ĐẦU LẠI') || text.toUpperCase() === 'RESTART')) {
    sessions[sessionId] = { state: 'collecting', data: { images: [] }, history: [] };
    persistSessions();
    return { messages: [greetMessage()] };
  }

  // Report ID status lookup
  if (text && REPORT_ID_PATTERN.test(text.trim())) {
    const reportId = text.trim();
    const report   = getReport(reportId);
    if (!report) {
      return { messages: [`Không tìm thấy báo cáo *${reportId}*. Vui lòng kiểm tra lại mã.`] };
    }
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

// ── STATE: collecting (Claude-driven) ────────────────────────────────────
async function handleCollecting(session, sessionId, text, images) {
  const { data, history } = session;

  // Images sent with no text — acknowledge and prompt for description
  if ((!text || text.trim().length < 2) && data.images.length > 0 && history.length === 0) {
    const n        = data.images.length;
    const response = `Cảm ơn bạn đã gửi ${n > 1 ? n + ' ảnh' : 'ảnh'}! Bạn có thể mô tả vấn đề đang gặp không?`;
    history.push({ role: 'bot', text: response });
    persistSessions();
    return { messages: [response] };
  }

  if (!text || text.trim().length < 2) {
    return { messages: [greetMessage()] };
  }

  const userText = text.trim();
  history.push({ role: 'user', text: userText });

  // ── Ask Claude to orchestrate ─────────────────────────────────────────
  let result;
  try {
    result = await analyzeAndCollect(history, data, userText);
  } catch (e) {
    console.error('[bot] analyzeAndCollect error:', e.message);
    result = null;
  }

  // Fallback when Claude is unavailable
  if (!result) {
    const missing = [];
    if (!data.details)  missing.push('mô tả vấn đề');
    if (!data.account)  missing.push('tên PG hoặc nông dân');
    if (!data.platform) missing.push('vấn đề xảy ra trên iOS, Android hay Zoho');

    const response = missing.length > 0
      ? `Bạn có thể cho tôi biết thêm: ${missing.join(', ')}?`
      : 'Bạn có thể mô tả thêm không?';

    history.push({ role: 'bot', text: response });
    persistSessions();
    return {
      messages:     [response],
      quickReplies: !data.platform ? ['iOS', 'Android', 'Zoho'] : null
    };
  }

  // ── Apply extracted updates (don't overwrite richer existing values) ──
  const u = result.updates || {};

  if (u.details) {
    // Prefer the longer / more informative description
    if (!data.details || u.details.length > (data.details || '').length) {
      data.details = u.details;
    }
  }
  if (u.account  && !data.account)  data.account  = u.account;
  if (u.platform && !data.platform) data.platform = u.platform;
  if (u.urgency  && !data.urgency)  data.urgency  = u.urgency;
  if (u.steps    && !data.steps)    data.steps    = u.steps;
  if (u.category)                   data.category = u.category;
  if (u.summary)                    data.summary  = u.summary;

  // Add Claude's response to history
  if (result.response) {
    history.push({ role: 'bot', text: result.response });
  }

  persistSessions();

  // ── All required fields collected — ask for photo first if none yet ──
  if (result.readyToConfirm) {
    if (!data.images || data.images.length === 0) {
      // Ask for screenshot before email
      session.state = 'photo';
      persistSessions();
      const transition = result.response ? result.response + '\n\n' : '';
      return {
        messages:     [`${transition}Bạn có ảnh chụp màn hình nào muốn đính kèm không? Ảnh sẽ giúp kỹ thuật hiểu rõ hơn.`],
        quickReplies: ['⏭️ Bỏ qua'],
        showUpload:   true
      };
    }
    // Already have images — go straight to email
    session.state = 'email';
    persistSessions();
    const imgNote = `Đã nhận ${data.images.length} ảnh chụp màn hình.\n\n`;
    return {
      messages: [`${imgNote}Cuối cùng, email công ty của bạn là gì? (ví dụ: ten@rize.farm)`]
    };
  }

  return {
    messages:     [result.response || 'Bạn có thể mô tả thêm không?'],
    quickReplies: result.quickReplies || null
  };
}

// ── STATE: photo ─────────────────────────────────────────────────────────
// Images are captured at the top of processMessage regardless of state,
// so by the time we get here the images array is already updated.
async function handlePhoto(session, sessionId, text) {
  // Move on whether they attached images or clicked Skip
  session.state = 'email';
  persistSessions();

  const n = (session.data.images || []).length;
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

  // Fill defaults
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
    const reportId   = generateReportId();
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
      slackTs:      slackResult?.ts      || null,
      slackChannel: slackResult?.channel || null,
      createdAt:    new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
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
