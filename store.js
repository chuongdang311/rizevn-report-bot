const fs = require('fs');
const path = require('path');

// Use DATA_DIR env var when available (Fly.io persistent volume mounted at /data)
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, 'reports.json');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

let reports = {};
try {
  if (fs.existsSync(STORE_FILE)) {
    reports = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('Could not load reports.json:', e.message);
  reports = {};
}

function persist() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(reports, null, 2)); } catch (e) {
    console.error('Failed to persist reports:', e.message);
  }
}

function saveReport(reportId, data) {
  reports[reportId] = { ...data, reportId };
  persist();
}

function getReport(reportId) {
  return reports[reportId] || null;
}

function updateStatus(reportId, status) {
  if (!reports[reportId]) return false;
  reports[reportId].status = status;
  reports[reportId].updatedAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  persist();
  return true;
}

// Merge arbitrary fields into an existing report (used by admin resend)
function updateReport(reportId, patch) {
  if (!reports[reportId]) return false;
  reports[reportId] = { ...reports[reportId], ...patch };
  persist();
  return true;
}

function getAllReports() {
  return Object.values(reports).sort((a, b) =>
    (b.reportId || '').localeCompare(a.reportId || '')
  );
}

// ── Image persistence (so a failed/resent report can still include its
//    attachments — base64 is written to disk instead of into reports.json,
//    which stays small and diffable) ───────────────────────────────────────
function mimeToExt(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  const extMap = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/mpeg': 'mpg'
  };
  return extMap[match ? match[1] : ''] || 'bin';
}

function saveReportImages(reportId, images) {
  if (!images || images.length === 0) return [];
  const dir = path.join(IMAGES_DIR, reportId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  const filenames = [];
  images.forEach((dataUrl, i) => {
    try {
      const ext = mimeToExt(dataUrl);
      const filename = `${i + 1}.${ext}`;
      // Store the full data URL as-is (simplest to round-trip for Slack upload)
      fs.writeFileSync(path.join(dir, filename), dataUrl, 'utf8');
      filenames.push(filename);
    } catch (e) {
      console.error(`Failed to persist image ${i + 1} for ${reportId}:`, e.message);
    }
  });
  return filenames;
}

function getReportImages(reportId) {
  const dir = path.join(IMAGES_DIR, reportId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .sort()
      .map(filename => fs.readFileSync(path.join(dir, filename), 'utf8'));
  } catch (e) {
    console.error(`Failed to read persisted images for ${reportId}:`, e.message);
    return [];
  }
}

module.exports = {
  saveReport, getReport, updateStatus, updateReport, getAllReports,
  saveReportImages, getReportImages
};
