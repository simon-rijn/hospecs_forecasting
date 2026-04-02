/**
 * Hotel Revenue Forecasting System - Module 4c: Report Processor / Layer 2 (V11)
 *
 * Runs AFTER the AI Layer 2 HTTP Request node.
 * Receives merged inputs from:
 *   1. AI Layer 2 (OpenAI) node  — Dutch prose report text
 *   2. AI Processor output       — 12 week rows + 1 summary row
 *
 * Extracts the Dutch prose from the AI response and adds it to the output stream
 * as a Row_Type = 'report' item. All other rows (week, summary) are passed through
 * unchanged so downstream nodes (context calculations, output) are unaffected.
 *
 * Output rows:
 *   - 12 × Row_Type = "week"    (pass-through from AI Processor)
 *   - 1  × Row_Type = "summary" (pass-through from AI Processor)
 *   - 1  × Row_Type = "report"  (new — Dutch prose analysis)
 *
 * N8N wiring:
 *   AI Node 2 (HTTP) + AI Processor → [Merge] → this node → Context Calculations
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

// ── Identify AI Layer 2 response vs. pass-through rows ───────────────────────
// AI response: has .output (OpenAI Responses API) or .choices (Chat Completions)
const aiItem = allInputs.find(item =>
  Array.isArray(item.json?.output) || Array.isArray(item.json?.choices)
);

// Pass-through rows: week rows and summary row from AI Processor
const passthroughItems = allInputs.filter(item =>
  item.json?.Row_Type === 'week' || item.json?.Row_Type === 'summary'
);

if (!aiItem) {
  // Graceful degradation: if no AI response found, pass through existing rows
  // and add an empty report row with an error note
  console.warn('⚠️ Report Processor V11: no AI Layer 2 response found — skipping report generation.');
  const fallbackReport = {
    json: {
      Row_Type:     'report',
      Report_Text:  null,
      Report_Error: 'Layer 2 AI response not found in input — check n8n wiring.',
      Hotel_Name:          passthroughItems[0]?.json?.Hotel_Name          || null,
      Forecast_Created_At: passthroughItems[0]?.json?.Forecast_Created_At || null
    }
  };
  return [...passthroughItems, fallbackReport];
}

// ── Extract prose text from AI response ──────────────────────────────────────
function extractProseText(resp) {
  const candidates = [
    resp?.output?.[0]?.content?.[0]?.text,   // OpenAI Responses API
    resp?.choices?.[0]?.message?.content,     // Chat Completions
    resp?.message?.content,                   // n8n OpenAI node wrapper
    resp?.content?.[0]?.text,                 // Anthropic Claude direct
    resp?.text,                               // Generic fallback
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    // Handle pre-parsed object (unlikely for prose but safe)
    if (c && typeof c === 'object' && typeof c.text === 'string') return c.text.trim();
  }
  return null;
}

const rawText = extractProseText(aiItem.json);

if (!rawText) {
  throw new Error(
    'Report Processor V11: could not extract prose text from Layer 2 AI response. ' +
    `Response keys: ${Object.keys(aiItem.json || {}).join(', ')}`
  );
}

// ── Resolve hotel metadata from pass-through rows ─────────────────────────────
const anyWeekRow = passthroughItems.find(item => item.json?.Row_Type === 'week');
const hotelName          = anyWeekRow?.json?.Hotel_Name          || null;
const forecastCreatedAt  = anyWeekRow?.json?.Forecast_Created_At || null;

// ── Build report row ──────────────────────────────────────────────────────────
const reportItem = {
  json: {
    Row_Type:    'report',
    Report_Text: rawText,

    Hotel_Name:          hotelName,
    Forecast_Created_At: forecastCreatedAt
  }
};

console.log(
  `✅ Report Processor V11: prose report parsed (${rawText.length} chars) | ` +
  `${passthroughItems.length} rows passed through`
);

// Return: all existing rows first, then the new report row
return [...passthroughItems, reportItem];
