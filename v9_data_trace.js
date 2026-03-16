/**
 * Data Trace Node - Extracts filterable data for fact-checking calculations
 *
 * Place AFTER Data Parser, parallel to Historical Analysis
 * Takes Data Parser output and extracts data used in calculations
 *
 * Output items have 'traceType' field for filtering:
 * - "config" (1 item): Hotel info, growth trend, forecast date range
 * - "event" (1 per event): Events with dates and impacts
 * - "seasonal_window" (1 per historical day in window): Days used for baselines
 * - "weekday_sample" (7 items): Aggregated stats per weekday from seasonal window
 * - "otb_day" (1 per OTB day): OTB input data for each forecast day
 *
 * Fact-checking examples:
 * - Filter traceType="weekday_sample" to see baseline calculation inputs
 * - Filter traceType="seasonal_window" AND weekday="Monday" to see all Mondays used
 * - Filter traceType="otb_day" AND date="2024-03-15" to see OTB for that date
 */

const input = $input.first().json;

// Data Parser output structure
const parseResult = input;
const data = parseResult.data;

if (!data) {
  return [{ json: { traceType: 'error', message: 'No parsed data found in input' } }];
}

const output = [];

// ============ 1. CONFIG ============
const hotelInfo = data.hotelInfo || {};
const currentHousestate = data.currentHousestate || [];
const historicalHousestate = data.historicalHousestate || [];

// Determine forecast start date (first OTB date)
const forecastStartDate = currentHousestate.length > 0
  ? new Date(currentHousestate[0].date)
  : new Date();

// Calculate seasonal window: 1 year ago, -30 to +60 days
const oneYearAgo = new Date(forecastStartDate);
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

const windowStart = new Date(oneYearAgo);
windowStart.setDate(windowStart.getDate() - 30);

const windowEnd = new Date(oneYearAgo);
windowEnd.setDate(windowEnd.getDate() + 60);

output.push({
  traceType: 'config',
  hotelName: hotelInfo.hotelName || 'Unknown',
  maxRooms: hotelInfo.maxRooms || 0,
  growthTrend: hotelInfo.growthTrend || 1.0,
  forecastStartDate: forecastStartDate.toISOString().split('T')[0],
  forecastDays: currentHousestate.length,
  seasonalWindow: {
    targetDate: oneYearAgo.toISOString().split('T')[0],
    windowStart: windowStart.toISOString().split('T')[0],
    windowEnd: windowEnd.toISOString().split('T')[0],
    description: '30 days before to 60 days after (forecast start - 1 year)'
  },
  historicalDaysTotal: historicalHousestate.length,
  parserWarnings: parseResult.warnings?.length || 0,
  parserErrors: parseResult.errors?.length || 0
});

// ============ 2. EVENTS ============
const events = data.events || [];
events.forEach((event, idx) => {
  output.push({
    traceType: 'event',
    eventIndex: idx + 1,
    eventName: event.eventName,
    startDate: event.startDate ? new Date(event.startDate).toISOString().split('T')[0] : null,
    endDate: event.endDate ? new Date(event.endDate).toISOString().split('T')[0] : null,
    pickupImpact: event.pickupImpact,
    overrideMaxRooms: event.overrideMaxRooms
  });
});

// ============ 3. SEASONAL WINDOW DAYS ============
// Filter historical data to the seasonal window
const seasonalDays = historicalHousestate.filter(day => {
  if (!day.date) return false;
  const d = new Date(day.date);
  return d >= windowStart && d <= windowEnd && !day.isOutlier;
});

// Group by weekday for baseline calculation trace
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const weekdayGroups = {};
weekdays.forEach(wd => { weekdayGroups[wd] = []; });

seasonalDays.forEach((day, idx) => {
  const weekday = day.weekday || 'Unknown';
  const dateStr = new Date(day.date).toISOString().split('T')[0];
  const adr = day.roomNights > 0 ? day.roomRevenue / day.roomNights : null;

  const dayTrace = {
    traceType: 'seasonal_window',
    windowIndex: idx + 1,
    date: dateStr,
    weekday: weekday,
    roomNights: day.roomNights,
    roomRevenue: Math.round(day.roomRevenue * 100) / 100,
    totalRevenue: Math.round(day.totalRevenue * 100) / 100,
    fbRevenue: day.fbRevenue != null ? Math.round(day.fbRevenue * 100) / 100 : null,
    otherRevenue: day.otherRevenue != null ? Math.round(day.otherRevenue * 100) / 100 : null,
    adr: adr != null ? Math.round(adr * 100) / 100 : null,
    isOutlier: day.isOutlier || false
  };

  output.push(dayTrace);

  if (weekdayGroups[weekday]) {
    weekdayGroups[weekday].push(day);
  }
});

// ============ 4. WEEKDAY SAMPLES (Baseline Calculation Trace) ============
weekdays.forEach(weekday => {
  const days = weekdayGroups[weekday];
  if (days.length === 0) {
    output.push({
      traceType: 'weekday_sample',
      weekday: weekday,
      sampleSize: 0,
      warning: 'No data in seasonal window for this weekday'
    });
    return;
  }

  const roomNightsArr = days.map(d => d.roomNights);
  const roomRevenueArr = days.map(d => d.roomRevenue);
  const totalRevenueArr = days.map(d => d.totalRevenue);

  const avgRoomNights = roomNightsArr.reduce((a, b) => a + b, 0) / days.length;
  const avgRoomRevenue = roomRevenueArr.reduce((a, b) => a + b, 0) / days.length;
  const avgTotalRevenue = totalRevenueArr.reduce((a, b) => a + b, 0) / days.length;
  const historicalADR = avgRoomRevenue / avgRoomNights;

  // Growth-adjusted values (what forecasting engine will use)
  const growthTrend = hotelInfo.growthTrend || 1.0;
  const expectedADR = historicalADR * growthTrend;
  const expectedRoomNights = avgRoomNights * growthTrend;

  output.push({
    traceType: 'weekday_sample',
    weekday: weekday,
    sampleSize: days.length,
    sampleSizeWarning: days.length < 4 ? 'Low sample size (< 4 weeks)' : null,

    // Raw historical averages (baseline)
    historicalAvgRoomNights: Math.round(avgRoomNights * 100) / 100,
    historicalAvgRoomRevenue: Math.round(avgRoomRevenue * 100) / 100,
    historicalAvgTotalRevenue: Math.round(avgTotalRevenue * 100) / 100,
    historicalADR: Math.round(historicalADR * 100) / 100,

    // Growth-adjusted (what forecast uses for >30 days out)
    growthTrend: growthTrend,
    expectedRoomNights: Math.round(expectedRoomNights * 100) / 100,
    expectedADR: Math.round(expectedADR * 100) / 100,

    // Individual data points (dates only, for reference)
    sampleDates: days.slice(0, 10).map(d => new Date(d.date).toISOString().split('T')[0]),

    // Min/max for sanity check
    roomNightsRange: {
      min: Math.min(...roomNightsArr),
      max: Math.max(...roomNightsArr)
    }
  });
});

// ============ 5. OTB DAYS ============
currentHousestate.forEach((day, idx) => {
  const dateStr = new Date(day.date).toISOString().split('T')[0];
  const otbADR = day.roomNights > 0 ? day.roomRevenue / day.roomNights : null;

  // Check if any events apply to this day
  const applicableEvents = events.filter(event => {
    if (!event.startDate || !event.endDate) return false;
    const dayDate = new Date(day.date);
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);
    return dayDate >= startDate && dayDate <= endDate;
  });

  output.push({
    traceType: 'otb_day',
    dayIndex: idx + 1,
    daysUntilArrival: idx, // Approximate, actual calculation may differ
    date: dateStr,
    weekday: day.weekday,

    // OTB input values
    otbRoomNights: day.roomNights,
    otbRoomRevenue: Math.round(day.roomRevenue * 100) / 100,
    otbTotalRevenue: Math.round(day.totalRevenue * 100) / 100,
    otbFBRevenue: day.fbRevenue != null ? Math.round(day.fbRevenue * 100) / 100 : null,
    otbOtherRevenue: day.otherRevenue != null ? Math.round(day.otherRevenue * 100) / 100 : null,
    otbADR: otbADR != null ? Math.round(otbADR * 100) / 100 : null,

    // Events affecting this day
    hasEvents: applicableEvents.length > 0,
    eventNames: applicableEvents.map(e => e.eventName),
    totalEventPickup: applicableEvents.reduce((sum, e) => sum + (e.pickupImpact || 0), 0),
    capacityOverride: applicableEvents.find(e => e.overrideMaxRooms != null)?.overrideMaxRooms || null,

    // Method indicator
    forecastMethod: idx <= 30 ? 'curve-based (≤30 days)' : 'traditional (>30 days)'
  });
});

// ============ 6. TRACE SUMMARY ============
output.push({
  traceType: 'trace_summary',
  configItems: 1,
  eventItems: events.length,
  seasonalWindowItems: seasonalDays.length,
  weekdaySampleItems: 7,
  otbDayItems: currentHousestate.length,
  totalItems: output.length + 1,

  filterExamples: [
    'traceType = "weekday_sample" → See baseline calculations per weekday',
    'traceType = "seasonal_window" AND weekday = "Monday" → See all Mondays in baseline',
    'traceType = "otb_day" → See all OTB input data',
    'traceType = "otb_day" AND hasEvents = true → See days with events',
    'traceType = "otb_day" AND date = "YYYY-MM-DD" → See specific day'
  ]
});

// Return as array of items for n8n
return output.map(item => ({ json: item }));
