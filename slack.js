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

// Records why the most recent postToSlack() failed, so callers can show a
// precise reason instead of a generic "failed" message.
let lastSlackError = null;
function getLastSlackError() { return lastSlackError; }

function slackHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
  };
}

// ── Media type detection ──────────────────────────────────────────────────
function getMediaInfo(dataUrl) {
  const match   = dataUrl.match(/^data:([^;]+);base64,/);
  const mime    = match ? match[1] : 'image/jpeg';
  const extMap  = {
    'image/png':       'png',
    'image/jpeg':      'jpg',
    'image/gif':       'gif',
    'image/webp':      'webp',
    'video/mp4':       'mp4',
    'video/quicktime': 'mov',
    'video/webm':      'webm',
    'video/mpeg':      'mpg'
  };
  return {
    mimeType: mime,
    ext:      extMap[mime] || 'bin',
    isVideo:  mime.startsWith('video/')
  };
}

// ── Upload images + videos to Slack thread ────────────────────────────────
async function uploadMediaToThread(channel, threadTs, images, reportId) {
  if (!images || images.length === 0 || !process.env.SLACK_BOT_TOKEN) return;

  console.log(`[media] Uploading ${images.length} file(s) to thread ${threadTs}`);

  for (let i = 0; i < images.length; i++) {
    try {
      const imgData = images[i];
      const { mimeType, ext, isVideo } = getMediaInfo(imgData);
      const base64 = imgData.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      const kind   = isVideo ? 'video' : 'image';
      console.log(`[media] File ${i + 1}: ${kind}/${ext}, ${buffer.length} bytes`);

      // Step 1: Request an upload URL from Slack
      // NOTE: files.getUploadURLExternal requires form-encoded body, NOT JSON
      const uploadParams = new URLSearchParams({
        filename: `${reportId}-attachment-${i + 1}.${ext}`,
        length:   String(buffer.length),
        alt_txt:  `Attachment ${i + 1}`
      });
      const urlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
        },
        body: uploadParams.toString()
      });
      const urlData = await urlRes.json();
      console.log(`[media] getUploadURL response:`, JSON.stringify(urlData));

      if (!urlData.ok) {
        if (urlData.error === 'missing_scope') {
          console.error('[media] ERROR: Bot token missing "files:write" scope — go to api.slack.com/apps → OAuth & Permissions → add files:write → Reinstall to Workspace, then update SLACK_BOT_TOKEN in Render.');
        } else {
          console.error(`[media] Upload URL error (file ${i + 1}):`, urlData.error);
        }
        continue;
      }

      // Step 2: Upload binary to Slack's presigned URL (no auth header)
      const uploadRes = await fetch(urlData.upload_url, {
        method:  'POST',
        headers: { 'Content-Type': mimeType },
        body:    buffer
      });
      console.log(`[media] Upload step status: ${uploadRes.status}`);

      // Step 3: Complete and share into the thread
      const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
        method: 'POST',
        headers: slackHeaders(),
        body: JSON.stringify({
          files:      [{ id: urlData.file_id, title: `Attachment ${i + 1} — ${reportId}` }],
          channel_id: channel,
          thread_ts:  threadTs
        })
      });
      const completeData = await completeRes.json();
      console.log(`[media] completeUpload response:`, JSON.stringify(completeData));

      if (!completeData.ok) {
        console.error(`[media] Complete upload error (file ${i + 1}):`, completeData.error);
      } else {
        console.log(`[media] File ${i + 1} (${kind}) uploaded successfully`);
      }
    } catch (e) {
      console.error(`[media] File ${i + 1} upload exception:`, e.message);
    }
  }
}

// ── Post report to Slack ──────────────────────────────────────────────────
async function postToSlack(report) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  lastSlackError = null;

  if (!token || !channel) {
    lastSlackError = !token
      ? 'SLACK_BOT_TOKEN is not set on the server'
      : 'SLACK_CHANNEL_ID is not set on the server';
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
    ? `\n\n_${imageCount} attachment${imageCount > 1 ? 's' : ''} (screenshots/video) in thread_`
    : '';

  const versionLine = report.appVersion ? `\n*App Version:*   ${report.appVersion}` : '';

  const text = `*[${report.category}] ${elaborated.heading}*

*Reporter:*      ${report.email}
*PG / Farmer:*   ${elaborated.account}
*Platform:*      ${report.platform || 'N/A'}${versionLine}
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
    lastSlackError = `Network error contacting Slack: ${e.message}`;
    console.error('Slack post failed:', e.message);
    return null;
  }

  if (!result.ok) {
    const hints = {
      invalid_auth:      'SLACK_BOT_TOKEN is invalid or revoked — regenerate it in Slack and run: fly secrets set SLACK_BOT_TOKEN=xoxb-...',
      not_authed:        'No SLACK_BOT_TOKEN was sent with the request.',
      account_inactive:  'The Slack bot user has been deactivated.',
      channel_not_found: 'SLACK_CHANNEL_ID is wrong, or the bot cannot see that channel.',
      not_in_channel:    'The bot is not a member of the channel — invite it with /invite @YourBot',
      is_archived:       'The target Slack channel is archived.',
      missing_scope:     'The bot token is missing a required scope (chat:write, files:write). Reinstall the app.',
      ratelimited:       'Slack rate-limited the request. Wait a moment and try again.'
    };
    lastSlackError = `Slack API error: ${result.error}` +
      (hints[result.error] ? ` — ${hints[result.error]}` : '');
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

  // Upload screenshots / videos as thread replies
  if (imageCount > 0) {
    await uploadMediaToThread(postedChannel, ts, report.images || [], report.reportId);
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

module.exports = { postToSlack, getSlackReactionStatus, getLastSlackError };
