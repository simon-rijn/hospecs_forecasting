/**
 * Hotel Revenue Forecasting System - Module 3b: AI Forecast Processor (V10)
 *
 * Runs AFTER the AI HTTP Request node.
 *
 * Takes:
 *   - $input.all(): merged items from two connected nodes:
 *       1. AI Forecast (OpenAI) — OpenAI Responses API output
 *          item.json.output[0].content[0].text  → the JSON string
 *       2. Forecasting engine — engine output
 *          item.json.success, .forecast, .weeklyAiInput, .hotelInfo, .warnings
 *     Each item is identified by its shape (see detection logic below).
 *
 * Older single-input fallback: if only the OpenAI item is in $input,
 * the processor tries $('Forecasting engine') as a last resort.
 *
 * Does:
 *   1. Detect and extract the OpenAI text and engine data from merged inputs
 *   2. Parse and validate schema: weeks array, weekKey + forecastedRoomNights per entry
 *   3. Validate each week: >= OTB, <= capacity, within 30% of historical avg (warn if not)
 *   4. Distribute weekly AI estimates proportionally to daily room nights
 *   5. Recalculate all revenue metrics for each day
 *   6. Output format expected by "hotel forecasting output" node
 *
 * Throws on schema errors. Per-week fallback to traditional applies only when
 * a weekKey is absent from the AI response.
 */

// ============ N8N EXECUTION CODE ============

// --- Detect items from merged inputs ---
// "AI Forecast (OpenAI)" and "Forecasting engine" are both wired into this node.
// n8n merges their outputs; we identify each item by its JSON shape.
const allInputs = $input.all();

// Engine item: has .success (boolean) and .forecast (array)
const engineItem = allInputs.find(item =>
  typeof item.json?.success === 'boolean' && Array.isArray(item.json?.forecast)
);

// OpenAI item: has .output (array) — OpenAI Responses API format
const aiItem = allInputs.find(item => Array.isArray(item.json?.output));

// Resolve engine output — with fallback to $() for older single-input deployments
let engineOutput;
if (engineItem) {
  engineOutput = engineItem.json;
} else {
  try {
    engineOutput = $('Forecasting engine').all()[0].json;
  } catch (e) {
    throw new Error(
      'AI Forecast Processor: cannot access "Forecasting engine" data.\n' +
      'Fix: open the workflow editor, draw a connection from "Forecasting engine" ' +
      'to "AI Forecast Processor" (in addition to the existing connection to the OpenAI node).\n' +
      `Underlying error: ${e.message}`
    );
  }
}

if (!engineOutput.success) {
  throw new Error('Cannot process AI forecast — engine step failed: ' + (engineOutput.error || 'unknown'));
}

const dailyForecast = engineOutput.forecast;
const weeklyAiInput = engineOutput.weeklyAiInput;
const hotelInfo = engineOutput.hotelInfo;
const warnings = [...(engineOutput.warnings || [])];

// --- Extract text from OpenAI Responses API output ---
// Structure: { output: [{ content: [{ type: "output_text", text: "..." }] }] }
// JSON mode is enabled on the node, so the text is guaranteed to be valid JSON.
const aiResponse = aiItem?.json ?? $input.first().json;

const rawText =
  aiResponse?.output?.[0]?.content?.[0]?.text ||   // OpenAI Responses API (n8n 1.120+)
  aiResponse?.message?.content;                     // Chat Completions fallback

if (!rawText) {
  throw new Error(
    'AI Forecast Processor: no text content in OpenAI response.\n' +
    `Received keys: ${Object.keys(aiResponse || {}).join(', ') || 'none'}.\n` +
    'Check that the AI Forecast (OpenAI) node succeeded and that JSON mode is enabled.'
  );
}

// --- Parse and validate schema ---
// No regex needed — JSON mode guarantees the string is valid JSON.
let parsed;
try {
  parsed = JSON.parse(rawText);
} catch (err) {
  throw new Error(`AI Forecast Processor: JSON.parse failed despite JSON mode — ${err.message}. Raw: ${rawText.slice(0, 200)}`);
}

if (!parsed.weeks || !Array.isArray(parsed.weeks) || parsed.weeks.length === 0) {
  throw new Error(`AI Forecast Processor: response missing "weeks" array. Got: ${JSON.stringify(parsed).slice(0, 200)}`);
}

// Validate each entry has the required fields
const malformed = parsed.weeks.filter(w => !w.weekKey || typeof w.forecastedRoomNights !== 'number');
if (malformed.length > 0) {
  throw new Error(
    `AI Forecast Processor: ${malformed.length} week(s) missing weekKey or forecastedRoomNights (must be a number). ` +
    `First bad entry: ${JSON.stringify(malformed[0])}`
  );
}

// Build week → forecasted RN map
const aiWeeklyMap = new Map();
parsed.weeks.forEach(w => {
  aiWeeklyMap.set(w.weekKey, {
    forecastedRoomNights: Math.round(w.forecastedRoomNights),
    confidence: w.confidence || 'medium',
    note: w.note || ''
  });
});

console.log(`✅ AI response parsed: ${aiWeeklyMap.size} weeks`);

// --- Get ISO week key helper ---
function getIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// --- Build week-level context map for validation ---
const weekContext = new Map();
if (weeklyAiInput?.weeks) {
  weeklyAiInput.weeks.forEach(w => {
    weekContext.set(w.weekKey, w);
  });
}

// --- Group daily forecast by ISO week ---
const weekDayGroups = new Map();
dailyForecast.forEach(day => {
  const wk = getIsoWeekKey(new Date(day.stayDate));
  if (!weekDayGroups.has(wk)) weekDayGroups.set(wk, []);
  weekDayGroups.get(wk).push(day);
});

// --- Determine final weekly room nights (AI or traditional fallback) ---
const weekFinalRn = new Map();

weekDayGroups.forEach((days, weekKey) => {
  const traditionalTotal = days.reduce((s, d) => s + d.roomNightsFinal, 0);
  const ctx = weekContext.get(weekKey);
  const ai = aiWeeklyMap?.get(weekKey);

  if (!ai) {
    // No AI estimate for this week — use traditional
    weekFinalRn.set(weekKey, { roomNights: traditionalTotal, source: 'traditional' });
    return;
  }

  let aiRn = ai.forecastedRoomNights;
  const weekOtb = ctx?.currentOtbRoomNights ?? 0;
  const weekCapacity = ctx?.capacity ?? (days.length * (hotelInfo.maxRooms || 120));
  const histAvg = ctx?.historicalAvgRoomNights ?? traditionalTotal;

  // Validation bounds
  const lowerBound = weekOtb; // cannot be below OTB
  const upperBound = weekCapacity; // cannot exceed capacity
  const histLower = histAvg * 0.7;
  const histUpper = histAvg * 1.3;

  if (aiRn < lowerBound) {
    warnings.push(`${weekKey}: AI forecast (${aiRn} RN) below OTB (${weekOtb}). Clamped to OTB.`);
    aiRn = lowerBound;
  }

  if (aiRn > upperBound) {
    warnings.push(`${weekKey}: AI forecast (${aiRn} RN) exceeds capacity (${weekCapacity}). Clamped to capacity.`);
    aiRn = upperBound;
  }

  if (aiRn < histLower || aiRn > histUpper) {
    warnings.push(
      `${weekKey}: AI forecast (${aiRn} RN) deviates >30% from historical avg (${histAvg} RN). ` +
      `Note: "${ai.note || 'none'}". Confidence: ${ai.confidence}.`
    );
  }

  weekFinalRn.set(weekKey, { roomNights: Math.round(aiRn), source: 'ai', confidence: ai.confidence, note: ai.note });
});

// --- Distribute weekly room nights proportionally to daily ---
const finalForecast = dailyForecast.map(day => {
  const weekKey = getIsoWeekKey(new Date(day.stayDate));
  const weekInfo = weekFinalRn.get(weekKey);
  const weekDays = weekDayGroups.get(weekKey);

  const weekTraditionalTotal = weekDays.reduce((s, d) => s + d.roomNightsFinal, 0);
  const weekTargetTotal = weekInfo?.roomNights ?? weekTraditionalTotal;

  // Proportional allocation: day's share of traditional × week target
  let adjustedRn;
  if (weekTraditionalTotal > 0) {
    adjustedRn = Math.round((day.roomNightsFinal / weekTraditionalTotal) * weekTargetTotal);
  } else {
    adjustedRn = Math.round(weekTargetTotal / weekDays.length);
  }

  // Never go below OTB for a single day
  adjustedRn = Math.max(adjustedRn, day.otbRoomNights);
  // Never exceed available rooms for a single day
  adjustedRn = Math.min(adjustedRn, day.availableRooms);

  const pickup = Math.max(0, adjustedRn - day.otbRoomNights);

  // Revenue: OTB + pickup at current or expected ADR
  const pickupADR = day.otbADR != null ? day.otbADR : day.expectedADR;
  const roomRevenue = day.otbRoomRevenue + (pickup * pickupADR);

  // F&B and Other from day's existing ratios (already in day object via forecasting engine)
  const fbRatio = day.fbRevenue / (day.roomRevenue || 1);
  const otherRatio = day.otherRevenue / (day.roomRevenue || 1);
  const fbRevenue = roomRevenue * fbRatio;
  const otherRevenue = roomRevenue * otherRatio;
  const totalRevenue = roomRevenue + fbRevenue + otherRevenue;

  const occupancy = (adjustedRn / day.availableRooms) * 100;
  const revpar = roomRevenue / day.availableRooms;
  const trevpar = totalRevenue / day.availableRooms;
  const fbRevpar = fbRevenue / day.availableRooms;
  const otherRevpar = otherRevenue / day.availableRooms;

  return {
    stayDate: day.stayDate,
    weekday: day.weekday,
    daysUntilArrival: day.daysUntilArrival,

    roomNightsFinal: adjustedRn,
    pickup,

    roomRevenue,
    fbRevenue,
    otherRevenue,
    totalRevenue,

    historicalADR: day.historicalADR,
    expectedADR: day.expectedADR,
    otbADR: day.otbADR,
    occupancy,
    revpar,
    fbRevpar,
    trevpar,
    otherRevpar,

    otbRoomNights: day.otbRoomNights,
    otbRoomRevenue: day.otbRoomRevenue,
    otbTotalRevenue: day.otbTotalRevenue,

    forecastSource: weekInfo?.source ?? 'traditional',
    forecastNote: weekInfo?.note ?? ''
  };
});

const totalRN = finalForecast.reduce((s, d) => s + d.roomNightsFinal, 0);
const totalRev = finalForecast.reduce((s, d) => s + d.totalRevenue, 0);
const aiWeeks = [...weekFinalRn.values()].filter(w => w.source === 'ai').length;
const tradWeeks = [...weekFinalRn.values()].filter(w => w.source === 'traditional').length;

console.log(`✅ AI Processor: ${totalRN} RN, €${totalRev.toFixed(0)} | AI weeks: ${aiWeeks}, Traditional fallback: ${tradWeeks}`);
if (warnings.length > 0) console.warn('⚠️ Warnings:', warnings.join('; '));

return [{
  json: {
    success: true,
    forecast: finalForecast,
    warnings,
    hotelInfo
  }
}];
