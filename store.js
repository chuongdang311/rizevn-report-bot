const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'reports.json');
const IMAGES_DIR = path.join(__dirname, 'images');

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// Load existing reports from disk
let reports = {};
try {
  if (fs.existsSync(STORE_FILE)) {
    reports = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('Could not load reports.json, starting fresh:', e.message);
  reports = {};
}

function persist() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(reports, null, 2));
  } catch (e) {
    console.error('Failed to persist reports:', e.message);
  }
}

function saveReport(reportId, data) {
  // Save image separately if present (keep reports.json lean)
  if (data.imageData) {
    try {
      const base64Data = data.imageData.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(IMAGES_DIR, `${reportId}.png`), base64Data, 'base64');
    } catch (e) {
      console.error('Failed to save image:', e.message);
    }
    delete data.imageData; // Don't store base64 in JSON
  }
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

function getAllReports() {
  return Object.values(reports).sort((a, b) =>
    (b.reportId || '').localeCompare(a.reportId || '')
  );
}

function getImagePath(reportId) {
  const imgPath = path.join(IMAGES_DIR, `${reportId}.png`);
  return fs.existsSync(imgPath) ? imgPath : null;
}

module.exports = { saveReport, getReport, updateStatus, getAllReports, getImagePath };
