/**
 * Fact Check Node - Complete verification data for AI fact-checking
 *
 * Combines Data Parser output + Historical Analysis output + Forecast output
 * into one comprehensive fact-check item per forecast day.
 *
 * Place after a Merge node that combines:
 * 1. Data Parser output (parsed input data)
 * 2. Historical Analysis output (baselines, curves, ratios)
 * 3. Forecast Output (actual forecast results)
 *
 * Each output item includes:
 * - All inputs used for that day
 * - Baseline calculation trace (with historical housestate data)
 * - Booking curve trace (with historical reservation data)
 * - Revenue ratio trace
 * - Events affecting the day
 * - Actual forecast output
 * - Verification checks
 *
 * Filter by date to get everything needed for AI to verify one day.
 */

const allItems = $input.all();
const allData = allItems.map(item => item.json);

// Find the different data sources
const dataParserOutput = allData.find(d => d.data && d.data.currentHousestate);
const historicalAnalysisOutput = allData.find(d => d.analysis && d.analysis.weekdayBaselines);
const forecastOutputItems = allData.filter(d => d.Stay_Date !== undefined);

// Validate we have all required inputs
const missingInputs = [];
if (!dataParserOutput) missingInputs.push('Data Parser output');
if (!historicalAnalysisOutput) missingInputs.push('Historical Analysis output');
if (forecastOutputItems.length === 0) missingInputs.push('Forecast output');

if (missingInputs.length > 0) {
  return [{
    json: {
      error: 'Missing required inputs',
      missing: missingInputs,
      hint: 'Merge Data Parser, Historical Analysis, and Forecast Output before this node'
    }
  }];
}

const parsedData = dataParserOutput.data;
const analysis = historicalAnalysisOutput.analysis;

// Extract all data sources
const hotelInfo = parsedData.hotelInfo || {};
const currentHousestate = parsedData.currentHousestate || [];
const historicalHousestate = parsedData.historicalHousestate || [];
const historicalReservations = parsedData.historicalReservations || [];
const events = parsedData.events || [];

const maxRooms = hotelInfo.maxRooms || 100;
const growthTrend = hotelInfo.growthTrend || 1.0;

// Get baselines and curves from analysis
const weekdayBaselines = analysis.weekdayBaselines || {};
const leadtimeCurves = analysis.leadtimeCurves || {};
const revenueRatios = analysis.revenueRatios || {};

// Determine seasonal window
const forecastStartDate = currentHousestate.length > 0
  ? new Date(currentHousestate[0].date)
  : new Date();

const oneYearAgo = new Date(forecastStartDate);
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

const windowStart = new Date(oneYearAgo);
windowStart.setDate(windowStart.getDate() - 30);

const windowEnd = new Date(oneYearAgo);
windowEnd.setDate(windowEnd.getDate() + 60);

// Filter historical housestate to seasonal window
const seasonalHousestate = historicalHousestate.filter(day => {
  if (!day.date || day.isOutlier) return false;
  const d = new Date(day.date);
  return d >= windowStart && d <= windowEnd;
});

// Group seasonal housestate by weekday
const housestateByWeekday = {};
seasonalHousestate.forEach(day => {
  const wd = day.weekday;
  if (!housestateByWeekday[wd]) housestateByWeekday[wd] = [];
  housestateByWeekday[wd].push(day);
});

// Filter historical reservations to seasonal window
const seasonalReservations = historicalReservations.filter(res => {
  if (!res.arrivalDate) return false;
  const d = new Date(res.arrivalDate);
  return d >= windowStart && d <= windowEnd;
});

// Group reservations by weekday
const reservationsByWeekday = {};
seasonalReservations.forEach(res => {
  const wd = res.weekdayArrival;
  if (!reservationsByWeekday[wd]) reservationsByWeekday[wd] = [];
  reservationsByWeekday[wd].push(res);
});

const output = [];

// Process each forecast day
forecastOutputItems.forEach((forecastDay, idx) => {
  const dateStr = forecastDay.Stay_Date;
  const weekday = forecastDay.Weekday;
  const daysUntilArrival = forecastDay.Days_Until_Arrival;

  // Find corresponding OTB day
  const otbDay = currentHousestate.find(d => {
    const otbDateStr = new Date(d.date).toISOString().split('T')[0];
    return otbDateStr === dateStr;
  }) || currentHousestate[idx];

  // Get baseline for this weekday
  const baseline = weekdayBaselines[weekday];

  // Get historical housestate days used for this weekday's baseline
  const housestateUsed = housestateByWeekday[weekday] || [];

  // Get booking curve for this weekday
  const curve = leadtimeCurves[weekday] || {};
  const curveKey = `day${daysUntilArrival}`;
  const curvePercentage = curve[curveKey] || 50;

  // Get reservations used for this weekday's booking curve
  const reservationsUsed = reservationsByWeekday[weekday] || [];

  // Calculate leadtime distribution from reservations (for fact-checking curve)
  const reservationsWithLeadtime = reservationsUsed.filter(r => r.leadtime != null);
  const reservationsAtThisLeadtime = reservationsWithLeadtime.filter(r => r.leadtime >= daysUntilArrival);
  const curveFromReservations = reservationsWithLeadtime.length > 0
    ? (reservationsAtThisLeadtime.length / reservationsWithLeadtime.length) * 100
    : null;

  // Events affecting this day
  const targetDate = new Date(dateStr);
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

  // Build comprehensive fact-check item
  const factCheckItem = {
    // === IDENTIFICATION ===
    date: dateStr,
    weekday: weekday,
    dayIndex: idx + 1,
    daysUntilArrival: daysUntilArrival,
    forecastMethod: forecastMethod,

    // === CONFIG ===
    config: {
      hotelName: hotelInfo.hotelName,
      maxRooms: maxRooms,
      effectiveCapacity: effectiveCapacity,
      growthTrend: growthTrend,
      seasonalWindow: {
        start: windowStart.toISOString().split('T')[0],
        end: windowEnd.toISOString().split('T')[0]
      }
    },

    // === OTB INPUT ===
    otbInput: otbDay ? {
      roomNights: otbDay.roomNights,
      roomRevenue: Math.round(otbDay.roomRevenue * 100) / 100,
      totalRevenue: Math.round(otbDay.totalRevenue * 100) / 100,
      fbRevenue: otbDay.fbRevenue != null ? Math.round(otbDay.fbRevenue * 100) / 100 : null,
      otherRevenue: otbDay.otherRevenue != null ? Math.round(otbDay.otherRevenue * 100) / 100 : null,
      adr: otbDay.roomNights > 0 ? Math.round((otbDay.roomRevenue / otbDay.roomNights) * 100) / 100 : null
    } : { error: 'OTB day not found' },

    // === BASELINE TRACE (from Historical Housestate) ===
    baselineTrace: {
      weekday: weekday,
      calculatedBaseline: baseline ? {
        historicalAvgRoomNights: baseline.historicalAvgRoomNights,
        historicalAvgRoomRevenue: baseline.historicalAvgRoomRevenue,
        historicalAvgTotalRevenue: baseline.historicalAvgTotalRevenue,
        historicalADR: baseline.historicalADR,
        sampleSize: baseline.sampleSize
      } : null,
      withGrowth: baseline ? {
        expectedRoomNights: Math.round(baseline.historicalAvgRoomNights * growthTrend * 100) / 100,
        expectedADR: Math.round(baseline.historicalADR * growthTrend * 100) / 100
      } : null,
      housestateDataUsed: {
        count: housestateUsed.length,
        dates: housestateUsed.slice(0, 5).map(d => new Date(d.date).toISOString().split('T')[0]),
        samples: housestateUsed.slice(0, 5).map(d => ({
          date: new Date(d.date).toISOString().split('T')[0],
          roomNights: d.roomNights,
          roomRevenue: Math.round(d.roomRevenue * 100) / 100,
          adr: d.roomNights > 0 ? Math.round((d.roomRevenue / d.roomNights) * 100) / 100 : null
        })),
        moreAvailable: housestateUsed.length > 5
      }
    },

    // === BOOKING CURVE TRACE (from Historical Reservations) ===
    bookingCurveTrace: forecastMethod === 'curve-based' ? {
      daysUntilArrival: daysUntilArrival,
      curvePercentageUsed: curvePercentage,
      reservationDataUsed: {
        totalReservations: reservationsUsed.length,
        withLeadtimeData: reservationsWithLeadtime.length,
        bookedByThisLeadtime: reservationsAtThisLeadtime.length,
        calculatedPercentage: curveFromReservations != null ? Math.round(curveFromReservations * 100) / 100 : null,
        samples: reservationsWithLeadtime.slice(0, 5).map(r => ({
          arrivalDate: new Date(r.arrivalDate).toISOString().split('T')[0],
          leadtime: r.leadtime,
          roomNights: r.roomNights,
          bookedBeforeThisLeadtime: r.leadtime >= daysUntilArrival
        })),
        moreAvailable: reservationsWithLeadtime.length > 5
      },
      curveCalculation: {
        formula: 'OTB ÷ curvePercentage',
        otb: otbDay?.roomNights || 0,
        percentage: curvePercentage,
        projected: Math.round((otbDay?.roomNights || 0) / (curvePercentage / 100) * 100) / 100
      }
    } : { note: 'Not used for traditional method (> 30 days out)' },

    // === REVENUE RATIO TRACE ===
    revenueRatioTrace: {
      overall: {
        fbRatio: revenueRatios.overall?.fbRatio != null ? Math.round(revenueRatios.overall.fbRatio * 1000) / 1000 : null,
        otherRatio: revenueRatios.overall?.otherRatio != null ? Math.round(revenueRatios.overall.otherRatio * 1000) / 1000 : null,
        totalRatio: revenueRatios.overall?.totalRatio != null ? Math.round(revenueRatios.overall.totalRatio * 1000) / 1000 : null
      },
      weekday: revenueRatios.byWeekday?.[weekday] ? {
        fbRatio: Math.round(revenueRatios.byWeekday[weekday].fbRatio * 1000) / 1000,
        otherRatio: Math.round(revenueRatios.byWeekday[weekday].otherRatio * 1000) / 1000,
        totalRatio: Math.round(revenueRatios.byWeekday[weekday].totalRatio * 1000) / 1000
      } : null
    },

    // === EVENTS ===
    events: applicableEvents.length > 0 ? {
      count: applicableEvents.length,
      totalPickupImpact: totalEventPickup,
      capacityOverride: capacityOverride,
      details: applicableEvents.map(e => ({
        name: e.eventName,
        start: new Date(e.startDate).toISOString().split('T')[0],
        end: new Date(e.endDate).toISOString().split('T')[0],
        pickupImpact: e.pickupImpact,
        overrideMaxRooms: e.overrideMaxRooms
      }))
    } : null,

    // === ACTUAL FORECAST OUTPUT ===
    forecastOutput: {
      roomNightsFinal: forecastDay.Room_Nights_Final,
      pickup: forecastDay.Pickup,
      roomRevenue: forecastDay.Room_Revenue,
      fbRevenue: forecastDay.FB_Revenue,
      otherRevenue: forecastDay.Other_Revenue,
      totalRevenue: forecastDay.Total_Revenue,
      historicalADR: forecastDay.Historical_ADR,
      expectedADR: forecastDay.Expected_ADR,
      otbADR: forecastDay.OTB_ADR,
      occupancyPct: forecastDay.Occupancy_Pct,
      revpar: forecastDay.RevPAR
    },

    // === VERIFICATION CALCULATIONS ===
    verification: {
      // Room nights calculation
      roomNightsCheck: forecastMethod === 'traditional' ? {
        method: 'traditional',
        formula: '(baseline × growth) + eventPickup, capped at capacity',
        baseline: baseline?.historicalAvgRoomNights || 0,
        withGrowth: Math.round((baseline?.historicalAvgRoomNights || 0) * growthTrend * 100) / 100,
        withEvents: Math.round(((baseline?.historicalAvgRoomNights || 0) * growthTrend + totalEventPickup) * 100) / 100,
        capped: Math.min(Math.round(((baseline?.historicalAvgRoomNights || 0) * growthTrend + totalEventPickup) * 100) / 100, effectiveCapacity),
        actual: forecastDay.Room_Nights_Final
      } : {
        method: 'curve-based',
        formula: '(OTB ÷ curvePercentage × growth) + eventPickup, capped at capacity',
        otb: otbDay?.roomNights || 0,
        curvePercentage: curvePercentage,
        projected: Math.round((otbDay?.roomNights || 0) / (curvePercentage / 100) * 100) / 100,
        withGrowth: Math.round((otbDay?.roomNights || 0) / (curvePercentage / 100) * growthTrend * 100) / 100,
        withEvents: Math.round(((otbDay?.roomNights || 0) / (curvePercentage / 100) * growthTrend + totalEventPickup) * 100) / 100,
        capped: Math.min(Math.round(((otbDay?.roomNights || 0) / (curvePercentage / 100) * growthTrend + totalEventPickup) * 100) / 100, effectiveCapacity),
        actual: forecastDay.Room_Nights_Final
      },

      // Pickup calculation
      pickupCheck: {
        formula: 'max(0, forecastedRoomNights - otbRoomNights)',
        forecasted: forecastDay.Room_Nights_Final,
        otb: otbDay?.roomNights || 0,
        expected: Math.max(0, forecastDay.Room_Nights_Final - (otbDay?.roomNights || 0)),
        actual: forecastDay.Pickup
      },

      // Revenue calculation
      revenueCheck: {
        roomRevenueFormula: 'otbRoomRevenue + (pickup × pickupADR)',
        totalRevenueFormula: 'roomRevenue + fbRevenue + otherRevenue',
        fbRevenueFormula: 'roomRevenue × fbRatio',
        components: {
          otbRoomRevenue: otbDay?.roomRevenue || 0,
          pickup: forecastDay.Pickup,
          pickupADR: forecastDay.OTB_ADR || forecastDay.Expected_ADR,
          fbRatio: revenueRatios.overall?.fbRatio || 0,
          otherRatio: revenueRatios.overall?.otherRatio || 0
        }
      }
    }
  };

  output.push(factCheckItem);
});

// Add summary item
output.push({
  date: 'SUMMARY',
  factCheckSummary: {
    totalDays: forecastOutputItems.length,
    dataSourcesUsed: {
      historicalHousestateDays: seasonalHousestate.length,
      historicalReservations: seasonalReservations.length,
      events: events.length
    },
    analysisOutputs: {
      weekdayBaselines: Object.keys(weekdayBaselines).length,
      bookingCurves: Object.keys(leadtimeCurves).length,
      revenueRatios: revenueRatios.overall ? 'available' : 'missing'
    },
    filterInstructions: [
      'Filter date = "YYYY-MM-DD" for specific day',
      'Filter date = "SUMMARY" for this summary'
    ]
  }
});

return output.map(item => ({ json: item }));
