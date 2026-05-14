/**
 * Claude API helpers — used for:
 *  1. Analyzing description quality + auto-detecting category
 *  2. Translating the report to English before posting to Slack
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

/**
 * Analyze whether a description has enough detail for a useful bug report.
 * Returns: { is_detailed, follow_up, category, summary }
 */
async function analyzeDescription(description) {
  const words = description.trim().split(/\s+/).length;

  // Heuristic fallback (no API key or API failure)
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
The reporter writes in Vietnamese, English, or a mix.

Analyze the description below and return ONLY valid JSON (no markdown fences):
{
  "is_detailed": boolean,
  "follow_up": "ONE specific follow-up question in Vietnamese to get missing detail, or null if detailed enough",
  "category": "App Bug" | "Farmer Data" | "Admin Request" | "Integration",
  "summary": "concise 8-12 word English phrase summarizing the core issue"
}

Rules for is_detailed=true:
- Mentions a specific screen, feature, or workflow
- Describes what happened or what error appeared
- Has enough context for a developer to understand the problem
Rule: if only one short sentence with no specifics → is_detailed=false

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

/**
 * Translate the report fields to English for the Slack post.
 * Only translates user-written content; keeps names, codes, IDs unchanged.
 */
async function translateReport(report) {
  const toTranslate = [
    `Description: ${report.details || ''}`,
    `PG/Farmer Account: ${report.account || ''}`,
    `Steps to Reproduce: ${report.steps || 'N/A'}`
  ].join('\n\n---\n\n');

  const raw = await callClaude(
    `Translate the following Vietnamese or mixed-language bug report fields to professional English.
Rules:
- Keep names, PG codes, app names, and technical terms exactly as-is
- Return the exact same format (Label: Content)
- Translate ONLY the content after the colon
- Return nothing else — just the translated text

${toTranslate}`,
    800
  );

  if (!raw) return report;

  const translated = { ...report };
  const descMatch = raw.match(/Description:\s*([\s\S]*?)(?:\n---\n|$)/);
  const pgMatch = raw.match(/PG\/Farmer Account:\s*([\s\S]*?)(?:\n---\n|$)/);
  const stepsMatch = raw.match(/Steps to Reproduce:\s*([\s\S]*?)$/);

  if (descMatch?.[1]?.trim()) translated.details = descMatch[1].trim();
  if (pgMatch?.[1]?.trim()) translated.account = pgMatch[1].trim();
  if (stepsMatch?.[1]?.trim() && stepsMatch[1].trim() !== 'N/A') {
    translated.steps = stepsMatch[1].trim();
  }
  return translated;
}

module.exports = { analyzeDescription, translateReport };
