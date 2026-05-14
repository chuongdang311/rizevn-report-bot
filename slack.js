/**
 * Slack integration — Bot API (chat.postMessage + files API)
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN   — xoxb-... token
 *   SLACK_CHANNEL_ID  — e.g. C085L46D50A
 *
 * Required Slack bot scopes:
 *   chat:write, reactions:write, reactions:read, files:write
 *
 * Optional:
 *   ANTHROPIC_API_KEY — enables Claude elaboration (heading + detailed description)
 */

const fetch = require('node-fetch');

const SLACK_API = 'https://slack.com/api';

function slackHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
  };
}

// ── Upload images to Slack thread ─────────────────────────────────────────
async function uploadImagesToThread(channel, threadTs, images, reportId) {
  if (!images || images.length === 0 || !process.env.SLACK_BOT_TOKEN) return;

  for (let i = 0; i < images.length; i++) {
    try {
      const imgData = images[i];
      const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
      const ext = imgData.startsWith('data:image/png') ? 'png' : 'jpg';
      const buffer = Buffer.from(base64, 'base64');

      // Step 1: Request an upload URL from Slack
      const urlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
        method: 'POST',
        headers: slackHeaders(),
        body: JSON.stringify({
          filename: `${reportId}-screenshot-${i + 1}.${ext}`,
          length: buffer.length,
          alt_txt: `Screenshot ${i + 1}`
        })
      });
      const urlData = await urlRes.json();

      if (!urlData.ok) {
        console.error(`Upload URL error (image ${i + 1}):`, urlData.error);
        continue;
      }

      // Step 2: Upload the binary to Slack's storage
      await fetch(urlData.upload_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer
      });

      // Step 3: Complete the upload and post into the thread
      const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
        method: 'POST',
        headers: slackHeaders(),
        body: JSON.stringify({
          files: [{ id: urlData.file_id, title: `Screenshot ${i + 1} — ${reportId}` }],
          channel_id: channel,
          thread_ts: threadTs
        })
      });
      const completeData = await completeRes.json();
      if (!completeData.ok) {
        console.error(`Complete upload error (image ${i + 1}):`, completeData.error);
      }
    } catch (e) {
      console.error(`Image ${i + 1} upload failed:`, e.message);
    }
  }
}

// ── Post report to Slack ──────────────────────────────────────────────────
async function postToSlack(report) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID');
    return null;
  }

  // Elaborate report with Claude: polished English heading + detailed description
  let elaborated = {
    heading:     report.summary || 'Issue reported',
    description: report.details || '',
    account:     report.account || '',
    steps:       report.steps   || ''
  };
  try {
    const { elaborateReport } = require('./claude');
    elaborated = await elaborateReport(report);
  } catch (e) {
    // Elaboration is optional — continue with originals
  }

  const urgencyLabel = report.urgency === 'High' ? '🔴  High'
    : report.urgency === 'Low' ? '🟢  Low' : '🟡  Medium';

  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  const imageCount = (report.images || []).length;

  const stepsBlock = elaborated.steps && elaborated.steps.trim() && elaborated.steps !== 'Not provided'
    ? `\n\n*STEPS TO REPRODUCE*\n${elaborated.steps.trim()}`
    : '';

  const imageNote = imageCount > 0
    ? `\n\n_${imageCount} screenshot${imageCount > 1 ? 's' : ''} attached in thread_`
    : '';

  const text = `*[${report.category}] ${elaborated.heading}*

*Reporter:*      ${report.email}
*PG / Farmer:*   ${elaborated.account}
*Platform:*      ${report.platform || 'N/A'}
*Urgency:*       ${urgencyLabel}
*Submitted:*     ${timestamp} (GMT+7)

${'─'.repeat(44)}

*DESCRIPTION*
${elaborated.description}${stepsBlock}${imageNote}

${'─'.repeat(44)}
Report ID: \`${report.reportId}\`
_React with ✅ when resolved_`;

  let response, result;
  try {
    response = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: slackHeaders(),
      body: JSON.stringify({ channel, text, unfurl_links: false })
    });
    result = await response.json();
  } catch (e) {
    console.error('Slack post failed:', e.message);
    return null;
  }

  if (!result.ok) {
    console.error('Slack API error:', result.error);
    return null;
  }

  const ts = result.ts;
  const postedChannel = result.channel;

  // Add ⏳ reaction to indicate "in progress"
  try {
    await fetch(`${SLACK_API}/reactions.add`, {
      method: 'POST',
      headers: slackHeaders(),
      body: JSON.stringify({ channel: postedChannel, timestamp: ts, name: 'hourglass_flowing_sand' })
    });
  } catch (e) {
    console.error('Failed to add reaction:', e.message);
  }

  // Upload screenshots as thread replies
  if (imageCount > 0) {
    await uploadImagesToThread(postedChannel, ts, report.images || [], report.reportId);
  }

  return { ts, channel: postedChannel };
}

// ── Read status from Slack reactions ─────────────────────────────────────
async function getSlackReactionStatus(ts, channel) {
  if (!ts || !channel || !process.env.SLACK_BOT_TOKEN) return null;

  try {
    const res = await fetch(
      `${SLACK_API}/reactions.get?channel=${channel}&timestamp=${ts}&full=true`,
      { headers: slackHeaders() }
    );
    const data = await res.json();
    if (!data.ok || !data.message) return null;

    const reactionNames = (data.message.reactions || []).map(r => r.name);

    if (reactionNames.includes('white_check_mark')) return 'Fixed';
    if (reactionNames.includes('hourglass_flowing_sand')) return 'In Progress';
    return 'Pending';
  } catch (e) {
    console.error('Failed to get Slack reactions:', e.message);
    return null;
  }
}

module.exports = { postToSlack, getSlackReactionStatus };
