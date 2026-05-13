const express = require('express');
const path = require('path');
const { processMessage, greetMessage } = require('./bot');
const { getReport, updateStatus } = require('./store');

const app = express();
app.use(express.json({ limit: '15mb' })); // Allow image uploads
app.use(express.static(path.join(__dirname, 'public')));

// Serve chat UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Main chat endpoint
app.post('/message', async (req, res) => {
  try {
    const { sessionId, text, imageData } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    const result = await processMessage(sessionId, text, imageData);
    res.json(result);
  } catch (err) {
    console.error('Error processing message:', err);
    res.status(500).json({ messages: ['Có lỗi xảy ra. Vui lòng thử lại.'] });
  }
});

// Get report status (used by bot and admin)
app.get('/status/:reportId', (req, res) => {
  const report = getReport(req.params.reportId);
  if (!report) return res.json({ found: false });
  res.json({
    found: true,
    reportId: req.params.reportId,
    status: report.status,
    type: report.type,
    issue: report.issue,
    name: report.name,
    createdAt: report.createdAt
  });
});

// Admin: update report status (password protected)
app.post('/admin/status', (req, res) => {
  const { adminKey, reportId, status } = req.body;
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  const validStatuses = ['Đang xử lý', 'Đã xử lý', 'Cần thêm thông tin', 'Không tái hiện được'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  const updated = updateStatus(reportId, status);
  if (!updated) return res.status(404).json({ error: 'Report not found' });
  res.json({ success: true });
});

// Admin: list all reports
app.get('/admin/reports', (req, res) => {
  const { adminKey } = req.query;
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  const { getAllReports } = require('./store');
  res.json(getAllReports());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rize Report Bot running on port ${PORT}`));
