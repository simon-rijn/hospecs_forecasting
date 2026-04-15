/**
 * Forecast Day Trace - Complete fact-check data for each forecast day
 *
 * Outputs ONE item per forecast day containing ALL data used to calculate it:
 * - OTB input for that day
 * - Historical baseline data (weekday match from seasonal window)
 * - The actual historical days used (for manual verification)
 * - Events affecting that day
 * - Growth trend and booking curve info
 * - Step-by-step calculation trace
 *
 * Usage: Filter by date to get complete fact-check data for one day
 * Example: date = "2024-03-01" → Returns everything needed to verify March 1st forecast
 */

const input = $input.first().json;
const data = input.data;

if (!data) {
  return [{ json: { error: 'No parsed data found in input' } }];
}

const output = [];

// Extract data
const hotelInfo = data.hotelInfo || {};
const currentHousestate = data.currentHousestate || [];
const historicalHousestate = data.historicalHousestate || [];
const events = data.events || [];

const maxRooms = hotelInfo.maxRooms || 100;
const growthTrend = hotelInfo.growthTrend || 1.0;

// Determine forecast start date
const forecastStartDate = currentHousestate.length > 0
  ? new Date(currentHousestate[0].date)
  : new Date();

// Calculate seasonal window
const oneYearAgo = new Date(forecastStartDate);
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

const windowStart = new Date(oneYearAgo);
windowStart.setDate(windowStart.getDate() - 30);

const windowEnd = new Date(oneYearAgo);
windowEnd.setDate(windowEnd.getDate() + 60);

// Filter historical data to seasonal window (excluding outliers)
const seasonalDays = historicalHousestate.filter(day => {
  if (!day.date || day.isOutlier) return false;
  const d = new Date(day.date);
  return d >= windowStart && d <= windowEnd;
});

// Group seasonal days by weekday
const weekdayData = {};
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
weekdays.forEach(wd => { weekdayData[wd] = []; });

seasonalDays.forEach(day => {
  const wd = day.weekday;
  if (weekdayData[wd]) {
    weekdayData[wd].push(day);
  }
});

// Pre-calculate baselines per weekday
const baselines = {};
weekdays.forEach(weekday => {
  const days = weekdayData[weekday];
  if (days.length === 0) {
    baselines[weekday] = null;
    return;
  }

  const avgRoomNights = days.reduce((sum, d) => sum + d.roomNights, 0) / days.length;
  const avgRoomRevenue = days.reduce((sum, d) => sum + d.roomRevenue, 0) / days.length;
  const historicalADR = avgRoomRevenue / avgRoomNights;

  baselines[weekday] = {
    sampleSize: days.length,
    historicalAvgRoomNights: Math.round(avgRoomNights * 100) / 100,
    historicalAvgRoomRevenue: Math.round(avgRoomRevenue * 100) / 100,
    historicalADR: Math.round(historicalADR * 100) / 100,
    expectedRoomNights: Math.round(avgRoomNights * growthTrend * 100) / 100,
    expectedADR: Math.round(historicalADR * growthTrend * 100) / 100
  };
});

// Simple booking curve approximation (matches the 90-checkpoint system)
function getCurvePercentage(daysUntil) {
  // Simplified curve - in reality this comes from historical reservations
  // This is an approximation for trace purposes
  if (daysUntil <= 0) return 100;
  if (daysUntil >= 90) return 5;

  // Rough exponential curve
  const pct = 100 - (90 - daysUntil) * 0.8;
  return Math.max(5, Math.min(100, Math.round(pct)));
}

// Process each OTB day
currentHousestate.forEach((otbDay, idx) => {
  const targetDate = new Date(otbDay.date);
  const dateStr = targetDate.toISOString().split('T')[0];
  const weekday = otbDay.weekday;
  const daysUntilArrival = idx; // Simplified - actual may differ slightly

  // OTB values
  const otbRoomNights = otbDay.roomNights;
  const otbRoomRevenue = otbDay.roomRevenue;
  const otbADR = otbRoomNights > 0 ? otbRoomRevenue / otbRoomNights : null;

  // Baseline for this weekday
  const baseline = baselines[weekday];

  // Historical days used (the actual data points)
  const historicalDaysUsed = weekdayData[weekday] || [];

  // Events affecting this day
  const applicableEvents = events.filter(event => {
    if (!event.startDate || !event.endDate) return false;
    const start = new Date(event.startDate);
    const end = new Date(event.endDate);
    return targetDate >= start && targetDate <= end;
  });

  const totalEventPickup = applicableEvents.reduce((sum, e) => sum + (e.pickupImpact || 0), 0);
  const capacityOverride = applicableEvents.find(e => e.overrideMaxRooms != null && e.overrideMaxRooms > 0)?.overrideMaxRooms || null;
  const effectiveCapacity = capacityOverride || maxRooms;

  // Forecast method
  const forecastMethod = daysUntilArrival > 30 ? 'traditional' : 'curve-based';

  // Build calculation trace
  const calculation = {
    method: forecastMethod,
    steps: []
  };

  let forecastedRoomNights;

  if (forecastMethod === 'traditional') {
    // Traditional: baseline * growth + events
    const baseRoomNights = baseline ? baseline.historicalAvgRoomNights : 0;
    const withGrowth = baseRoomNights * growthTrend;
    const withEvents = withGrowth + totalEventPickup;
    const capped = Math.min(withEvents, effectiveCapacity);

    calculation.steps = [
      `1. Historical baseline for ${weekday}: ${baseRoomNights} room nights (from ${baseline?.sampleSize || 0} samples)`,
      `2. Apply growth trend (${growthTrend}): ${baseRoomNights} × ${growthTrend} = ${Math.round(withGrowth * 100) / 100}`,
      `3. Add event pickup: ${Math.round(withGrowth * 100) / 100} + ${totalEventPickup} = ${Math.round(withEvents * 100) / 100}`,
      `4. Cap at capacity (${effectiveCapacity}): ${Math.round(capped * 100) / 100}`
    ];
    calculation.formula = `(baseline × growth) + eventPickup, capped at capacity`;
    forecastedRoomNights = capped;

  } else {
    // Curve-based: OTB / curve% * growth + events
    const curvePercentage = getCurvePercentage(daysUntilArrival);
    const projectedFromCurve = otbRoomNights / (curvePercentage / 100);
    const withGrowth = projectedFromCurve * growthTrend;
    const withEvents = withGrowth + totalEventPickup;
    const capped = Math.min(withEvents, effectiveCapacity);

    calculation.steps = [
      `1. OTB room nights: ${otbRoomNights}`,
      `2. Booking curve at ${daysUntilArrival} days out: ${curvePercentage}% typically booked`,
      `3. Project final: ${otbRoomNights} ÷ ${curvePercentage}% = ${Math.round(projectedFromCurve * 100) / 100}`,
      `4. Apply growth trend (${growthTrend}): ${Math.round(projectedFromCurve * 100) / 100} × ${growthTrend} = ${Math.round(withGrowth * 100) / 100}`,
      `5. Add event pickup: ${Math.round(withGrowth * 100) / 100} + ${totalEventPickup} = ${Math.round(withEvents * 100) / 100}`,
      `6. Cap at capacity (${effectiveCapacity}): ${Math.round(capped * 100) / 100}`
    ];
    calculation.formula = `(OTB ÷ curvePercentage × growth) + eventPickup, capped at capacity`;
    calculation.curvePercentage = curvePercentage;
    forecastedRoomNights = capped;
  }

  // Calculate pickup
  const pickup = Math.max(0, forecastedRoomNights - otbRoomNights);

  // Build the complete trace item
  output.push({
    // Identification
    date: dateStr,
    weekday: weekday,
    dayIndex: idx + 1,
    daysUntilArrival: daysUntilArrival,

    // OTB Input (what's currently on the books)
    otb: {
      roomNights: otbRoomNights,
      roomRevenue: Math.round(otbRoomRevenue * 100) / 100,
      totalRevenue: Math.round(otbDay.totalRevenue * 100) / 100,
      adr: otbADR != null ? Math.round(otbADR * 100) / 100 : null
    },

    // Baseline used (calculated from historical data)
    baseline: baseline ? {
      weekday: weekday,
      sampleSize: baseline.sampleSize,
      historicalAvgRoomNights: baseline.historicalAvgRoomNights,
      historicalADR: baseline.historicalADR,
      expectedRoomNights: baseline.expectedRoomNights,
      expectedADR: baseline.expectedADR,
      sampleSizeWarning: baseline.sampleSize < 4 ? 'Low sample (< 4 weeks)' : null
    } : { error: 'No baseline data for this weekday' },

    // Historical days used (the actual data points for this weekday)
    historicalDaysUsed: historicalDaysUsed.map(d => ({
      date: new Date(d.date).toISOString().split('T')[0],
      roomNights: d.roomNights,
      roomRevenue: Math.round(d.roomRevenue * 100) / 100,
      adr: d.roomNights > 0 ? Math.round((d.roomRevenue / d.roomNights) * 100) / 100 : null
    })),

    // Events affecting this day
    events: applicableEvents.length > 0 ? {
      count: applicableEvents.length,
      totalPickupImpact: totalEventPickup,
      capacityOverride: capacityOverride,
      details: applicableEvents.map(e => ({
        name: e.eventName,
        pickupImpact: e.pickupImpact,
        overrideMaxRooms: e.overrideMaxRooms
      }))
    } : null,

    // Configuration
    config: {
      maxRooms: maxRooms,
      effectiveCapacity: effectiveCapacity,
      growthTrend: growthTrend,
      forecastMethod: forecastMethod,
      seasonalWindow: {
        start: windowStart.toISOString().split('T')[0],
        end: windowEnd.toISOString().split('T')[0]
      }
    },

    // Calculation trace (step-by-step)
    calculation: calculation,

    // Calculated result (for comparison with actual forecast output)
    calculatedResult: {
      forecastedRoomNights: Math.round(forecastedRoomNights * 100) / 100,
      pickup: Math.round(pickup * 100) / 100,
      note: 'Compare these values with actual forecast output to verify'
    }
  });
});

return output.map(item => ({ json: item }));
