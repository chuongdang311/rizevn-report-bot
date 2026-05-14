/**
 * Claude API helpers for the Rize Report Bot
 *
 * Functions:
 *  1. analyzeDescription  — quality check + category + vagueness detection
 *  2. detectAccountFromText — extract PG/farmer/group name from free-form text
 *  3. generateSteps       — convert natural description → numbered steps
 *  4. elaborateReport     — produce English heading + detailed description for Slack
 */

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

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

// ── 1. Analyze description quality + detect category ──────────────────────

async function analyzeDescription(description) {
  const words = description.trim().split(/\s+/).length;
  const heuristicDetailed = words >= 20;
  const fallback = {
    is_detailed: heuristicDetailed,
    follow_up: heuristicDetailed
      ? null
      : 'Bạn có thể mô tả chi tiết hơn không? Màn hình nào, tính năng nào đang gặp vấn đề, và lỗi cụ thể là gì?',
    category: 'App Bug',
    summary: description.split(/[.!?\n]/)[0].trim().substring(0, 100)
  };

  const raw = await callClaude(`You analyze bug/issue reports for Rize, a Vietnamese agri-tech company.

Rize Mobile App features: KYC farmer onboarding, AWD water tasks, APD input, pipe installation, Quotes/agri input ordering, Farmer Group management, delivery tracking, invoice upload, Zoho sync.

The reporter writes in Vietnamese, English, or mixed.

Analyze the description and return ONLY valid JSON (no markdown fences):
{
  "is_detailed": boolean,
  "follow_up": "ONE specific Vietnamese follow-up question to get the missing info, or null if already detailed",
  "category": one of: "App Bug" | "Farmer Data" | "AWD Task" | "Farmer-Zoho Sync" | "Admin Request" | "Integration",
  "summary": "concise 8-10 word English phrase describing the core issue"
}

Category guide:
- "App Bug": crashes, UI errors, features not loading, wrong data displayed, upload failures
- "Farmer Data": KYC not completing, farmer profile update issues, onboarding data errors
- "AWD Task": APD input errors, pipe installation issues, water level recording, AWD-related bugs
- "Farmer-Zoho Sync": farmer exists in app but missing/wrong in Zoho, sync mismatches
- "Admin Request": bulk data corrections, manual overrides, admin-level actions needed
- "Integration": third-party API failures, webhook issues, external system connections

is_detailed = FALSE (must ask follow-up) if ANY of these:
- Only mentions an action without context: "open the task", "click the button", "it doesn't work"
- No specific screen, feature, or workflow mentioned
- No error message or observable outcome described
- Single vague sentence with no specifics
- Could describe many different unrelated bugs

is_detailed = TRUE if:
- Mentions a specific screen, section, or feature name
- Describes what happened (error shown, action failed, data wrong)
- Has enough context for a developer to understand and reproduce

Description: "${description}"`);

  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return {
      is_detailed: !!parsed.is_detailed,
      follow_up: parsed.follow_up || null,
      category: parsed.category || 'App Bug',
      summary: parsed.summary || fallback.summary
    };
  } catch (e) {
    return fallback;
  }
}

// ── 2. Extract PG / farmer / group name from free-form text ───────────────
// Returns the name string, or null if no clear entity name found.

async function detectAccountFromText(text) {
  if (!text || text.trim().length < 3) return null;

  const raw = await callClaude(`You are reading a bug report written in Vietnamese or English by an agronomist at Rize Vietnam.

Text: "${text}"

Task: Extract the name of the Planting Group (PG/Nhóm Trồng Trọt), Farmer Group (Nhóm Nông Dân), or individual Farmer mentioned.

Naming conventions at Rize Vietnam:
- Planting Group: starts with "PG" followed by a location name, e.g. "PG Châu Thành", "PG An Giang 1", "PG Vĩnh Hòa"
- Farmer Group: may start with "FG", "Nhóm", or just a location/number, e.g. "FG-001", "Nhóm Bắc Giang 2"
- Farmer names: Vietnamese full names, typically 2-3 words, e.g. "Nguyễn Văn An", "Trần Thị Lan", "Lê Văn Bình"
- Location names in Vietnam: An Giang, Cần Thơ, Đồng Tháp, Long An, Tiền Giang, Vĩnh Long, Bến Tre, Kiên Giang, Hậu Giang, Sóc Trăng, Bạc Liêu, Châu Thành, Vĩnh Hòa, Vĩnh Hạnh, etc.

Return ONLY a JSON object:
{
  "found": boolean,
  "name": "the extracted name, or null"
}

Return found=false if:
- The text only describes a problem without naming a specific PG/FG/farmer
- No clear entity name can be identified
- The mention is generic (e.g. "all farmers", "a farmer group") without a specific name`, 200);

  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.found && parsed.name ? parsed.name : null;
  } catch (e) {
    return null;
  }
}

// ── 3. Generate structured steps from natural description ─────────────────

async function generateSteps(howDescription, issueContext) {
  const raw = await callClaude(`Convert the following natural language description into clear numbered steps to reproduce a bug. Write in English only.

Issue context: "${issueContext}"
How they described it: "${howDescription}"

Rules:
- Number each step (1. 2. 3.)
- Focus on: which screen/section, what action, what happened
- Add "Expected:" at the end if the expected behaviour is clear
- Max 5-6 steps, each step concise
- Return ONLY the numbered steps, no intro text

Example:
1. Open the app and navigate to AWD > APD Input
2. Select Planting Group "PG Châu Thành"
3. Enter APD value for the farmer
4. Tap Save — app shows error and does not save
Expected: APD value saves successfully`, 350);

  return raw || howDescription;
}

// ── 4. Elaborate report for Slack ─────────────────────────────────────────
// Returns { heading, description, account, steps } — all in English except proper nouns.

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
    heading: report.summary || (report.details || '').split(/[.!?\n]/)[0].trim().substring(0, 80) || 'Issue reported',
    description: report.details || '',
    account: report.account || 'Not specified',
    steps: report.steps || ''
  };

  if (!raw) return fallback;
  try {
    // Strip potential markdown fences Claude might add despite instructions
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
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

// ── 5. Claude-driven conversation orchestration ───────────────────────────
// Analyzes each user message, extracts all available fields, and generates
// a natural Vietnamese response asking for whatever is still missing.
//
// Returns:
//   { updates, readyToConfirm, response, quickReplies }

async function analyzeAndCollect(history, currentData, newMessage) {
  const collected = {
    description: currentData.details  || null,
    account:     currentData.account  || null,
    platform:    currentData.platform || null,
    urgency:     currentData.urgency  || null,
    steps:       currentData.steps    || null
  };

  // Include only the most recent 8 exchanges so the prompt stays compact
  const recentHistory = (history || []).slice(-8);
  const historyText = recentHistory
    .map(h => `${h.role === 'user' ? 'AG' : 'Bot'}: ${h.text}`)
    .join('\n');

  const raw = await callClaude(`You are the Rize Vietnam bug-report assistant bot. Agronomists (AGs) submit bug reports in Vietnamese or English.

FIELDS COLLECTED SO FAR:
- Description: ${collected.description ? `"${collected.description.substring(0, 300)}"` : '(none)'}
- PG / Account: ${collected.account  || '(none)'}
- Platform:     ${collected.platform || '(none)'}
- Urgency:      ${collected.urgency  || '(none — will default to Medium if never mentioned)'}
- Steps:        ${collected.steps    || '(none)'}

CONVERSATION SO FAR:
${historyText}

LATEST USER MESSAGE: "${newMessage}"

RIZE VIETNAM NAMING CONVENTIONS:
- Planting Groups: start with "PG" or follow [Province_Location_Tag] format
  e.g. "PG Châu Thành", "PG An Giang 1", "AnGiang_VinhTrach_Sale", "KENH 11_CAU CHU S2", "Lat_Seed (AG 1.1)"
- Farmer Groups: "FG-001", "Bayer Forward Farm_CHAU PHU_AN GIANG", "Coop_Hoa Binh_Bac Lieu"
- Farmer names: unaccented Vietnamese 2-3 words e.g. "Nguyen Van Y Bang", "Tran Cong Qui"
- Provinces: An Giang, Thoai Son, Cho Moi, Tri Ton, Bac Lieu, Chau Phu, Can Tho, Dong Thap, etc.

APP FEATURES: KYC farmer onboarding, AWD water tasks, APD input, pipe installation, Quotes / agri-input ordering, Farmer Group management, delivery tracking, invoice upload, Zoho sync.

CATEGORIES:
- "App Bug": crashes, UI errors, features not loading, wrong data displayed, upload failures
- "Farmer Data": KYC not completing, farmer profile issues, onboarding data errors
- "AWD Task": APD input errors, pipe installation, water level recording
- "Farmer-Zoho Sync": farmer missing or wrong in Zoho, sync mismatches
- "Admin Request": bulk corrections, manual overrides, admin-level actions
- "Integration": third-party API failures, webhooks, external system connections

YOUR TASKS:
1. Extract any field values present in the LATEST USER MESSAGE.
2. Decide if the description is sufficient:
   SUFFICIENT = mentions a specific screen/feature AND describes what went wrong (error shown, data wrong, action failed).
   NOT SUFFICIENT = only says "it doesn't work", "open the task", no screen/feature named.
3. Identify which REQUIRED fields are still missing: description (sufficient), account, platform.
4. Write a warm, conversational Vietnamese response:
   - Acknowledge what they've shared.
   - Ask naturally for 1-2 missing things in one sentence (don't list robotically).
   - Use Rize-context examples (PG names, features) to guide them.
   - If urgency not mentioned, do NOT ask — default to Medium.
   - Steps are optional: only ask if the description gives no clue how the issue happened.
5. When ALL required fields are collected set readyToConfirm=true and ask for their work email.

Return ONLY valid JSON (no markdown fences):
{
  "updates": {
    "details":  "full description if new/better text found in this message, else null",
    "account":  "extracted PG/FG/farmer name or null",
    "platform": "iOS|Android|Web or null",
    "urgency":  "High|Medium|Low or null",
    "steps":    "reproduction steps text or null",
    "category": "category string or null",
    "summary":  "8-10 word English phrase describing the core issue, or null"
  },
  "readyToConfirm": false,
  "response": "Your Vietnamese message to the user",
  "quickReplies": ["iOS", "Android", "Web"] or null
}`, 800);

  const fallback = {
    updates:        {},
    readyToConfirm: false,
    response:       'Bạn có thể mô tả thêm không? Màn hình nào đang gặp vấn đề, và điều gì cụ thể đã xảy ra?',
    quickReplies:   null
  };

  if (!raw) return fallback;
  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    return {
      updates:        parsed.updates        || {},
      readyToConfirm: !!parsed.readyToConfirm,
      response:       parsed.response       || fallback.response,
      quickReplies:   Array.isArray(parsed.quickReplies) ? parsed.quickReplies : null
    };
  } catch (e) {
    console.error('[claude] analyzeAndCollect parse error:', e.message, '| raw excerpt:', raw?.substring(0, 200));
    return fallback;
  }
}

module.exports = { analyzeDescription, detectAccountFromText, generateSteps, elaborateReport, analyzeAndCollect };
