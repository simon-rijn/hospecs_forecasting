// Analysis Output v0.12 — 2026-05-18
/**
 * Hotel Revenue Forecasting System - V11: Historical Analysis Input Export
 *
 * Purpose:
 *   Extracts exactly the data fields consumed by v11_historical_analysis.js —
 *   nothing more, nothing less — so the inputs can be inspected, spot-checked,
 *   or used to validate the analysis output.
 *
 * Fields exported per dataset:
 *
 *   historicalHousestate (per row):
 *     date, weekday, roomNights, roomRevenue, totalRevenue, fbRevenue,
 *     otherRevenue, isOutlier
 *     → used by: weekdayBaselines, revenueRatios, weeklyHistoricalData,
 *                recentTrend (via weeklyHistoricalData), monthlyTrend,
 *                filterToCalendarPeriod
 *
 *   currentHousestate (per row):
 *     date
 *     → used by: getForecastCalendarWindow (sets the seasonal filter window)
 *
 *   historicalReservations (per row):
 *     arrivalDate, nights, status, cancelledAt, groupName, channel,
 *     averagePrice, leadtime
 *     → used by: segmentation, channelBreakdown, leadtimeProfile,
 *                cancellationProfile, avgPriceBySegment
 *
 *   reservationsDataFreshness:
 *     → passed through to analysis output as-is
 */

const parseResult = $input.first().json;

if (!parseResult.success) {
  throw new Error('Cannot export — upstream parsing failed: ' + (parseResult.errors || []).map(e => e.message).join('; '));
}

const data = parseResult.data;

// ── 1. Historical housestate ─────────────────────────────────────────────────

const historicalHousestate = (data.historicalHousestate || []).map(day => ({
  date:         day.date,
  weekday:      day.weekday,
  roomNights:   day.roomNights,
  roomRevenue:  day.roomRevenue,
  totalRevenue: day.totalRevenue,
  fbRevenue:    day.fbRevenue    ?? null,
  otherRevenue: day.otherRevenue ?? null,
  isOutlier:    day.isOutlier    ?? false
}));

// ── 2. Current housestate (OTB) ──────────────────────────────────────────────

const currentHousestate = (data.currentHousestate || []).map(day => ({
  date: day.date
}));

// ── 3. Historical reservations ───────────────────────────────────────────────

const historicalReservations = (data.historicalReservations || []).map(res => ({
  arrivalDate:   res.arrivalDate,
  nights:        res.nights,
  status:        res.status        ?? null,
  cancelledAt:   res.cancelledAt   ?? null,
  groupName:     res.groupName     ?? null,
  channel:       res.channel       ?? null,
  averagePrice:  res.averagePrice  ?? null,
  leadtime:      res.leadtime      ?? null
}));

// ── 4. Summary statistics (for quick sanity checks) ──────────────────────────

const hsDatesSorted = historicalHousestate
  .filter(d => d.date)
  .map(d => d.date)
  .sort();

const resSorted = historicalReservations
  .filter(r => r.arrivalDate)
  .map(r => r.arrivalDate)
  .sort();

const cancelledCount   = historicalReservations.filter(r => r.cancelledAt != null).length;
const groupCount       = historicalReservations.filter(r => r.groupName != null && !String(r.groupName).startsWith('IDS')).length;
const withLeadtime     = historicalReservations.filter(r => r.leadtime != null).length;
const withPrice        = historicalReservations.filter(r => r.averagePrice != null && r.averagePrice > 0).length;

const totalHSRoomNights = historicalHousestate.reduce((s, d) => s + (d.roomNights || 0), 0);
const outliersCount     = historicalHousestate.filter(d => d.isOutlier).length;

const summary = {
  historicalHousestate: {
    rows:              historicalHousestate.length,
    dateRange:         hsDatesSorted.length > 0
                         ? { from: hsDatesSorted[0], to: hsDatesSorted[hsDatesSorted.length - 1] }
                         : null,
    totalRoomNights:   totalHSRoomNights,
    outliersExcluded:  outliersCount,
    hasFBRevenue:      historicalHousestate.some(d => d.fbRevenue != null),
    hasOtherRevenue:   historicalHousestate.some(d => d.otherRevenue != null)
  },
  currentHousestate: {
    rows:      currentHousestate.length,
    dateRange: currentHousestate.length > 0
                 ? { from: currentHousestate[0].date, to: currentHousestate[currentHousestate.length - 1].date }
                 : null
  },
  historicalReservations: {
    rows:             historicalReservations.length,
    arrivalDateRange: resSorted.length > 0
                        ? { from: resSorted[0], to: resSorted[resSorted.length - 1] }
                        : null,
    cancelled:        cancelledCount,
    groups:           groupCount,
    withLeadtime:     withLeadtime,
    withAveragePrice: withPrice
  },
  reservationsDataFreshness: data.reservationsDataFreshness || 'current'
};

// ── Output ────────────────────────────────────────────────────────────────────

console.log(`✅ Analysis input export:`);
console.log(`   Housestate: ${summary.historicalHousestate.rows} rows | ${summary.historicalHousestate.dateRange?.from} – ${summary.historicalHousestate.dateRange?.to} | ${totalHSRoomNights} total RN | ${outliersCount} outliers`);
console.log(`   OTB:        ${summary.currentHousestate.rows} rows`);
console.log(`   Reservations: ${summary.historicalReservations.rows} rows | ${cancelledCount} cancelled | ${groupCount} groups | ${withLeadtime} with leadtime | ${withPrice} with price`);
console.log(`   Freshness:  ${summary.reservationsDataFreshness}`);

return [{
  json: {
    summary,
    historicalHousestate,
    currentHousestate,
    historicalReservations,
    reservationsDataFreshness: data.reservationsDataFreshness || 'current'
  }
}];
