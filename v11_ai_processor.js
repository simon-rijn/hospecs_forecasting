/**
 * Hotel Revenue Forecasting System - Module 4: AI Forecast Processor (V11)
 *
 * Changes from V10:
 * - REMOVED: AI forecast numbers — AI no longer produces or adjusts room night totals
 * - REMOVED: proportional daily distribution (forecast is now weekly only)
 * - REMOVED: Hotel Forecasting Output node — final output formatting is done here
 * - ADDED:   AI annotation merging (weekNotes, deviationSignals, conclusions)
 * - ADDED:   Validation: warn if forecast > 130% of LY same week
 * - ADDED:   Forecast_Created_At set once here, shared by all output rows
 *
 * Runs AFTER the AI HTTP Request node.
 * Receives merged inputs from:
 *   1. AI (OpenAI) node    — output[0].content[0].text  → JSON annotations
 *   2. Forecasting engine  — weeklyForecast, hotelInfo, recentTrend, monthlyTrend
 *
 * Produces:
 *   - 12 items with Row_Type = "week"  (one per ISO week)
 *   - 1  item  with Row_Type = "summary" (deviation signals + conclusions)
 * All items share the same Forecast_Created_At timestamp.
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

// ── Identify engine item and AI item from merged inputs ───────────────────────
// Engine item: has .success (boolean) and .weeklyForecast (array)
const engineItem = allInputs.find(item =>
  typeof item.json?.success === 'boolean' && Array.isArray(item.json?.weeklyForecast)
);

// AI item: OpenAI Responses API format — has .output (array)
const aiItem = allInputs.find(item => Array.isArray(item.json?.output));

// Resolve engine output (with fallback for single-input wiring)
let engineOutput;
if (engineItem) {
  engineOutput = engineItem.json;
} else {
  try {
    engineOutput = $('Forecasting engine').all()[0].json;
  } catch (e) {
    throw new Error(
      'AI Forecast Processor V11: cannot access "Forecasting engine" data.\n' +
      'Fix: connect "Forecasting engine" to this node in the workflow editor.\n' +
      `Underlying error: ${e.message}`
    );
  }
}

if (!engineOutput.success) {
  throw new Error('Cannot process — engine step failed: ' + (engineOutput.error || 'unknown'));
}

const { weeklyForecast, hotelInfo, recentTrend, monthlyTrend } = engineOutput;
const warnings = [...(engineOutput.warnings || [])];

// ── Single timestamp shared by all output rows in this execution ──────────────
const forecastCreatedAt = new Date().toISOString();
const hotelName = hotelInfo?.hotelName || hotelInfo?.Hotel_Name || 'Unknown Hotel';

// ── Extract AI annotations ────────────────────────────────────────────────────
const aiResponse = aiItem?.json ?? $input.first().json;

// N8N sometimes auto-parses JSON so `text` arrives as an object instead of a string.
// We therefore try each known path for both types, in order of specificity.
function extractAnnotations(resp) {
  const candidates = [
    resp?.output?.[0]?.content?.[0]?.text,   // OpenAI Responses API — object OR string
    resp?.choices?.[0]?.message?.content,     // Chat Completions via HTTP Request node
    resp?.message?.content,                   // n8n OpenAI node wrapper
    resp?.content?.[0]?.text,                 // Anthropic Claude API direct
    resp?.text,                               // Generic fallback
  ];

  for (const c of candidates) {
    // Case 1: N8N already parsed the JSON → object with the right shape
    if (c && typeof c === 'object' && !Array.isArray(c)) return { parsed: c };
    // Case 2: plain string → we'll JSON.parse it ourselves
    if (typeof c === 'string' && c.trim().length > 0) return { raw: c };
  }
  return null;
}

const extracted = extractAnnotations(aiResponse);

if (!extracted) {
  const structure  = JSON.stringify(aiResponse, null, 2).slice(0, 800);
  const inputSummary = allInputs.map((item, i) =>
    `[${i}]: ${Object.keys(item.json || {}).join(', ')}`
  ).join(' | ');
  throw new Error(
    'AI Forecast Processor V11: no usable content found in AI response.\n' +
    `All input keys: ${inputSummary}\n` +
    `aiResponse structure (first 800 chars):\n${structure}`
  );
}

// ── Parse AI annotations ──────────────────────────────────────────────────────
let annotations;
if (extracted.parsed) {
  // Already an object — use directly
  annotations = extracted.parsed;
} else {
  // String — strip optional markdown fences then parse
  const clean = extracted.raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    annotations = JSON.parse(clean);
  } catch (err) {
    throw new Error(
      `AI Forecast Processor V11: JSON.parse failed — ${err.message}. ` +
      `Raw (first 300 chars): ${clean.slice(0, 300)}`
    );
  }
}

if (!Array.isArray(annotations.weekNotes) ||
    !Array.isArray(annotations.deviationSignals) ||
    !Array.isArray(annotations.conclusions)) {
  throw new Error(
    `AI Forecast Processor V11: response missing required fields ` +
    `(weekNotes, deviationSignals, conclusions). Got: ${JSON.stringify(annotations).slice(0, 300)}`
  );
}

// ── Build weekNotes lookup: weekKey → notes[] ─────────────────────────────────
const weekNotesMap = new Map();
annotations.weekNotes.forEach(entry => {
  if (entry.weekKey && Array.isArray(entry.notes)) {
    weekNotesMap.set(entry.weekKey, entry.notes);
  }
});

console.log(`✅ AI annotations parsed: ${weekNotesMap.size} weeks with notes, ` +
  `${annotations.deviationSignals.length} deviation signals, ` +
  `${annotations.conclusions.length} conclusions`);

// ── Validate each week and build output rows ──────────────────────────────────
const weekOutputItems = weeklyForecast.map(week => {

  // Warn if forecast > 130% of last year's actuals for this week
  if (week.historicalLY && week.historicalLY > 0) {
    const ratio = week.roomNightsFinal / week.historicalLY;
    if (ratio > 1.30) {
      warnings.push(
        `${week.weekKey}: forecast (${week.roomNightsFinal} RN) is ` +
        `${((ratio - 1) * 100).toFixed(0)}% above LY (${week.historicalLY} RN${week.lyEstimated ? ', estimated' : ''}).`
      );
    }
  }

  const notes    = weekNotesMap.get(week.weekKey) || [];
  const notesStr = notes.length > 0 ? notes.join(' | ') : null;

  const yoyStr = week.yoyVsLYPct != null
    ? `${week.yoyVsLYPct >= 0 ? '+' : ''}${week.yoyVsLYPct}`
    : null;

  return {
    json: {
      Row_Type: 'week',

      // Week identification
      Week_Key:   week.weekKey,
      Week_Start: week.weekStart,
      Week_End:   week.weekEnd,

      // Forecast result
      Room_Nights_Final:    week.roomNightsFinal,
      OTB_Room_Nights:      week.otbRoomNights,
      Pickup:               week.pickup,
      Capacity_Room_Nights: week.capacity,
      Occupancy_Pct:        week.occupancyPct,
      Is_Partial_Week:      week.isPartialWeek || false,
      Days_Elapsed:         week.isPartialWeek ? week.daysElapsed : 0,

      // Revenue (OTB ADR as basis; fallback to historical ADR)
      OTB_ADR:           week.otbADR,
      Est_Room_Revenue:  week.estRoomRevenue,
      Est_FB_Revenue:    week.estFBRevenue,
      Est_Other_Revenue: week.estOtherRevenue,
      Est_Total_Revenue: week.estTotalRevenue,

      // Historical context
      Historical_LY:    week.historicalLY,
      Historical_Avg:   week.historicalAvg,
      YoY_Vs_LY_Pct:   yoyStr,
      LY_Estimated:     week.lyEstimated || false,

      // Variance
      Variance_Pct:        week.variancePct,
      Forecast_Range_Low:  week.forecastRangeLow,
      Forecast_Range_High: week.forecastRangeHigh,

      // AI annotations for this week
      Forecast_Notes: notesStr,

      // Administrative
      Hotel_Name:          hotelName,
      Forecast_Created_At: forecastCreatedAt
    }
  };
});

// ── Summary row (deviation signals + conclusions) ─────────────────────────────
const summaryItem = {
  json: {
    Row_Type: 'summary',

    Deviation_Signals: annotations.deviationSignals.join(' | ') || null,
    Conclusions:       annotations.conclusions.join(' | ')       || null,

    // Trend context stored alongside summary for downstream reporting
    Recent_Trend_Actual_4W:  recentTrend?.last4WeeksActual         || null,
    Recent_Trend_LY_4W:      recentTrend?.last4WeeksSameLastYear   || null,
    Recent_Trend_YoY_Pct:    recentTrend?.yoyChangePercent         || null,
    Monthly_Trend_Month:     monthlyTrend?.monthName                || null,
    Monthly_Trend_Actual:    monthlyTrend?.previousMonthActual      || null,
    Monthly_Trend_LY:        monthlyTrend?.previousMonthLastYear    || null,
    Monthly_Trend_YoY_Pct:   monthlyTrend?.yoyChangePercent        || null,

    Hotel_Name:          hotelName,
    Forecast_Created_At: forecastCreatedAt
  }
};

// ── Log summary ───────────────────────────────────────────────────────────────
const totalRN  = weeklyForecast.reduce((s, w) => s + w.roomNightsFinal, 0);
const totalRev = weeklyForecast.reduce((s, w) => s + w.estTotalRevenue, 0);
console.log(`✅ AI Processor V11: ${weeklyForecast.length} weeks | ${totalRN} RN | €${totalRev.toFixed(0)}`);
if (warnings.length > 0) console.warn('⚠️ Warnings:', warnings.join('; '));

return [...weekOutputItems, summaryItem];
