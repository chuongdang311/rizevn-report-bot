const fetch = require('node-fetch');

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

async function postToSlack(report) {
  if (!SLACK_URL) {
    console.error('SLACK_WEBHOOK_URL not set');
    return;
  }

  const emoji = report.type === 'bug' ? '🐛' : '📋';
  const typeLabel = report.type === 'bug' ? 'Bug Report' : 'Admin Request';
  const urgencyEmoji = report.urgency === 'Khẩn cấp' ? '🔴' : report.urgency === 'Trung bình' ? '🟡' : '🟢';
  const imageNote = report.hasImage || report.imageData ? '\n📎 _Có ảnh đính kèm — xem trong báo cáo gốc_' : '';

  const text = `${emoji} *${typeLabel} — ${report.reportId}*

👤 *Người báo cáo:* ${report.name}
🏢 *Tài khoản/PG:* ${report.account}
${urgencyEmoji} *Khẩn cấp:* ${report.urgency}
🕐 *Thời gian:* ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}

📝 *Mô tả:*
${report.details}${imageNote}

_Mã báo cáo: ${report.reportId}_`;

  // Post the text report
  const response = await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    console.error('Slack webhook error:', response.status, await response.text());
  }

  // If there's an image, post it as a second message with the image URL
  // (Slack incoming webhooks don't support file uploads directly)
  // Image is stored on the server and referenced by report ID
  if (report.imageData && SLACK_URL) {
    const imageUrl = `${process.env.SERVER_URL || ''}/image/${report.reportId}`;
    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `📎 *Ảnh đính kèm cho ${report.reportId}:* ${imageUrl}`
      })
    }).catch(e => console.error('Failed to post image link:', e));
  }
}

module.exports = { postToSlack };
