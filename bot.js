const fs = require('fs');
const path = require('path');
const { postToSlack } = require('./slack');
const { saveReport, getReport, updateStatus } = require('./store');
const { analyzeDescription } = require('./claude');

// ── Session persistence ────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let sessions = {};

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    Object.entries(raw).forEach(([k, v]) => {
      sessions[k] = { step: v.step, data: { ...v.data, images: [] } };
    });
  }
} catch (e) { sessions = {}; }

function persistSessions() {
  const toSave = {};
  Object.entries(sessions).forEach(([k, v]) => {
    toSave[k] = { step: v.step, data: { ...v.data, images: [] } };
  });
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(toSave, null, 2)); } catch (e) {}
}

// ── Report ID pattern ─────────────────────────────────────────────────────
const REPORT_ID_PATTERN = /^\d{8}-RPT-\d{3}$/;

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { step: 'describe', data: { images: [] } };
  }
  if (!sessions[sessionId].data.images) sessions[sessionId].data.images = [];
  return sessions[sessionId];
}

function greetMessage() {
  return `Xin chào! 👋 Tôi là bot báo cáo của Rize Vietnam.\n\nVui lòng mô tả chi tiết vấn đề bạn gặp phải. Hãy bao gồm:\n• Vấn đề cụ thể là gì\n• Nhóm Trồng Trọt (PG) hoặc tên nông dân liên quan\n\n📎 Bạn có thể đính kèm ảnh chụp màn hình ngay trong tin nhắn này.`;
}

async function processMessage(sessionId, text, images) {
  const session = getSession(sessionId);

  // Capture any images sent at any step
  if (images && images.length > 0) {
    images.forEach(img => session.data.images.push(img));
  }

  // Restart
  if (text && (text.toUpperCase().includes('BẮT ĐẦU LẠI') || text.toUpperCase() === 'RESTART')) {
    sessions[sessionId] = { step: 'describe', data: { images: [] } };
    persistSessions();
    return { messages: [greetMessage()] };
  }

  // Status check by report ID
  if (text && REPORT_ID_PATTERN.test(text.trim())) {
    const reportId = text.trim();
    const report = getReport(reportId);
    if (!report) return { messages: [`Không tìm thấy báo cáo *${reportId}*. Vui lòng kiểm tra lại mã báo cáo.`] };

    // Try to get live status from Slack reactions
    const { getSlackReactionStatus } = require('./slack');
    const liveStatus = await getSlackReactionStatus(report.slackTs, report.slackChannel);
    const status = liveStatus || report.status || 'In Progress';

    // Update stored status if changed
    if (liveStatus && liveStatus !== report.status) updateStatus(reportId, liveStatus);

    const statusEmoji = status === 'Fixed' ? '✅' : status === 'In Progress' ? '🔄' : '⏳';
    return {
      messages: [
        `${statusEmoji} *Báo cáo ${reportId}*\n\nVấn đề: ${report.issue || report.summary}\nTrạng thái: *${status}*\nGửi lúc: ${report.createdAt}\n\n_Nhập BẮT ĐẦU LẠI để gửi báo cáo mới._`
      ]
    };
  }

  // Init call
  if (text === '__init__') return { messages: [greetMessage()] };

  return await handleStep(session, sessionId, text);
}

async function handleStep(session, sessionId, text) {
  const { step, data } = session;

  // ── STEP 1: describe ──────────────────────────────────────────────────────
  if (step === 'describe') {
    if ((!text || text.trim().length < 5) && data.images.length === 0) {
      return { messages: [greetMessage()] };
    }

    if (text) data.details = text.trim();

    // Analyze description quality with Claude
    const analysis = await analyzeDescription(data.details || '');
    data.category = analysis.category || 'App Bug';
    data.summary = analysis.summary || (data.details || '').split(/[.!?\n]/)[0].trim().substring(0, 100);

    // Auto-detect urgency
    if (text) {
      const lower = text.toLowerCase();
      if (['khẩn', 'urgent', 'gấp', 'critical', 'nghiêm trọng'].some(k => lower.includes(k))) data.urgency = 'High';
      else if (['thấp', 'low', 'không gấp', 'nhỏ'].some(k => lower.includes(k))) data.urgency = 'Low';
    }

    // Try to detect PG/account from text
    if (text) {
      const pgMatch = text.match(/(?:PG|KT|nhóm|nông dân|farmer)[:\s]+([^\n,\.]{3,60})/i);
      if (pgMatch) data.account = pgMatch[1].trim();
    }

    // If not detailed enough, ask follow-up ONCE
    if (!analysis.is_detailed && analysis.follow_up && !data.askedFollowUp) {
      data.askedFollowUp = true;
      session.step = 'followup';
      persistSessions();
      return { messages: [analysis.follow_up] };
    }

    return await nextStep(session, sessionId, data);
  }

  // ── STEP 2: follow-up elaboration ─────────────────────────────────────────
  if (step === 'followup') {
    if (text) {
      data.details = data.details ? `${data.details}\n\nAdditional context: ${text.trim()}` : text.trim();
      // Re-analyze to update category/summary
      const reanalysis = await analyzeDescription(data.details);
      data.category = reanalysis.category || data.category;
      data.summary = reanalysis.summary || data.summary;
      // Try again to detect account
      if (!data.account) {
        const pgMatch = text.match(/(?:PG|KT|nhóm|nông dân|farmer)[:\s]+([^\n,\.]{3,60})/i);
        if (pgMatch) data.account = pgMatch[1].trim();
      }
    }
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_account ─────────────────────────────────────────────────────
  if (step === 'ask_account') {
    if (!text || text.trim().length < 2) {
      return { messages: ['Vui lòng nhập tên Nhóm Trồng Trọt (PG) hoặc nông dân liên quan.'] };
    }
    data.account = text.trim();
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_platform ────────────────────────────────────────────────────
  if (step === 'ask_platform') {
    data.platform = (text || 'Other').replace(/[^\w\s]/g, '').trim() || 'Other';
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_reproduce ───────────────────────────────────────────────────
  if (step === 'ask_reproduce') {
    const skipped = !text || ['bỏ qua', 'skip', '⏭️ bỏ qua'].includes(text.toLowerCase().trim());
    data.steps = skipped ? '' : text.trim();
    data.stepsAnswered = true;
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_urgency ─────────────────────────────────────────────────────
  if (step === 'ask_urgency') {
    const lower = (text || '').toLowerCase();
    if (lower.includes('high') || lower.includes('🔴')) data.urgency = 'High';
    else if (lower.includes('low') || lower.includes('🟢')) data.urgency = 'Low';
    else data.urgency = 'Medium';
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_photo ───────────────────────────────────────────────────────
  if (step === 'ask_photo') {
    // Images already captured at top of processMessage; just move on
    data.photoAnswered = true;
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: ask_email ───────────────────────────────────────────────────────
  if (step === 'ask_email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!text || !emailRegex.test(text.trim())) {
      return { messages: ['Vui lòng nhập địa chỉ email công ty hợp lệ (ví dụ: ten@rize.farm).'] };
    }
    data.email = text.trim().toLowerCase();
    return await nextStep(session, sessionId, data);
  }

  // ── STEP: confirm ─────────────────────────────────────────────────────────
  if (step === 'confirm') {
    const upper = (text || '').toUpperCase().trim();
    if (upper.includes('GỬI') || upper.includes('GUI') || upper.includes('✅') || upper.includes('SEND')) {
      const reportId = generateReportId();
      const slackResult = await postToSlack({ ...data, reportId });
      saveReport(reportId, {
        email: data.email,
        account: data.account,
        platform: data.platform,
        category: data.category,
        summary: data.summary,
        issue: data.summary,
        details: data.details,
        steps: data.steps,
        urgency: data.urgency,
        imageCount: (data.images || []).length,
        status: 'In Progress',
        slackTs: slackResult?.ts || null,
        slackChannel: slackResult?.channel || null,
        createdAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
      });
      delete sessions[sessionId];
      persistSessions();
      return {
        messages: [`✅ Báo cáo đã được gửi thành công!\n\nMã báo cáo của bạn:\n*${reportId}*\n\nLưu mã này để kiểm tra trạng thái. Nhập BẮT ĐẦU LẠI để gửi báo cáo mới.`],
        done: true,
        reportId
      };
    }
    // Restart
    sessions[sessionId] = { step: 'describe', data: { images: [] } };
    persistSessions();
    return { messages: [greetMessage()] };
  }

  return { messages: [greetMessage()] };
}

// ── nextStep: decides what to ask next ────────────────────────────────────
async function nextStep(session, sessionId, data) {
  if (!data.account) {
    session.step = 'ask_account';
    persistSessions();
    return { messages: ['Nhóm Trồng Trọt (PG) hoặc tên nông dân liên quan là gì?'] };
  }

  if (!data.platform) {
    session.step = 'ask_platform';
    persistSessions();
    return {
      messages: ['Vấn đề xảy ra trên nền tảng nào?'],
      quickReplies: ['iOS', 'Android', 'Web', 'Khác']
    };
  }

  if (!data.stepsAnswered) {
    session.step = 'ask_reproduce';
    persistSessions();
    return {
      messages: ['Các bước để tái hiện vấn đề? Nhập từng bước trên từng dòng.\n_Ví dụ:\n1. Mở ứng dụng\n2. Vào mục Quotes\n3. ..._'],
      quickReplies: ['⏭️ Bỏ qua']
    };
  }

  if (!data.urgency) {
    session.step = 'ask_urgency';
    persistSessions();
    return {
      messages: ['Mức độ khẩn cấp của vấn đề này?'],
      quickReplies: ['🟢 Low', '🟡 Medium', '🔴 High']
    };
  }

  if (!data.photoAnswered && (!data.images || data.images.length === 0)) {
    session.step = 'ask_photo';
    persistSessions();
    return {
      messages: ['Có ảnh chụp màn hình hoặc tài liệu hỗ trợ không? (Có thể đính kèm nhiều ảnh cùng lúc)'],
      quickReplies: ['⏭️ Bỏ qua'],
      showUpload: true
    };
  }

  if (!data.email) {
    session.step = 'ask_email';
    persistSessions();
    const imgNote = data.images && data.images.length > 0 ? `Đã nhận ${data.images.length} ảnh.\n\n` : '';
    return { messages: [`${imgNote}Email công ty của bạn là gì?`] };
  }

  // All data collected — show confirmation
  session.step = 'confirm';
  persistSessions();
  return {
    messages: [buildSummary(data)],
    quickReplies: ['✅ Gửi báo cáo', '🔄 Bắt đầu lại'],
    isConfirm: true
  };
}

function buildSummary(data) {
  const urgencyLabel = data.urgency === 'High' ? '🔴 High' : data.urgency === 'Low' ? '🟢 Low' : '🟡 Medium';
  const photoNote = data.images && data.images.length > 0 ? `${data.images.length} ảnh đính kèm` : 'Không có ảnh';
  const stepsNote = data.steps ? `\n\nSteps to reproduce:\n${data.steps}` : '';

  return `*Xác nhận báo cáo:*\n\n[${data.category}] ${data.summary}\n\nEmail: ${data.email || '—'}\nPG/Farmer: ${data.account}\nPlatform: ${data.platform}\nUrgency: ${urgencyLabel}\nImages: ${photoNote}\n\nDescription:\n${data.details}${stepsNote}\n\n_Nhấn Gửi để gửi hoặc Bắt đầu lại để làm lại._`;
}

function generateReportId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
  return `${date}-RPT-${suffix}`;
}

module.exports = { processMessage, greetMessage };
