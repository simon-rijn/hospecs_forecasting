/**
 * Hotel Revenue Forecasting System - Module 3b: AI Forecast Processor (V10)
 *
 * Runs AFTER the AI HTTP Request node.
 *
 * Takes:
 *   - $input.first(): OpenAI node response with JSON mode enabled
 *     { message: { content: "..." } } — guaranteed valid JSON by the API
 *   - $('Forecasting engine').all()[0].json: Forecasting engine output
 *     { success, forecast (daily traditional), weeklyAiInput, hotelInfo, warnings }
 *
 * Does:
 *   1. Extract and parse the JSON string from message.content (no regex needed — JSON mode guarantees validity)
 *   2. Validate schema: weeks array present, each entry has weekKey + forecastedRoomNights (integer)
 *   3. Validate each week: >= OTB, <= capacity, within 30% of historical avg (warn if not)
 *   4. Distribute weekly AI estimates proportionally to daily room nights
 *   5. Recalculate all revenue metrics for each day
 *   6. Output format expected by "hotel forecasting output" node
 *
 * If AI response is missing or schema is invalid, throws — does NOT silently fall back.
 * Per-week fallback still applies when a specific weekKey is absent from the AI response.
 */

// ============ N8N EXECUTION CODE ============

// Forecasting engine output (referenced directly by node name)
const engineOutput = $('Forecasting engine').all()[0].json;

// AI HTTP response (direct input to this node)
const aiResponse = $input.first().json;

if (!engineOutput.success) {
  throw new Error('Cannot process AI forecast — engine step failed: ' + (engineOutput.error || 'unknown'));
}

const dailyForecast = engineOutput.forecast;
const weeklyAiInput = engineOutput.weeklyAiInput;
const hotelInfo = engineOutput.hotelInfo;
const warnings = [...(engineOutput.warnings || [])];

// --- Extract text from n8n OpenAI node output ---
// JSON mode is enabled on the node, so message.content is guaranteed to be valid JSON.
const rawText = aiResponse?.message?.content;

if (!rawText) {
  throw new Error(
    'AI Forecast Processor: no content in OpenAI response. ' +
    'Check that the AI Forecast (OpenAI) node succeeded and that JSON mode (Response Format: json_object) is enabled.'
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
