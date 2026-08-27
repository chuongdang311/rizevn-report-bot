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

module.exports = { saveReport, getReport, updateStatus, updateReport, getAllReports };
