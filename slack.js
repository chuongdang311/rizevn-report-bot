/**
 * Slack integration using the Bot API (chat.postMessage).
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN   — xoxb-... token from your Slack app
 *   SLACK_CHANNEL_ID  — e.g. C085L46D50A  (the #production-bug channel ID)
 *
 * Optional:
 *   ANTHROPIC_API_KEY — enables Vietnamese → English translation before posting
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SLACK_API = 'https://slack.com/api';

function slackHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
  };
}

// ── Post report to Slack ──────────────────────────────────────────────────
async function postToSlack(report) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID');
    return null;
  }

  // Translate report to English if Claude API is available
  let r = { ...report };
  try {
    const { translateReport } = require('./claude');
    r = await translateReport(r);
  } catch (e) {
    // Translation is optional — continue with original
  }

  const urgencyLabel = r.urgency === 'High' ? '🔴  High' : r.urgency === 'Low' ? '🟢  Low' : '🟡  Medium';
  const timestamp = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const imageCount = (report.images || []).length;

  // Build the heading line
  const heading = `[${r.category}] ${r.summary}`;

  // Steps block (only if provided)
  const stepsBlock = r.steps && r.steps.trim()
    ? `\n\n*STEPS TO REPRODUCE*\n${r.steps.trim()}`
    : '';

  const imageBlock = imageCount > 0
    ? `\n\n_${imageCount} image${imageCount > 1 ? 's' : ''} attached_`
    : '';

  const text = `*${heading}*

*Reporter:*      ${r.email}
*PG / Farmer:*   ${r.account}
*Platform:*      ${r.platform || 'N/A'}
*Urgency:*       ${urgencyLabel}
*Submitted:*     ${timestamp} (GMT+7)

${'─'.repeat(44)}

*DESCRIPTION*
${r.details}${stepsBlock}${imageBlock}

${'─'.repeat(44)}
Report ID: \`${r.reportId}\`
_React with ✅ when resolved_`;

  const body = { channel, text, unfurl_links: false };

  let response, result;
  try {
    response = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: slackHeaders(),
      body: JSON.stringify(body)
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
      body: JSON.stringify({
        channel: postedChannel,
        timestamp: ts,
        name: 'hourglass_flowing_sand'
      })
    });
  } catch (e) {
    console.error('Failed to add reaction:', e.message);
  }

  // Save images to disk
  if (imageCount > 0) {
    const imagesDir = path.join(__dirname, 'images');
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    (report.images || []).forEach((imgData, i) => {
      try {
        const base64 = imgData.replace(/^data:image\/\w+;base64,/, '');
        const ext = imgData.startsWith('data:image/png') ? 'png' : 'jpg';
        fs.writeFileSync(path.join(imagesDir, `${r.reportId}-${i + 1}.${ext}`), base64, 'base64');
      } catch (e) {
        console.error(`Image save error ${i}:`, e.message);
      }
    });
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
