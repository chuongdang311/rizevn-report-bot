const { postToSlack } = require('./slack');
const { saveReport, getReport } = require('./store');

const sessions = {};

// Report ID pattern for status checks
const REPORT_ID_PATTERN = /^\d{8}-(BUG|ADM)-\d{3}$/;

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { step: 'describe', data: {} };
  }
  return sessions[sessionId];
}

function greetMessage() {
  return `Xin chào! 👋 Tôi là bot báo cáo của Rize Vietnam.\n\nHãy mô tả vấn đề bạn gặp phải hoặc yêu cầu admin của bạn. Viết tự do bằng tiếng Việt hoặc tiếng Anh nhé!\n\n_(Hoặc nhập mã báo cáo để kiểm tra trạng thái)_`;
}

async function processMessage(sessionId, text, imageData) {
  const session = getSession(sessionId);

  // Handle explicit restart
  if (text && (text.toUpperCase().includes('BẮT ĐẦU LẠI') || text.toUpperCase() === 'RESTART')) {
    sessions[sessionId] = { step: 'describe', data: {} };
    return { messages: [greetMessage()] };
  }

  // Handle status check — user types a report ID like 20260513-BUG-042
  if (text && REPORT_ID_PATTERN.test(text.trim())) {
    const report = getReport(text.trim());
    if (report) {
      const emoji = report.status === 'Đã xử lý' ? '✅' : report.status === 'Cần thêm thông tin' ? '⚠️' : '🔄';
      return {
        messages: [
          `${emoji} *Báo cáo ${text.trim()}*\n\nVấn đề: ${report.issue}\nTrạng thái: *${report.status}*\nGửi lúc: ${report.createdAt}\n\n_Nhập BẮT ĐẦU LẠI để gửi báo cáo mới._`
        ]
      };
    } else {
      return { messages: [`Không tìm thấy báo cáo với mã *${text.trim()}*. Vui lòng kiểm tra lại.`] };
    }
  }

  return await handleStep(session, sessionId, text, imageData);
}

async function handleStep(session, sessionId, text, imageData) {
  const { step, data } = session;

  // ── STEP 1: Free-form description ──────────────────────────────────────────
  if (step === 'describe') {
    if (!text || text.trim().length < 5) {
      return { messages: [greetMessage()] };
    }

    data.details = text.trim();

    // Auto-detect report type from keywords
    const lower = text.toLowerCase();
    const bugKeywords = ['bug', 'lỗi', 'error', 'crash', 'không hoạt động', 'bị lỗi', 'sai', 'không chạy', 'không load', 'treo', 'broken', 'không vào được', 'không mở được'];
    const adminKeywords = ['admin', 'yêu cầu', 'đổi', 'thay đổi', 'cập nhật', 'sửa thông tin', 'nhập sai', 'xóa', 'thêm', 'request', 'chỉnh sửa', 'điều chỉnh'];

    const bugScore = bugKeywords.filter(k => lower.includes(k)).length;
    const adminScore = adminKeywords.filter(k => lower.includes(k)).length;

    if (bugScore > adminScore && bugScore > 0) data.type = 'bug';
    else if (adminScore > bugScore && adminScore > 0) data.type = 'admin';

    // Auto-detect urgency
    const highUrgency = ['khẩn', 'urgent', 'gấp', 'critical', 'nghiêm trọng', 'ngay lập tức', 'quan trọng'];
    const lowUrgency = ['thấp', 'low', 'không gấp', 'từ từ', 'bình thường', 'nhỏ'];
    if (highUrgency.some(k => lower.includes(k))) data.urgency = 'Khẩn cấp';
    else if (lowUrgency.some(k => lower.includes(k))) data.urgency = 'Thấp';

    // Use first sentence as the issue title
    data.issue = text.split(/[.!?\n]/)[0].trim().substring(0, 120);

    // Decide next step based on what we detected
    if (!data.type) {
      session.step = 'ask_type';
      return {
        messages: ['Cảm ơn bạn đã mô tả! Đây là loại báo cáo nào?'],
        quickReplies: ['🐛 Bug Report', '📋 Admin Request']
      };
    }

    session.step = 'ask_name';
    return {
      messages: [`Cảm ơn! Tôi đã hiểu vấn đề.\n\nBạn cho tôi biết *tên đầy đủ* của bạn nhé?`]
    };
  }

  // ── STEP 2: Clarify report type ────────────────────────────────────────────
  if (step === 'ask_type') {
    if (text.toLowerCase().includes('bug') || text.includes('🐛')) data.type = 'bug';
    else data.type = 'admin';
    session.step = 'ask_name';
    return { messages: ['Bạn cho tôi biết *tên đầy đủ* của bạn nhé?'] };
  }

  // ── STEP 3: Name ───────────────────────────────────────────────────────────
  if (step === 'ask_name') {
    if (!text || text.trim().length < 2) {
      return { messages: ['Vui lòng nhập tên đầy đủ của bạn.'] };
    }
    data.name = text.trim();
    session.step = 'ask_account';
    return { messages: [`Cảm ơn ${data.name}! Tài khoản PG hoặc tên nông dân liên quan là gì?`] };
  }

  // ── STEP 4: Account / PG ──────────────────────────────────────────────────
  if (step === 'ask_account') {
    if (!text || text.trim().length < 2) {
      return { messages: ['Vui lòng nhập tài khoản PG hoặc tên nông dân liên quan.'] };
    }
    data.account = text.trim();

    if (data.urgency) {
      // Already detected urgency, skip to photo
      session.step = 'ask_photo';
      return {
        messages: [`Mức độ khẩn cấp tôi hiểu là *${data.urgency}*. Bạn có ảnh chụp màn hình hoặc hình ảnh liên quan không?`],
        quickReplies: ['⏭️ Bỏ qua'],
        showUpload: true
      };
    }

    session.step = 'ask_urgency';
    return {
      messages: ['Mức độ khẩn cấp của vấn đề này?'],
      quickReplies: ['🟢 Thấp', '🟡 Trung bình', '🔴 Khẩn cấp']
    };
  }

  // ── STEP 5: Urgency ───────────────────────────────────────────────────────
  if (step === 'ask_urgency') {
    const lower = (text || '').toLowerCase();
    if (lower.includes('khẩn') || lower.includes('🔴') || lower.includes('high')) data.urgency = 'Khẩn cấp';
    else if (lower.includes('thấp') || lower.includes('🟢') || lower.includes('low')) data.urgency = 'Thấp';
    else data.urgency = 'Trung bình';

    session.step = 'ask_photo';
    return {
      messages: ['Bạn có ảnh chụp màn hình hoặc hình ảnh liên quan không?'],
      quickReplies: ['⏭️ Bỏ qua'],
      showUpload: true
    };
  }

  // ── STEP 6: Photo (optional) ──────────────────────────────────────────────
  if (step === 'ask_photo') {
    if (imageData) {
      data.imageData = imageData;
      data.hasImage = true;
    }
    session.step = 'confirm';
    return {
      messages: [buildSummary(data)],
      quickReplies: ['✅ Gửi báo cáo', '🔄 Bắt đầu lại'],
      isConfirm: true
    };
  }

  // ── STEP 7: Confirm & Submit ──────────────────────────────────────────────
  if (step === 'confirm') {
    const upper = (text || '').toUpperCase();
    if (upper.includes('GỬI') || upper.includes('GUI') || upper.includes('✅')) {
      await sendMessage(session, sessionId, data);
      return null; // Handled inside sendMessage with a return
    }
    // Restart
    sessions[sessionId] = { step: 'describe', data: {} };
    return { messages: [greetMessage()] };
  }

  return { messages: [greetMessage()] };
}

async function sendMessage(session, sessionId, data) {
  // This is called from the confirm step — we return the result from processMessage
  const reportId = generateReportId(data.type);
  await postToSlack({ ...data, reportId });
  saveReport(reportId, {
    type: data.type,
    name: data.name,
    account: data.account,
    issue: data.issue,
    details: data.details,
    urgency: data.urgency,
    hasImage: !!data.imageData,
    status: 'Đang xử lý',
    createdAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
  });
  delete sessions[sessionId];
  return reportId;
}

function buildSummary(data) {
  const typeLabel = data.type === 'bug' ? '🐛 Bug Report' : '📋 Admin Request';
  const photoNote = data.hasImage || data.imageData ? '📎 Có ảnh đính kèm' : 'Không có ảnh';
  return `*Xác nhận báo cáo của bạn:*\n\n📌 Loại: ${typeLabel}\n👤 Tên: ${data.name}\n🏢 Tài khoản: ${data.account}\n⚡ Khẩn cấp: ${data.urgency}\n🖼️ Ảnh: ${photoNote}\n\n📝 *Mô tả:*\n${data.details}\n\n_Nhấn Gửi để gửi hoặc Bắt đầu lại để làm lại._`;
}

function generateReportId(type) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
  return `${date}-${type === 'bug' ? 'BUG' : 'ADM'}-${suffix}`;
}

module.exports = { processMessage, greetMessage, sendMessage };
