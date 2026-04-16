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

const { weeklyForecast, hotelInfo, recentTrend, monthlyTrend, historicalMonthly } = engineOutput;
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

if (!Array.isArray(annotations.volume_diagnosis) ||
    !Array.isArray(annotations.week_signals) ||
    !Array.isArray(annotations.data_gaps)) {
  throw new Error(
    `AI Forecast Processor V11: response missing required fields ` +
    `(volume_diagnosis, week_signals, data_gaps). Got: ${JSON.stringify(annotations).slice(0, 300)}`
  );
}

// ── Build week signals lookup: weekKey → { level, diagnosis, action } ────────
const weekSignalsMap = new Map();
annotations.week_signals.forEach(entry => {
  if (entry.week_key) {
    weekSignalsMap.set(entry.week_key, {
      level:     entry.level     || null,
      diagnosis: entry.diagnosis || null,
      action:    entry.action    || null
    });
  }
});

console.log(`✅ AI Layer 1 parsed: ${weekSignalsMap.size} weeks with signals, ` +
  `${annotations.volume_diagnosis.length} volume diagnoses, ` +
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

  const weekSig    = weekSignalsMap.get(week.weekKey) || { level: null, diagnosis: null, action: null };
  const signalParts = [weekSig.diagnosis, weekSig.action].filter(Boolean);
  const signalsStr  = signalParts.length > 0 ? signalParts.join(' → ') : null;

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
      volume_diagnosis: annotations.volume_diagnosis,
      anomalies:        annotations.anomalies || [],
      week_signals:     annotations.week_signals,
      data_gaps:        annotations.data_gaps
    },

    // Historical monthly actuals (past 3 months) — consumed by Report Processor for table
    Historical_Monthly: historicalMonthly || [],

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

// ── Chart row — QuickChart-ready Chart.js config ──────────────────────────────
// Produces a combination bar (OTB) + line (Forecast) + dashed line (LY) chart.
// Wire: AI Processor → QuickChart node  (configure: chart = {{ $json.Chart_Config }},
//       width = {{ $json.Chart_Width }}, height = {{ $json.Chart_Height }})

const chartLabels = weeklyForecast.map(w => {
  // Shorten "2026-W14" → "W14"
  const parts = w.weekKey.split('-W');
  return parts.length === 2 ? `W${parts[1]}` : w.weekKey;
});

const chartConfig = {
  type: 'bar',
  data: {
    labels: chartLabels,
    datasets: [
      // ── 1. Forecast line (green, on top) ─────────────────────────────
      {
        type:                'line',
        label:               'Forecast',
        data:                weeklyForecast.map(w => w.roomNightsFinal),
        borderColor:         '#1A7A4A',
        backgroundColor:     'rgba(26,122,74,0.06)',
        borderWidth:         2.5,
        pointRadius:         4,
        pointBackgroundColor:'#1A7A4A',
        tension:             0.3,
        fill:                false,
        order:               1
      },
      // ── 2. Vorig jaar LY line (grey dashed) ──────────────────────────
      {
        type:                'line',
        label:               'Vorig jaar (LY)',
        data:                weeklyForecast.map(w => w.historicalLY ?? null),
        borderColor:         '#9CA3AF',
        backgroundColor:     'transparent',
        borderWidth:         2,
        borderDash:          [6, 4],
        pointRadius:         3,
        pointBackgroundColor:'#9CA3AF',
        tension:             0.3,
        fill:                false,
        order:               2
      },
      // ── 3. OTB huidig bars (blue, background layer) ──────────────────
      {
        type:           'bar',
        label:          'OTB huidig',
        data:           weeklyForecast.map(w => w.otbRoomNights),
        backgroundColor:'rgba(26,79,204,0.72)',
        borderColor:    '#1A4FCC',
        borderWidth:    0,
        order:          3
      }
    ]
  },
  options: {
    responsive: false,   // required for QuickChart server-side rendering
    animation:  false,   // required for QuickChart server-side rendering
    plugins: {
      title: {
        display: true,
        text:    `OTB-vergelijking 12 weken — ${hotelName}`,
        font:    { size: 14, weight: 'bold' },
        color:   '#1A4FCC',
        padding: { top: 8, bottom: 14 }
      },
      legend: {
        display:  true,
        position: 'bottom',
        labels: {
          font:           { size: 11 },
          color:          '#374151',
          padding:        18,
          usePointStyle:  true,
          pointStyleWidth:14
        }
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text:    'Kamernachten',
          font:    { size: 11 },
          color:   '#6B7280'
        },
        grid:  { color: 'rgba(0,0,0,0.06)' },
        ticks: { font: { size: 10 }, color: '#6B7280' }
      },
      x: {
        title: {
          display: true,
          text:    'ISO-week',
          font:    { size: 11 },
          color:   '#6B7280'
        },
        grid:  { display: false },
        ticks: { font: { size: 10 }, color: '#374151' }
      }
    }
  }
};

// Pre-built HTTP Request body for QuickChart.io POST API.
// Wire: AI Processor → [Filter Row_Type='chart'] → HTTP Request node
// HTTP Request node config:
//   Method: POST
//   URL: https://quickchart.io/chart
//   Body Content Type: JSON
//   JSON Body: {{ $json.Chart_Request_Body }}
//   Response Format: File  (returns binary PNG)
const chartRequestBody = {
  chart:           chartConfig,
  width:           900,
  height:          420,
  backgroundColor: 'white',
  format:          'base64'   // returns JSON { data: "data:image/png;base64,..." } — no binary handling needed
};

const chartItem = {
  json: {
    Row_Type:          'chart',
    Chart_Config:      chartConfig,
    Chart_Request_Body: chartRequestBody,
    Chart_Width:       900,
    Chart_Height:      420,
    Hotel_Name:          hotelName,
    Forecast_Created_At: forecastCreatedAt
  }
};

// ── Log ───────────────────────────────────────────────────────────────────────
const totalRN  = weeklyForecast.reduce((s, w) => s + w.roomNightsFinal, 0);
const totalRev = weeklyForecast.reduce((s, w) => s + w.estTotalRevenue, 0);
console.log(`✅ AI Processor V11: ${weeklyForecast.length} weeks | ${totalRN} RN | €${totalRev.toFixed(0)}`);
if (warnings.length > 0) console.warn('⚠️ Warnings:', warnings.join('; '));

return [...weekOutputItems, summaryItem, chartItem];
