const fs = require('fs');
const path = require('path');
const { postToSlack } = require('./slack');
const { saveReport, getReport } = require('./store');

// ── Session persistence ────────────────────────────────────────────────────
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
let sessions = {};

try {
  if (fs.existsSync(SESSIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    // Strip large image data — can't persist base64 blobs
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

// ── Report ID regex for status checks ────────────────────────────────────
const REPORT_ID_PATTERN = /^\d{8}-RPT-\d{3}$/;

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { step: 'describe', data: { images: [] } };
  }
  if (!sessions[sessionId].data.images) {
    sessions[sessionId].data.images = [];
  }
  return sessions[sessionId];
}

function greetMessage() {
  return `Xin chào! 👋 Tôi là bot báo cáo của Rize Vietnam.\n\nVui lòng mô tả vấn đề bạn gặp phải. Hãy bao gồm:\n• Chi tiết vấn đề\n• Nhóm Trồng Trọt (PG) hoặc tên nông dân liên quan\n\n📎 Bạn có thể đính kèm ảnh ngay trong tin nhắn này.`;
}

async function processMessage(sessionId, text, images) {
  const session = getSession(sessionId);

  // Always capture any incoming images into session
  if (images && images.length > 0) {
    images.forEach(img => session.data.images.push(img));
  }

  // Restart
  if (text && (text.toUpperCase().includes('BẮT ĐẦU LẠI') || text.toUpperCase() === 'RESTART')) {
    sessions[sessionId] = { step: 'describe', data: { images: [] } };
    persistSessions();
    return { messages: [greetMessage()] };
  }

  // Status check — user types a report ID
  if (text && REPORT_ID_PATTERN.test(text.trim())) {
    const report = getReport(text.trim());
    if (report) {
      const emoji = report.status === 'Đã xử lý' ? '✅' : report.status === 'Cần thêm thông tin' ? '⚠️' : '🔄';
      return {
        messages: [`${emoji} *Báo cáo ${text.trim()}*\n\nVấn đề: ${report.issue}\nTrạng thái: *${report.status}*\nGửi lúc: ${report.createdAt}\n\n_Nhập BẮT ĐẦU LẠI để gửi báo cáo mới._`]
      };
    }
    return { messages: [`Không tìm thấy báo cáo *${text.trim()}*. Vui lòng kiểm tra lại.`] };
  }

  // Init call from page load
  if (text === '__init__') {
    return { messages: [greetMessage()] };
  }

  return await handleStep(session, sessionId, text, images);
}

async function handleStep(session, sessionId, text, images) {
  const { step, data } = session;

  // ── STEP 1: Free-form description ─────────────────────────────────────────
  if (step === 'describe') {
    if ((!text || text.trim().length < 5) && (!data.images || data.images.length === 0)) {
      return { messages: [greetMessage()] };
    }

    if (text) {
      data.details = text.trim();
      // Use first sentence as issue title
      data.issue = text.split(/[.!?\n]/)[0].trim().substring(0, 120);
    }

    // Auto-detect urgency from text
    if (text) {
      const lower = text.toLowerCase();
      const highUrgency = ['khẩn', 'urgent', 'gấp', 'critical', 'nghiêm trọng', 'ngay lập tức'];
      const lowUrgency = ['thấp', 'low', 'không gấp', 'từ từ', 'bình thường', 'nhỏ'];
      if (highUrgency.some(k => lower.includes(k))) data.urgency = 'Khẩn cấp';
      else if (lowUrgency.some(k => lower.includes(k))) data.urgency = 'Thấp';
    }

    // Try to detect PG/account from text
    if (text) {
      const pgMatch = text.match(/(?:PG|KT|nhóm|tên nông dân|farmer)[:\s]+([^\n,\.]+)/i);
      if (pgMatch) data.account = pgMatch[1].trim();
    }

    if (!data.account) {
      session.step = 'ask_account';
      persistSessions();
      return { messages: ['Cảm ơn! Nhóm Trồng Trọt (PG) hoặc tên nông dân liên quan là gì?'] };
    }

    session.step = 'ask_urgency';
    persistSessions();
    return {
      messages: ['Cảm ơn! Mức độ khẩn cấp của vấn đề này?'],
      quickReplies: ['🟢 Thấp', '🟡 Trung bình', '🔴 Khẩn cấp']
    };
  }

  // ── STEP 2: PG / Account ─────────────────────────────────────────────────
  if (step === 'ask_account') {
    if (!text || text.trim().length < 2) {
      return { messages: ['Vui lòng nhập tên Nhóm Trồng Trọt (PG) hoặc nông dân liên quan.'] };
    }
    data.account = text.trim();
    session.step = 'ask_urgency';
    persistSessions();
    return {
      messages: ['Mức độ khẩn cấp của vấn đề này?'],
      quickReplies: ['🟢 Thấp', '🟡 Trung bình', '🔴 Khẩn cấp']
    };
  }

  // ── STEP 3: Urgency ───────────────────────────────────────────────────────
  if (step === 'ask_urgency') {
    const lower = (text || '').toLowerCase();
    if (lower.includes('khẩn') || lower.includes('🔴')) data.urgency = 'Khẩn cấp';
    else if (lower.includes('thấp') || lower.includes('🟢')) data.urgency = 'Thấp';
    else data.urgency = 'Trung bình';

    // Skip photo step if we already have images
    if (data.images && data.images.length > 0) {
      session.step = 'ask_email';
      persistSessions();
      return { messages: [`Đã nhận ${data.images.length} ảnh 👍\n\nEmail công ty của bạn là gì?`] };
    }

    session.step = 'ask_photo';
    persistSessions();
    return {
      messages: ['Bạn có ảnh chụp màn hình hoặc tài liệu hỗ trợ không? (có thể đính kèm nhiều ảnh)'],
      quickReplies: ['⏭️ Bỏ qua'],
      showUpload: true
    };
  }

  // ── STEP 4: Photo (optional) ──────────────────────────────────────────────
  if (step === 'ask_photo') {
    // Images are already captured at the top of processMessage
    // Whether they uploaded or skipped, proceed
    session.step = 'ask_email';
    persistSessions();
    const imgNote = data.images && data.images.length > 0
      ? `Đã nhận ${data.images.length} ảnh 👍\n\n`
      : '';
    return { messages: [`${imgNote}Email công ty của bạn là gì?`] };
  }

  // ── STEP 5: Email ─────────────────────────────────────────────────────────
  if (step === 'ask_email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!text || !emailRegex.test(text.trim())) {
      return { messages: ['Vui lòng nhập địa chỉ email hợp lệ (ví dụ: ten.ban@rize.farm).'] };
    }
    data.email = text.trim().toLowerCase();
    session.step = 'confirm';
    persistSessions();
    return {
      messages: [buildSummary(data)],
      quickReplies: ['✅ Gửi báo cáo', '🔄 Bắt đầu lại'],
      isConfirm: true
    };
  }

  // ── STEP 6: Confirm & Submit ──────────────────────────────────────────────
  if (step === 'confirm') {
    const upper = (text || '').toUpperCase().trim();

    if (upper.includes('GỬI') || upper.includes('GUI') || upper.includes('✅')) {
      const reportId = generateReportId();
      await postToSlack({ ...data, reportId });
      saveReport(reportId, {
        type: 'report',
        email: data.email,
        account: data.account,
        issue: data.issue,
        details: data.details,
        urgency: data.urgency,
        imageCount: (data.images || []).length,
        status: 'Đang xử lý',
        createdAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
      });
      delete sessions[sessionId];
      persistSessions();
      return {
        messages: [
          `✅ *Báo cáo đã được gửi thành công!*\n\nMã báo cáo của bạn:\n*${reportId}*\n\nTeam đã được thông báo. Lưu mã này để kiểm tra trạng thái sau.\n\n_Nhập BẮT ĐẦU LẠI để gửi báo cáo mới._`
        ],
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

function buildSummary(data) {
  const urgencyEmoji = data.urgency === 'Khẩn cấp' ? '🔴' : data.urgency === 'Trung bình' ? '🟡' : '🟢';
  const photoNote = data.images && data.images.length > 0
    ? `📎 ${data.images.length} ảnh đính kèm`
    : 'Không có ảnh';

  return `*Xác nhận báo cáo của bạn:*\n\n📧 Email: ${data.email || '—'}\n🏢 Tài khoản/PG: ${data.account}\n${urgencyEmoji} Khẩn cấp: ${data.urgency}\n🖼️ Ảnh: ${photoNote}\n\n📝 *Mô tả:*\n${data.details}\n\n_Nhấn Gửi để gửi hoặc Bắt đầu lại để làm lại._`;
}

function generateReportId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
  return `${date}-RPT-${suffix}`;
}

module.exports = { processMessage, greetMessage };
