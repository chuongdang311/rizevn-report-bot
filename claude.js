/**
 * Claude API helpers for the Rize Report Bot
 *
 * Functions:
 *  1. analyzeDescription  — quality check + category detection
 *  2. generateSteps       — convert natural "how I hit the bug" text → structured steps
 *  3. elaborateReport     — produce polished English heading + detailed description for Slack
 *
 * All functions gracefully fall back if ANTHROPIC_API_KEY is not set.
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
      : 'Bạn có thể mô tả chi tiết hơn không? Ví dụ: màn hình nào bạn đang ở, thông báo lỗi cụ thể là gì, và bạn đang làm gì khi gặp vấn đề?',
    category: 'App Bug',
    summary: description.split(/[.!?\n]/)[0].trim().substring(0, 100)
  };

  const raw = await callClaude(`You analyze bug/issue reports for Rize, a Vietnamese agri-tech company.
Rize products:
- Mobile App (for agronomists): KYC, AWD tasks, APD input, pipe installation, Quotes/agri inputs, Farmer Group management, delivery tracking, invoices
- Console (admin web): farmer management, reporting, Zoho sync

Reporter writes in Vietnamese, English, or mixed.

Analyze the description and return ONLY valid JSON (no markdown fences):
{
  "is_detailed": boolean,
  "follow_up": "ONE specific follow-up question in Vietnamese to get missing detail, or null if detailed enough",
  "category": "App Bug" | "Farmer Data" | "AWD Task" | "Farmer-Zoho Sync" | "Admin Request" | "Integration",
  "summary": "concise 8-10 word English phrase summarizing the core issue"
}

Category guide:
- "App Bug": crashes, UI errors, features not loading, wrong data displayed
- "Farmer Data": KYC completion failures, farmer profile update issues, onboarding data errors
- "AWD Task": APD input errors, pipe installation issues, water level tasks, AWD-related bugs
- "Farmer-Zoho Sync": farmer exists in app but missing/wrong in Zoho, sync mismatches
- "Admin Request": bulk data corrections, admin-level actions, manual overrides needed
- "Integration": third-party API issues, webhook failures, external system connections

is_detailed=true requires: specific screen/feature mentioned, describes what happened or error shown, enough context for a developer.

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

// ── 2. Generate structured steps from natural description ─────────────────

async function generateSteps(howDescription, issueContext) {
  const raw = await callClaude(`Convert the following natural description into clear numbered steps to reproduce a bug.

Issue context: "${issueContext}"
How they described encountering it: "${howDescription}"

Rules:
- Write in English
- Number each step (1. 2. 3.)
- Focus on: which screen/section they were on, what action they took, what happened
- Add "Expected:" at the end if the expected behaviour is clear from context
- Max 5-6 steps, keep each step concise
- Do NOT add any intro text — return ONLY the numbered steps

Example output:
1. Open the app and navigate to AWD > APD Input
2. Select Farmer Group "PG ABC"
3. Enter APD value for farmer
4. Tap Save — app shows error message and does not save
Expected: APD value saves successfully and updates the record`, 350);

  return raw || howDescription;
}

// ── 3. Elaborate report for Slack ─────────────────────────────────────────
// Replaces translateReport. Returns { heading, description, account, steps }

async function elaborateReport(report) {
  const context = [
    `Issue description (may be Vietnamese/mixed): ${report.details || ''}`,
    `PG / Farmer Account: ${report.account || ''}`,
    `Category: ${report.category || 'App Bug'}`,
    `Steps (if any): ${report.steps || 'Not provided'}`
  ].join('\n');

  const raw = await callClaude(`You are writing a professional bug report for Rize, a Vietnamese agri-tech company.

An agronomist submitted the following report (may be in Vietnamese or mixed language):
${context}

Your tasks — return ONLY valid JSON (no markdown fences):
{
  "heading": "Concise 8-12 word English heading clearly describing the technical issue. Do NOT just translate — summarize what the bug actually is.",
  "description": "Professional English description, 2-4 sentences. Explain the problem for a developer: what fails, which screen/feature is affected, relevant context like farmer group or specific action. Expand on implied technical details where helpful.",
  "account": "Translate or clean up the PG/Farmer account name into readable English. Keep proper nouns (names, places) unchanged.",
  "steps": "If steps were provided, clean and format them. If not provided, write exactly: Not provided."
}`, 700);

  const fallback = {
    heading: report.summary || (report.details || '').split(/[.!?\n]/)[0].trim().substring(0, 80) || 'Issue reported',
    description: report.details || '',
    account: report.account || '',
    steps: report.steps || ''
  };

  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
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

module.exports = { analyzeDescription, generateSteps, elaborateReport };
