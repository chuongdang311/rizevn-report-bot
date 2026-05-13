const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

async function postToSlack(report) {
  if (!SLACK_URL) {
    console.error('SLACK_WEBHOOK_URL not set');
    return;
  }

  const urgencyEmoji = report.urgency === 'Khẩn cấp' ? '🔴' : report.urgency === 'Trung bình' ? '🟡' : '🟢';
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const imageCount = (report.images || []).length;
  const imageNote = imageCount > 0 ? `📎 _${imageCount} ảnh đính kèm_` : '';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📋 Báo cáo — ${report.reportId}`,
        emoji: true
      }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*📧 Người báo cáo:*\n${report.email}` },
        { type: 'mrkdwn', text: `*🏢 Tài khoản / PG:*\n${report.account}` },
        { type: 'mrkdwn', text: `*${urgencyEmoji} Khẩn cấp:*\n${report.urgency}` },
        { type: 'mrkdwn', text: `*🕐 Thời gian:*\n${timestamp}` }
      ]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📝 Mô tả vấn đề:*\n${report.details}`
      }
    }
  ];

  // Add image note if present
  if (imageNote) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: imageNote }]
    });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Mã báo cáo: \`${report.reportId}\` • Rize Vietnam Bug Reporting Tool`
    }]
  });

  const payload = { blocks };

  const response = await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Slack webhook error:', response.status, errText);
    // Fallback: plain text post
    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `📋 *Báo cáo — ${report.reportId}*\n📧 ${report.email}\n🏢 ${report.account}\n${urgencyEmoji} ${report.urgency}\n📝 ${report.details}\n🕐 ${timestamp}`
      })
    });
  }

  // Save images to disk and post URLs as follow-up messages
  if (report.images && report.images.length > 0) {
    const imagesDir = path.join(__dirname, 'images');
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

    report.images.forEach((imgData, i) => {
      try {
        const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
        const ext = imgData.startsWith('data:image/png') ? 'png' : 'jpg';
        const filename = `${report.reportId}-${i + 1}.${ext}`;
        fs.writeFileSync(path.join(imagesDir, filename), base64, 'base64');
      } catch (e) {
        console.error(`Failed to save image ${i}:`, e.message);
      }
    });
  }
}

module.exports = { postToSlack };
