const express = require('express');
const path = require('path');
const { processMessage, greetMessage } = require('./bot');
const { getReport, updateStatus, updateReport, getReportImages } = require('./store');
const { postToSlack, getLastSlackError } = require('./slack');

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
    const { sessionId, text, images } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    const result = await processMessage(sessionId, text, images || []);
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

// Admin: re-send a report to Slack (for reports where the original post failed)
app.post('/admin/resend', async (req, res) => {
  const { adminKey, reportId } = req.body;
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, error: 'Invalid admin key' });
  }

  const report = getReport(reportId);
  if (!report) {
    return res.status(404).json({ success: false, error: 'Report not found' });
  }

  // Pre-flight config check so the admin gets a precise reason, not a generic failure
  if (!process.env.SLACK_BOT_TOKEN) {
    return res.json({ success: false, error: 'SLACK_BOT_TOKEN is not set on the server' });
  }
  if (!process.env.SLACK_CHANNEL_ID) {
    return res.json({ success: false, error: 'SLACK_CHANNEL_ID is not set on the server' });
  }

  try {
    // Re-attach any images that were persisted at submission time
    const images = getReportImages(reportId);
    const result = await postToSlack({ ...report, images });

    if (!result) {
      return res.json({
        success: false,
        error:   getLastSlackError() || 'Slack rejected the message. Run `fly logs` for details.'
      });
    }

    updateReport(reportId, {
      status:       'Đang xử lý',
      slackTs:      result.ts,
      slackChannel: result.channel,
      resentAt:     new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    });

    res.json({ success: true, imageCount: images.length });
  } catch (err) {
    console.error('[admin] resend failed:', err);
    res.json({ success: false, error: err.message || 'Unknown error' });
  }
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
