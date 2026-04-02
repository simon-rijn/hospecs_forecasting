/**
 * Hotel Revenue Forecasting System - Module 4: AI Forecast Processor / Layer 1 (V11)
 *
 * Runs AFTER the AI Layer 1 HTTP Request node.
 * Receives merged inputs from:
 *   1. AI (OpenAI) node    — Layer 1 analysis JSON
 *   2. Forecasting engine  — weeklyForecast, hotelInfo, recentTrend, monthlyTrend
 *
 * Layer 1 AI output structure:
 *   metric_connections  — patterns requiring ≥2 metrics to identify
 *   anomalies           — contradictions vs. what surface numbers suggest
 *   week_signals        — per-week notable signals with a risk level
 *   data_gaps           — specific missing data that would sharpen conclusions
 *
 * Produces:
 *   - 12 items with Row_Type = "week"    (one per ISO week, with Signal_Level + Signals)
 *   - 1  item  with Row_Type = "summary" (Layer 1 analysis + trend context + warnings)
 * All items share the same Forecast_Created_At timestamp.
 *
 * The summary row's Layer1_Analysis field is consumed by v11_layer2_prompt_builder.js
 * to build the Layer 2 (prose report) prompt.
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

// ── Identify engine item and AI item from merged inputs ───────────────────────
const engineItem = allInputs.find(item =>
  typeof item.json?.success === 'boolean' && Array.isArray(item.json?.weeklyForecast)
);
const aiItem = allInputs.find(item => Array.isArray(item.json?.output));

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

const forecastCreatedAt = new Date().toISOString();
const hotelName = hotelInfo?.hotelName || hotelInfo?.Hotel_Name || 'Unknown Hotel';

// ── Extract AI response text ──────────────────────────────────────────────────
const aiResponse = aiItem?.json ?? $input.first().json;

function extractAnnotations(resp) {
  const candidates = [
    resp?.output?.[0]?.content?.[0]?.text,
    resp?.choices?.[0]?.message?.content,
    resp?.message?.content,
    resp?.content?.[0]?.text,
    resp?.text,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) return { parsed: c };
    if (typeof c === 'string' && c.trim().length > 0) return { raw: c };
  }
  return null;
}

const extracted = extractAnnotations(aiResponse);

if (!extracted) {
  const structure    = JSON.stringify(aiResponse, null, 2).slice(0, 800);
  const inputSummary = allInputs.map((item, i) =>
    `[${i}]: ${Object.keys(item.json || {}).join(', ')}`
  ).join(' | ');
  throw new Error(
    'AI Forecast Processor V11: no usable content found in AI response.\n' +
    `All input keys: ${inputSummary}\n` +
    `aiResponse structure (first 800 chars):\n${structure}`
  );
}

// ── Parse Layer 1 JSON ────────────────────────────────────────────────────────
let annotations;
if (extracted.parsed) {
  annotations = extracted.parsed;
} else {
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

if (!Array.isArray(annotations.metric_connections) ||
    !Array.isArray(annotations.week_signals) ||
    !Array.isArray(annotations.data_gaps)) {
  throw new Error(
    `AI Forecast Processor V11: response missing required fields ` +
    `(metric_connections, week_signals, data_gaps). Got: ${JSON.stringify(annotations).slice(0, 300)}`
  );
}

// ── Build week signals lookup: weekKey → { level, signals } ──────────────────
const weekSignalsMap = new Map();
annotations.week_signals.forEach(entry => {
  if (entry.week_key && Array.isArray(entry.signals)) {
    weekSignalsMap.set(entry.week_key, {
      level:   entry.level   || null,
      signals: entry.signals
    });
  }
});

console.log(`✅ AI Layer 1 parsed: ${weekSignalsMap.size} weeks with signals, ` +
  `${annotations.metric_connections.length} metric connections, ` +
  `${(annotations.anomalies || []).length} anomalies, ` +
  `${annotations.data_gaps.length} data gaps`);

// ── Build week output rows ────────────────────────────────────────────────────
const weekOutputItems = weeklyForecast.map(week => {

  if (week.historicalLY && week.historicalLY > 0) {
    const ratio = week.roomNightsFinal / week.historicalLY;
    if (ratio > 1.30) {
      warnings.push(
        `${week.weekKey}: forecast (${week.roomNightsFinal} RN) is ` +
        `${((ratio - 1) * 100).toFixed(0)}% above LY (${week.historicalLY} RN${week.lyEstimated ? ', estimated' : ''}).`
      );
    }
  }

  const weekSig    = weekSignalsMap.get(week.weekKey) || { level: null, signals: [] };
  const signalsStr = weekSig.signals.length > 0 ? weekSig.signals.join(' | ') : null;

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

      // Revenue
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

      // Layer 1 AI signals for this week
      Signal_Level: weekSig.level,
      Signals:      signalsStr,

      // Supplementary diagnostics
      Meta: {
        Days_Until_Week_Start:   week.daysUntilWeekStart,
        OTB_Fill_Rate:           week.otbFillRate,
        ADR_Source:              week.adrSource,
        Historical_ADR_Fallback: week.historicalADRFallback,
        SVB_Raw:                 week.svbRaw,
        Historical_By_Year:      week.historicalByYear,
        Events:                  week.events
      },

      // Administrative
      Hotel_Name:          hotelName,
      Forecast_Created_At: forecastCreatedAt
    }
  };
});

// ── Summary row ───────────────────────────────────────────────────────────────
// Layer1_Analysis is a structured object consumed by v11_layer2_prompt_builder.js
const summaryItem = {
  json: {
    Row_Type: 'summary',

    // Layer 1 structured analysis — consumed by Layer 2 prompt builder
    Layer1_Analysis: {
      metric_connections: annotations.metric_connections,
      anomalies:          annotations.anomalies || [],
      week_signals:       annotations.week_signals,
      data_gaps:          annotations.data_gaps
    },

    // Trend context
    Recent_Trend_Actual_4W:  recentTrend?.last4WeeksActual       || null,
    Recent_Trend_LY_4W:      recentTrend?.last4WeeksSameLastYear || null,
    Recent_Trend_YoY_Pct:    recentTrend?.yoyChangePercent       || null,
    Monthly_Trend_Month:     monthlyTrend?.monthName              || null,
    Monthly_Trend_Actual:    monthlyTrend?.previousMonthActual    || null,
    Monthly_Trend_LY:        monthlyTrend?.previousMonthLastYear  || null,
    Monthly_Trend_YoY_Pct:   monthlyTrend?.yoyChangePercent      || null,

    // Warnings
    Meta: {
      Warnings: warnings.length > 0 ? warnings : null
    },

    Hotel_Name:          hotelName,
    Forecast_Created_At: forecastCreatedAt
  }
};

// ── Log ───────────────────────────────────────────────────────────────────────
const totalRN  = weeklyForecast.reduce((s, w) => s + w.roomNightsFinal, 0);
const totalRev = weeklyForecast.reduce((s, w) => s + w.estTotalRevenue, 0);
console.log(`✅ AI Processor V11: ${weeklyForecast.length} weeks | ${totalRN} RN | €${totalRev.toFixed(0)}`);
if (warnings.length > 0) console.warn('⚠️ Warnings:', warnings.join('; '));

return [...weekOutputItems, summaryItem];
