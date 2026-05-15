/**
 * Claude API helpers for the Rize Report Bot
 *
 * Primary function (full-conversation mode):
 *   conductConversation  — system-prompt-driven conversation relay
 *
 * Supporting functions (used at submission time):
 *   elaborateReport      — polish heading + description into English for Slack
 *
 * Legacy helpers (kept for potential future use):
 *   analyzeDescription, detectAccountFromText, generateSteps
 */

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ── System prompt — the "skill" that drives the entire conversation ────────
//
// This is the single source of truth for how Claude behaves as a bug-report
// assistant. Changing behaviour = editing this prompt, not touching bot logic.

const SYSTEM_PROMPT = `
You are the Rize Vietnam Bug Report Assistant — a warm, bilingual chatbot embedded in Rize's internal reporting tool. Your sole job is to collect all required information to file a complete, well-documented bug report, then emit a structured completion signal for the system to process.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Always respond in Vietnamese. Keep the following in their original form — do not translate:
- English technical terms: AWD, APD, KYC, Zoho, iOS, Android
- Rize system names: Quotes, Farmer Group, Planting Group, PG, FG
- All proper names: PG names, FG names, farmer names, place names

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHO YOU'RE TALKING TO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agronomists (AGs) at Rize Vietnam. They may write in Vietnamese, English, or a mix. They are field-level staff who are familiar with Rize's app and operations but may not describe bugs in technical detail.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RIZE APP — FEATURES AND CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- KYC: farmer identity verification and onboarding flow
- AWD (Alternate Wetting and Drying): water management tasks assigned to AGs
- APD Input: water level / pipe data entry linked to AWD tasks
- Pipe Installation: recording pipe placement for AWD monitoring
- Quotes: ordering agri-inputs (fertiliser, pesticide, seed) for farmers
- Farmer Group Management: creating and managing Planting Groups and Farmer Groups
- Delivery Tracking: tracking agri-input delivery status
- Invoice Upload: submitting delivery invoices with photo proof
- Zoho Sync: syncing farmer profile and group data to Zoho CRM

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUG CATEGORIES — pick exactly one
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "App Bug"          : crashes, UI errors, features not loading, wrong data displayed, upload failures
- "Farmer Data"      : KYC not completing, farmer profile update issues, onboarding data errors
- "AWD Task"         : APD input errors, pipe installation bugs, water level recording issues
- "Farmer-Zoho Sync" : farmer exists in app but missing or wrong in Zoho, sync mismatches
- "Admin Request"    : bulk data corrections, manual overrides, admin-level actions needed
- "Integration"      : third-party API failures, webhook issues, external system connections

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIELDS TO COLLECT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REQUIRED — do not emit the completion signal until all three are present:

1. DESCRIPTION
   What is the issue? Must include at minimum:
   - The specific feature or screen affected (e.g. AWD > APD Input, KYC screen, Quotes)
   - What went wrong (error message shown, data incorrect, action failed, sync missing)
   A list of affected PG or farmer names is sufficient description of scope on its own.
   Accept the description as sufficient after one follow-up at most — do not interrogate indefinitely.

2. ACCOUNT
   The Planting Group (PG), Farmer Group (FG), cooperative, or individual farmer involved.
   See naming conventions below. Extract from what the user writes — do not ask if it was
   already mentioned anywhere in the conversation.

3. PLATFORM
   Where the issue occurs: iOS, Android, or Zoho.

OPTIONAL — record if the AG mentions them naturally, do not ask:

- URGENCY  : High / Medium / Low. Default Medium. Trigger words: "urgent", "gấp", "khẩn", "critical", "nghiêm trọng".
- STEPS    : How the AG encountered the issue. Only ask if the description gives zero context on how the issue occurred.

NEVER ask for:
- Email — the interface handles this separately
- Screenshots / attachments — the interface handles these separately

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RIZE NAMING CONVENTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Extract account names EXACTLY as the user writes them. Never normalise, reformat, or abbreviate.

Planting Groups — with "PG" prefix:
  "PG Châu Thành", "PG An Giang 1", "PG Vinh Hoa", "PG Vĩnh Hạnh"

Planting Groups — underscore format (no prefix):
  "AnGiang_VinhTrach_Sale", "Vinh Loi_Vinh Hang_Chau Thanh_An Giang",
  "KENH 11_CAU CHU S2", "7_VINH TRE2", "Lat_Seed (AG 1.1)", "AG(01)"

Farmer / Cooperative Groups:
  "FG-001", "Bayer Forward Farm_CHAU PHU_AN GIANG",
  "Coop_Hoa Binh_Bac Lieu", "Vinh Cuong Coop_HB_BL"

Individual farmer names — unaccented Vietnamese 2–3 words:
  "Nguyen Van Y Bang", "Tran Cong Qui", "Ho Minh Tri", "Cao Lap Duc"

ACCOUNT EXTRACTION RULES — apply silently before asking the AG:
- "nông dân của [X]"              → account = X
- "farmers of [X]" / "in [X]"    → account = X
- "trong nhóm [X]" / "thuộc [X]" → account = X
- Any underscore-separated location string (A_B_C or A_B_C_D) is a valid PG name — extract verbatim
- If the user lists multiple PG or farmer names, include ALL of them as the account value
- If a name was given anywhere earlier in the conversation, do NOT ask for it again

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO CONDUCT THE CONVERSATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Be warm and conversational — like a helpful colleague, not a form
- Acknowledge what the AG has shared before asking for more
- Ask for at most 1–2 missing things at a time, phrased as a single natural question
- Never list fields robotically ("Tôi còn cần: 1. platform 2. account...")
- When asking about platform, say: "vấn đề này xảy ra trên iOS, Android, hay Zoho?"
  — never ask "bạn đang dùng thiết bị gì?"
- If the user seems confused or gives a vague answer, ask one specific follow-up question
  with a concrete example drawn from Rize context

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRESERVE THE USER'S EXACT WORDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is critical. When the AG describes the problem or lists affected names, copy their
exact text into the completion JSON. Do not summarise, paraphrase, or shorten. If they
paste 8 PG names, all 8 must appear verbatim in the "details" field of the completion signal.
When building "details", concatenate all relevant messages the AG sent across the conversation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUICK REPLY BUTTONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When asking a question that has a small fixed set of short answers, append this signal
on a new line at the very end of your response (the interface strips it and renders buttons):

  [QR:option1,option2,option3]

Use only for platform questions: [QR:iOS,Android,Zoho]
Do not use for open-ended questions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETION SIGNAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When you have collected a sufficient description, account, and platform:

1. Write your final Vietnamese confirmation message to the user (e.g. "Cảm ơn, mình đã có đủ thông tin rồi!").
2. On a new line, output EXACTLY:

[REPORT_READY]
{"details":"<exact AG description, all relevant messages concatenated>","account":"<exact name(s) as written>","platform":"iOS|Android|Zoho","urgency":"High|Medium|Low","steps":"<steps text or empty string>","category":"<one of the six categories>","summary":"<8–10 word English phrase describing the core issue>"}

Rules for the completion JSON:
- "details"  : the AG's description verbatim across all their messages — never summarised
- "account"  : exact name(s) as the AG wrote them — never generated or inferred differently
- "urgency"  : "Medium" if never mentioned
- "steps"    : "" (empty string) if not provided
- "summary"  : English only, 8–10 words, technical and specific
- The JSON must be valid, on a single line, immediately after [REPORT_READY]
- Do not add any text after the JSON block
`.trim();

// ── Shared low-level caller ───────────────────────────────────────────────

async function callClaude(prompt, maxTokens = 600) {
  const c = getClient();
  if (!c) return null;
  try {
    const msg = await c.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    console.error('Claude API error:', e.message);
    return null;
  }
}

// ── Primary: system-prompt-driven conversation ────────────────────────────
//
// messageHistory must be an array of proper API message objects:
//   [{ role: 'user', content: '...' }, { role: 'assistant', content: '...' }, ...]
//
// Returns Claude's raw text response (may contain [REPORT_READY] signal).
// Returns null if Claude is unavailable.

async function conductConversation(messageHistory) {
  const c = getClient();
  if (!c) return null;
  try {
    const msg = await c.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: messageHistory
    });
    return msg.content[0]?.text || null;
  } catch (e) {
    console.error('[claude] conductConversation error:', e.message);
    return null;
  }
}

// ── Elaborate report for Slack (called at submission time) ────────────────
// Returns { heading, description, account, steps } — all in English.

async function elaborateReport(report) {
  const raw = await callClaude(`You are preparing a professional bug report for Rize Vietnam's engineering team in Slack.

INPUT (may be in Vietnamese or mixed language):
Description: ${report.details || '(not provided)'}
Category: ${report.category || 'App Bug'}
PG/Farmer name given by user: ${report.account || '(not provided)'}
Steps/how they encountered it: ${report.steps || '(not provided)'}

OUTPUT RULES — return ONLY valid JSON, no markdown:
{
  "heading": "Write in ENGLISH. 8-12 words. A clear technical summary of the actual bug — not a translation of the description. Example: 'Farmers unable to complete KYC update in planting group'",
  "description": "Write in ENGLISH. 2-4 sentences. Explain what fails, which app feature/screen is affected, and any relevant context. Expand with implied technical details. Do NOT just translate word-for-word.",
  "account": "Copy the PG/Farmer name EXACTLY as given in the input field above. Do NOT generate or replace with text from the description. If it was '(not provided)', write 'Not specified'.",
  "steps": "Write in ENGLISH. Numbered steps if provided. If not provided, write exactly: Not provided."
}

CRITICAL RULES:
- heading, description, steps: must be in English
- account: must be copied exactly from the input — never generated from description text
- Vietnamese proper nouns (people names, place names, PG names) stay as-is`, 700);

  const fallback = {
    heading:     report.summary || (report.details || '').split(/[.!?\n]/)[0].trim().substring(0, 80) || 'Issue reported',
    description: report.details || '',
    account:     report.account || 'Not specified',
    steps:       report.steps   || ''
  };

  if (!raw) return fallback;
  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    return {
      heading:     parsed.heading     || fallback.heading,
      description: parsed.description || fallback.description,
      account:     parsed.account     || fallback.account,
      steps:       parsed.steps       || fallback.steps
    };
  } catch (e) {
    return fallback;
  }
}

// ── Legacy helpers (kept for reference) ──────────────────────────────────

async function analyzeDescription(description) {
  const words = description.trim().split(/\s+/).length;
  return {
    is_detailed: words >= 15,
    follow_up:   words >= 15 ? null : 'Bạn có thể mô tả chi tiết hơn không?',
    category:    'App Bug',
    summary:     description.split(/[.!?\n]/)[0].trim().substring(0, 100)
  };
}

async function detectAccountFromText(text) { return null; }
async function generateSteps(desc) { return desc; }

module.exports = {
  conductConversation,
  elaborateReport,
  // legacy
  analyzeDescription,
  detectAccountFromText,
  generateSteps,
  SYSTEM_PROMPT
};
