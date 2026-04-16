/**
 * Hotel Revenue Forecasting System - Module 4c: Report Processor / Layer 2 (V11)
 *
 * Runs AFTER the AI Layer 2 HTTP Request node.
 * Receives merged inputs from:
 *   1. AI Layer 2 (OpenAI) node  — structured JSON report object
 *   2. AI Processor output       — 12 week rows + 1 summary row
 *
 * Responsibilities:
 *   - Parse the Layer 2 AI JSON output (meta titles, summaries, insights, data_gaps)
 *   - Build forecast_table from the actual week row data (avoids AI hallucinating numbers)
 *   - Merge both into a single 'report' row ready for v11_docx_generator.js
 *   - Pass through all week + summary rows unchanged for Context Calculations
 *
 * Output rows:
 *   - 12 × Row_Type = "week"    (pass-through)
 *   - 1  × Row_Type = "summary" (pass-through)
 *   - 1  × Row_Type = "report"  (full docx-ready structure)
 *
 * N8N wiring:
 *   AI Node 2 (HTTP) + AI Processor → [Merge/Append] → this node → Context Calculations
 *   This node (report row only) → [Filter] → Docx Generator
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

// ── Identify AI Layer 2 response vs. pass-through rows ───────────────────────
const aiItem = allInputs.find(item =>
  Array.isArray(item.json?.output) || Array.isArray(item.json?.choices)
);

const passthroughItems = allInputs.filter(item =>
  item.json?.Row_Type === 'week' || item.json?.Row_Type === 'summary'
);

const weekRows = passthroughItems
  .filter(item => item.json?.Row_Type === 'week')
  .map(item => item.json);

const summaryRow       = passthroughItems.find(item => item.json?.Row_Type === 'summary')?.json;
const historicalMonthly = summaryRow?.Historical_Monthly || [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRawText(resp) {
  const candidates = [
    resp?.output?.[0]?.content?.[0]?.text,
    resp?.choices?.[0]?.message?.content,
    resp?.message?.content,
    resp?.content?.[0]?.text,
    resp?.text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    if (c && typeof c === 'object' && typeof c.text === 'string') return c.text.trim();
  }
  return null;
}

function stripFences(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// Format a date string (YYYY-MM-DD) as Dutch short date: "31 mrt"
const MONTH_SHORT_NL = [
  'jan','feb','mrt','apr','mei','jun',
  'jul','aug','sep','okt','nov','dec'
];
function shortDateNL(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()} ${MONTH_SHORT_NL[d.getMonth()]}`;
}

// Format week date range: "31 mrt – 6 apr"
function weekPeriodNL(weekStart, weekEnd) {
  if (!weekStart || !weekEnd) return '';
  const s = new Date(weekStart);
  const e = new Date(weekEnd);
  const sStr = shortDateNL(weekStart);
  // Include year only if different from week end year
  const eStr = s.getFullYear() !== e.getFullYear()
    ? `${shortDateNL(weekEnd)} ${e.getFullYear()}`
    : shortDateNL(weekEnd);
  return `${sStr} – ${eStr}`;
}

// Parse YoY string like "+5.2" or "-3.1" to number
function parseYoY(val) {
  if (val == null) return null;
  const n = parseFloat(String(val).replace('+', ''));
  return isNaN(n) ? null : n;
}

// ── Graceful degradation — no AI response ─────────────────────────────────────
if (!aiItem) {
  console.warn('⚠️ Report Processor V11: no AI Layer 2 response found — skipping report.');
  const fallback = {
    json: {
      Row_Type:    'report',
      Report_Error: 'Layer 2 AI response not found — check n8n wiring.',
      Hotel_Name:          passthroughItems[0]?.json?.Hotel_Name          || null,
      Forecast_Created_At: passthroughItems[0]?.json?.Forecast_Created_At || null
    }
  };
  return [...passthroughItems, fallback];
}

// ── Extract and parse Layer 2 JSON ───────────────────────────────────────────
const rawText = extractRawText(aiItem.json);

if (!rawText) {
  throw new Error(
    'Report Processor V11: could not extract text from Layer 2 AI response. ' +
    `Response keys: ${Object.keys(aiItem.json || {}).join(', ')}`
  );
}

let layer2Json;

// Check if the AI response was already parsed to an object
const prebuilt = aiItem.json?.output?.[0]?.content?.[0];
if (prebuilt && typeof prebuilt === 'object' && prebuilt.meta) {
  layer2Json = prebuilt;
} else {
  const clean = stripFences(rawText);
  try {
    layer2Json = JSON.parse(clean);
  } catch (err) {
    throw new Error(
      `Report Processor V11: JSON.parse failed — ${err.message}. ` +
      `Raw (first 400 chars): ${clean.slice(0, 400)}`
    );
  }
}

// Validate required fields
const required = ['meta', 'current_week_summary', 'page1_bridge', 'insights', 'data_gaps', 'page2_intro'];
for (const field of required) {
  if (layer2Json[field] == null) {
    throw new Error(
      `Report Processor V11: Layer 2 JSON missing required field "${field}". ` +
      `Got keys: ${Object.keys(layer2Json).join(', ')}`
    );
  }
}

// ── Resolve hotel metadata ────────────────────────────────────────────────────
const firstWeekRow    = weekRows[0] || {};
const hotelName       = firstWeekRow.Hotel_Name          || null;
const createdAt       = firstWeekRow.Forecast_Created_At || null;
const createdAtDate   = createdAt ? createdAt.split('T')[0] : null;
const periodStart     = firstWeekRow.Week_Key            || null;
const periodEnd       = weekRows.length > 0
  ? weekRows[weekRows.length - 1].Week_Key : null;
const reportPeriod    = (periodStart && periodEnd) ? `${periodStart}–${periodEnd}` : periodStart;

// ── Build monthly forecast table: past 3 months (historical) + next 3 (forecast) ─
const MONTH_NL_RP = ['Januari','Februari','Maart','April','Mei','Juni',
                     'Juli','Augustus','September','Oktober','November','December'];

// Aggregate week rows into months via Thursday rule, take first 3 months
const fcstMonthMap = new Map();
weekRows.forEach(w => {
  if (!w.Week_Start) return;
  const thu = new Date(w.Week_Start);
  thu.setDate(thu.getDate() + 3);
  const mk = `${thu.getFullYear()}-${String(thu.getMonth() + 1).padStart(2, '0')}`;
  if (!fcstMonthMap.has(mk)) {
    fcstMonthMap.set(mk, {
      label: `${MONTH_NL_RP[thu.getMonth()]} ${thu.getFullYear()}`,
      rn: 0, revenue: 0, capacity: 0, lyRN: 0, lyCount: 0
    });
  }
  const m = fcstMonthMap.get(mk);
  m.rn       += w.Room_Nights_Final    ?? 0;
  m.revenue  += w.Est_Room_Revenue     ?? 0;
  m.capacity += w.Capacity_Room_Nights ?? 0;
  if (w.Historical_LY != null) { m.lyRN += w.Historical_LY; m.lyCount++; }
});

const fcstMonths = Array.from(fcstMonthMap.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .slice(0, 3)
  .map(([mk, m]) => ({
    month_key:     mk,
    label:         m.label,
    type:          'forecast',
    room_nights:   m.rn,
    room_revenue:  Math.round(m.revenue),
    adr:           m.rn > 0 ? parseFloat((m.revenue / m.rn).toFixed(2)) : null,
    occupancy_pct: m.capacity > 0 ? parseFloat((m.rn / m.capacity * 100).toFixed(1)) : null,
    yoy_pct:       m.lyRN > 0 ? parseFloat(((m.rn - m.lyRN) / m.lyRN * 100).toFixed(1)) : null
  }));

const forecastTable = [...historicalMonthly, ...fcstMonths];

// ── Determine current week for the "Huidige stand" block ─────────────────────
// Use the first partial week if present, otherwise the first week
const currentWeekRow = weekRows.find(w => w.Is_Partial_Week) || firstWeekRow;
const currentWeek = {
  week_key:    currentWeekRow.Week_Key || null,
  period:      weekPeriodNL(currentWeekRow.Week_Start, currentWeekRow.Week_End),
  otb_nights:  currentWeekRow.OTB_Room_Nights ?? null,
  occupancy_pct: currentWeekRow.Occupancy_Pct ?? null,
  adr:         currentWeekRow.OTB_ADR         ?? null,
  yoy_pct:     parseYoY(currentWeekRow.YoY_Vs_LY_Pct),
  summary:     layer2Json.current_week_summary
};

// ── Assemble full report structure ────────────────────────────────────────────
const reportJson = {
  Row_Type: 'report',

  // Document metadata (partially from AI, partially from week row data)
  meta: {
    hotel_name:    hotelName,
    report_period: reportPeriod,
    created_at:    createdAtDate,
    page1_title:   layer2Json.meta?.page1_title || 'Revenue Forecast Analyse',
    page2_title:   layer2Json.meta?.page2_title || 'OTB-vergelijking & Onderliggende Analyse'
  },

  // Current week block
  current_week: currentWeek,

  // Forecast table (built from real numbers — no AI involvement)
  forecast_table: forecastTable,

  // chart_png_base64: null — filled by a separate chart generation node
  chart_png_base64: null,

  // Narrative content from AI
  page1_bridge: layer2Json.page1_bridge,
  insights:     Array.isArray(layer2Json.insights)  ? layer2Json.insights  : [],
  data_gaps:    Array.isArray(layer2Json.data_gaps) ? layer2Json.data_gaps : [],
  page2_intro:  layer2Json.page2_intro,

  // Administrative
  Hotel_Name:          hotelName,
  Forecast_Created_At: createdAt
};

console.log(
  `✅ Report Processor V11: report built | ` +
  `${forecastTable.length} months in forecast_table (${historicalMonthly.length} historical + ${fcstMonths.length} forecast) | ` +
  `${reportJson.insights.length} insights | ` +
  `${reportJson.data_gaps.length} data_gaps`
);

// Return all pass-through rows first, then the new report row
return [...passthroughItems, { json: reportJson }];
