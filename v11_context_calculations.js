/**
 * Hotel Revenue Forecasting System - Module 5: Context Calculations (V11)
 *
 * Runs AFTER the AI Forecast Processor node.
 * Input: the 12 "week" rows + 1 "summary" row produced by v11_ai_processor.js
 *
 * Computes derived context that is relevant for reporting but is not part of
 * the core forecast algorithm. Outputs one additional item with Row_Type = "context".
 *
 * Calculations:
 *   Weekly_Context    — per-week derived metrics
 *     - Days_To_Fill            : total days remaining before week closes
 *     - Required_Daily_Pickup   : pickup needed ÷ days to fill
 *     - ADR_Delta               : OTB ADR minus historical ADR fallback (€)
 *     - ADR_Delta_Pct           : same as percentage
 *     - Risk_Level              : null | 'medium' | 'high'
 *     - Risk_Reason             : human-readable explanation when risk flagged
 *
 *   Monthly_Aggregates — forecast weeks rolled up to calendar months
 *     - Month, Month_Name, Week_Count
 *     - OTB_Room_Nights, Forecast_Room_Nights, Pickup_Remaining
 *     - Capacity_Room_Nights, Occupancy_Pct
 *     - Est_Room_Revenue, Est_FB_Revenue, Est_Other_Revenue, Est_Total_Revenue
 *
 *   Overall_Context   — 12-week totals and summary statistics
 *     - Total_Forecast_RN, Total_OTB_RN, Total_Pickup_Needed
 *     - Total_Est_Revenue, Avg_Occupancy_Pct
 *     - Weeks_At_Risk (count of medium + high risk weeks)
 *     - Highest_Risk_Week
 */

// ============ N8N EXECUTION CODE ============

const allItems = $input.all();

// Extract only the week rows (skip summary and any other row types)
const weekRows = allItems
  .map(item => item.json)
  .filter(row => row.Row_Type === 'week');

if (weekRows.length === 0) {
  throw new Error('Context Calculations V11: no week rows found in input.');
}

const forecastCreatedAt = weekRows[0].Forecast_Created_At;
const hotelName         = weekRows[0].Hotel_Name;

// ─── 1. Weekly Context ────────────────────────────────────────────────────────

const weeklyContext = weekRows.map(week => {
  const meta             = week.Meta || {};
  const daysUntilStart   = meta.Days_Until_Week_Start ?? 0;
  const daysElapsed      = week.Days_Elapsed          ?? 0;
  const otbFillRate      = meta.OTB_Fill_Rate         ?? null;
  const pickup           = week.Pickup                ?? 0;
  const otbADR           = week.OTB_ADR;
  const historicalADR    = meta.Historical_ADR_Fallback ?? null;

  // Days remaining until the week closes (Sunday end-of-day)
  // = days until Monday + remaining days in the week (excl. already elapsed)
  const daysToFill = Math.max(1, daysUntilStart + (7 - daysElapsed));

  // Required daily pickup to hit the forecast
  const requiredDailyPickup = parseFloat((pickup / daysToFill).toFixed(1));

  // ADR comparison — only meaningful when OTB ADR is available (OTB ≥ 10 nights)
  let adrDelta    = null;
  let adrDeltaPct = null;
  if (otbADR != null && historicalADR != null && historicalADR > 0) {
    adrDelta    = parseFloat((otbADR - historicalADR).toFixed(2));
    adrDeltaPct = parseFloat(((adrDelta / historicalADR) * 100).toFixed(1));
  }

  // Risk classification
  // High:   fill rate < 25% AND week starts within 14 days
  // Medium: fill rate < 45% AND week starts within 21 days
  let riskLevel  = null;
  let riskReason = null;

  if (otbFillRate !== null && daysUntilStart <= 14 && otbFillRate < 0.25) {
    riskLevel  = 'high';
    riskReason =
      `OTB fill rate ${(otbFillRate * 100).toFixed(0)}% with only ${daysUntilStart} days until week start. ` +
      `${pickup} nights still needed.`;
  } else if (otbFillRate !== null && daysUntilStart <= 21 && otbFillRate < 0.45) {
    riskLevel  = 'medium';
    riskReason =
      `OTB fill rate ${(otbFillRate * 100).toFixed(0)}% with ${daysUntilStart} days until week start. ` +
      `${pickup} nights still needed.`;
  }

  return {
    Week_Key:              week.Week_Key,
    Week_Start:            week.Week_Start,
    Week_End:              week.Week_End,
    Days_To_Fill:          daysToFill,
    Required_Daily_Pickup: requiredDailyPickup,
    ADR_Delta:             adrDelta,
    ADR_Delta_Pct:         adrDeltaPct,
    Risk_Level:            riskLevel,
    Risk_Reason:           riskReason
  };
});

// ─── 2. Monthly Aggregates ────────────────────────────────────────────────────

// Assign each week to a calendar month using its Thursday (ISO convention:
// the week "belongs" to the month that contains Thursday).
function getThursdayMonth(weekStartStr) {
  const monday   = new Date(weekStartStr);
  const thursday = new Date(monday);
  thursday.setDate(thursday.getDate() + 3);
  const year  = thursday.getFullYear();
  const month = thursday.getMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

const monthNames = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const monthMap = new Map();

weekRows.forEach(week => {
  const monthKey = getThursdayMonth(week.Week_Start);
  if (!monthMap.has(monthKey)) {
    monthMap.set(monthKey, {
      Month:                monthKey,
      Month_Name:           null, // set below
      Week_Count:           0,
      OTB_Room_Nights:      0,
      Forecast_Room_Nights: 0,
      Pickup_Remaining:     0,
      Capacity_Room_Nights: 0,
      Est_Room_Revenue:     0,
      Est_FB_Revenue:       0,
      Est_Other_Revenue:    0,
      Est_Total_Revenue:    0
    });
  }

  const m = monthMap.get(monthKey);
  m.Week_Count           += 1;
  m.OTB_Room_Nights      += week.OTB_Room_Nights      ?? 0;
  m.Forecast_Room_Nights += week.Room_Nights_Final     ?? 0;
  m.Pickup_Remaining     += week.Pickup                ?? 0;
  m.Capacity_Room_Nights += week.Capacity_Room_Nights  ?? 0;
  m.Est_Room_Revenue     += week.Est_Room_Revenue       ?? 0;
  m.Est_FB_Revenue       += week.Est_FB_Revenue         ?? 0;
  m.Est_Other_Revenue    += week.Est_Other_Revenue      ?? 0;
  m.Est_Total_Revenue    += week.Est_Total_Revenue      ?? 0;
});

const monthlyAggregates = Array.from(monthMap.values()).map(m => {
  const [yearStr, monStr] = m.Month.split('-');
  m.Month_Name    = `${monthNames[parseInt(monStr) - 1]} ${yearStr}`;
  m.Occupancy_Pct = m.Capacity_Room_Nights > 0
    ? parseFloat((m.Forecast_Room_Nights / m.Capacity_Room_Nights * 100).toFixed(1))
    : null;

  // Round revenue totals
  m.Est_Room_Revenue  = Math.round(m.Est_Room_Revenue);
  m.Est_FB_Revenue    = Math.round(m.Est_FB_Revenue);
  m.Est_Other_Revenue = Math.round(m.Est_Other_Revenue);
  m.Est_Total_Revenue = Math.round(m.Est_Total_Revenue);

  return m;
});

// ─── 3. Overall 12-Week Context ───────────────────────────────────────────────

const totalForecastRN = weekRows.reduce((s, w) => s + (w.Room_Nights_Final    ?? 0), 0);
const totalOTBRN      = weekRows.reduce((s, w) => s + (w.OTB_Room_Nights      ?? 0), 0);
const totalPickup     = weekRows.reduce((s, w) => s + (w.Pickup               ?? 0), 0);
const totalCapacity   = weekRows.reduce((s, w) => s + (w.Capacity_Room_Nights ?? 0), 0);
const totalRevenue    = weekRows.reduce((s, w) => s + (w.Est_Total_Revenue     ?? 0), 0);

const avgOccupancy = totalCapacity > 0
  ? parseFloat((totalForecastRN / totalCapacity * 100).toFixed(1))
  : null;

const atRiskWeeks     = weeklyContext.filter(w => w.Risk_Level !== null);
const highRiskWeeks   = weeklyContext.filter(w => w.Risk_Level === 'high');
const highestRiskWeek = highRiskWeeks.length > 0 ? highRiskWeeks[0].Week_Key : null;

const overallContext = {
  Total_Forecast_RN:  totalForecastRN,
  Total_OTB_RN:       totalOTBRN,
  Total_Pickup_Needed: totalPickup,
  Total_Capacity_RN:  totalCapacity,
  Total_Est_Revenue:  Math.round(totalRevenue),
  Avg_Occupancy_Pct:  avgOccupancy,
  Overall_Fill_Rate:  totalForecastRN > 0
    ? parseFloat((totalOTBRN / totalForecastRN).toFixed(3))
    : null,
  Weeks_At_Risk:      atRiskWeeks.length,
  Highest_Risk_Week:  highestRiskWeek
};

// ─── Output ───────────────────────────────────────────────────────────────────

console.log(
  `✅ Context Calculations V11: ${weekRows.length} weeks | ` +
  `${monthlyAggregates.length} months | ` +
  `${atRiskWeeks.length} at-risk weeks | ` +
  `Total forecast: ${totalForecastRN} RN, €${Math.round(totalRevenue).toLocaleString()} revenue`
);

return [{
  json: {
    Row_Type: 'context',

    Weekly_Context:     weeklyContext,
    Monthly_Aggregates: monthlyAggregates,
    Overall_Context:    overallContext,

    Hotel_Name:          hotelName,
    Forecast_Created_At: forecastCreatedAt
  }
}];
