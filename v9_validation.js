/**
 * Validation Node - Checks forecast output integrity and compares to input
 *
 * Outputs array of items with 'category' and 'status' fields for filtering:
 * - category: "integrity", "consistency", "comparison", "business_logic", "summary"
 * - status: "pass", "fail", "warning", "info"
 *
 * Use n8n Filter node:
 * - Filter by status = "fail" to see only failures
 * - Filter by category = "comparison" to see input vs output checks
 *
 * Expected inputs (via Merge node):
 * - Forecast output items (from Output Formatter)
 * - Input summary items (from Input Summary node) - optional
 */

const allItems = $input.all();
const allData = allItems.map(item => item.json);

const checks = [];

// Separate forecast data from input summary
const forecastData = allData.filter(d => d.Stay_Date !== undefined);
const inputSummary = allData.filter(d => d.type !== undefined);

// Extract input summary by type
const hotelInfo = inputSummary.find(d => d.type === 'hotel_info');
const events = inputSummary.filter(d => d.type === 'event');
const otbDays = inputSummary.filter(d => d.type === 'otb_day');
const summary = inputSummary.find(d => d.type === 'summary');

// ============ INTEGRITY CHECKS ============

// Check 1: Forecast has data
checks.push({
  category: 'integrity',
  checkId: 'forecast_count',
  status: forecastData.length >= 85 ? 'pass' : 'fail',
  message: `Forecast contains ${forecastData.length} days (expected ~90)`,
  expected: '85-95',
  actual: forecastData.length
});

// Check 2: No null Stay_Date
const nullDates = forecastData.filter(d => !d.Stay_Date);
checks.push({
  category: 'integrity',
  checkId: 'null_dates',
  status: nullDates.length === 0 ? 'pass' : 'fail',
  message: nullDates.length === 0 ? 'All dates present' : `${nullDates.length} rows have null Stay_Date`,
  expected: 0,
  actual: nullDates.length
});

// Check 3: No negative Room_Nights_Final
const negativeRN = forecastData.filter(d => d.Room_Nights_Final < 0);
checks.push({
  category: 'integrity',
  checkId: 'negative_room_nights',
  status: negativeRN.length === 0 ? 'pass' : 'fail',
  message: negativeRN.length === 0 ? 'No negative room nights' : `${negativeRN.length} rows have negative Room_Nights_Final`,
  expected: 0,
  actual: negativeRN.length,
  flaggedDates: negativeRN.slice(0, 5).map(d => d.Stay_Date)
});

// Check 4: No negative Pickup
const negativePickup = forecastData.filter(d => d.Pickup < 0);
checks.push({
  category: 'integrity',
  checkId: 'negative_pickup',
  status: negativePickup.length === 0 ? 'pass' : 'fail',
  message: negativePickup.length === 0 ? 'No negative pickup' : `${negativePickup.length} rows have negative Pickup`,
  expected: 0,
  actual: negativePickup.length,
  flaggedDates: negativePickup.slice(0, 5).map(d => d.Stay_Date)
});

// Check 5: No negative revenues
const negativeRevenue = forecastData.filter(d =>
  d.Room_Revenue < 0 || d.Total_Revenue < 0 || (d.FB_Revenue != null && d.FB_Revenue < 0)
);
checks.push({
  category: 'integrity',
  checkId: 'negative_revenue',
  status: negativeRevenue.length === 0 ? 'pass' : 'fail',
  message: negativeRevenue.length === 0 ? 'No negative revenue' : `${negativeRevenue.length} rows have negative revenue`,
  expected: 0,
  actual: negativeRevenue.length,
  flaggedDates: negativeRevenue.slice(0, 5).map(d => d.Stay_Date)
});

// Check 6: Occupancy in valid range (0-100%)
const invalidOccupancy = forecastData.filter(d =>
  d.Occupancy_Pct < 0 || d.Occupancy_Pct > 100
);
checks.push({
  category: 'integrity',
  checkId: 'occupancy_range',
  status: invalidOccupancy.length === 0 ? 'pass' : 'fail',
  message: invalidOccupancy.length === 0 ? 'All occupancy values 0-100%' : `${invalidOccupancy.length} rows have invalid occupancy`,
  expected: '0-100%',
  actual: invalidOccupancy.length > 0 ? `${invalidOccupancy.length} invalid` : 'all valid',
  flaggedDates: invalidOccupancy.slice(0, 5).map(d => ({ date: d.Stay_Date, value: d.Occupancy_Pct }))
});

// ============ CONSISTENCY CHECKS ============

// Check 7: Total Revenue = Room + FB + Other (within tolerance)
const revenueMismatch = forecastData.filter(d => {
  const calculated = (d.Room_Revenue || 0) + (d.FB_Revenue || 0) + (d.Other_Revenue || 0);
  const diff = Math.abs(calculated - (d.Total_Revenue || 0));
  return diff > 0.02; // 2 cent tolerance
});
checks.push({
  category: 'consistency',
  checkId: 'revenue_sum',
  status: revenueMismatch.length === 0 ? 'pass' : 'fail',
  message: revenueMismatch.length === 0 ? 'Revenue sums match' : `${revenueMismatch.length} rows have revenue sum mismatch`,
  expected: 'Room + FB + Other = Total',
  actual: revenueMismatch.length > 0 ? `${revenueMismatch.length} mismatches` : 'all match',
  flaggedDates: revenueMismatch.slice(0, 5).map(d => ({
    date: d.Stay_Date,
    room: d.Room_Revenue,
    fb: d.FB_Revenue,
    other: d.Other_Revenue,
    total: d.Total_Revenue,
    calculated: (d.Room_Revenue || 0) + (d.FB_Revenue || 0) + (d.Other_Revenue || 0)
  }))
});

// Check 8: OTB Room Nights <= Forecast Room Nights
const otbExceedsForecast = forecastData.filter(d =>
  d.OTB_Room_Nights > d.Room_Nights_Final + 0.01
);
checks.push({
  category: 'consistency',
  checkId: 'otb_not_exceeds_forecast',
  status: otbExceedsForecast.length === 0 ? 'pass' : 'warning',
  message: otbExceedsForecast.length === 0 ? 'OTB never exceeds forecast' : `${otbExceedsForecast.length} rows where OTB > Forecast (curve extrapolation)`,
  expected: 'OTB <= Forecast',
  actual: otbExceedsForecast.length > 0 ? `${otbExceedsForecast.length} exceptions` : 'all valid',
  flaggedDates: otbExceedsForecast.slice(0, 5).map(d => ({
    date: d.Stay_Date,
    otb: d.OTB_Room_Nights,
    forecast: d.Room_Nights_Final
  }))
});

// Check 9: Pickup = Forecast - OTB
const pickupMismatch = forecastData.filter(d => {
  const expectedPickup = Math.max(0, d.Room_Nights_Final - d.OTB_Room_Nights);
  const diff = Math.abs(d.Pickup - expectedPickup);
  return diff > 0.01;
});
checks.push({
  category: 'consistency',
  checkId: 'pickup_calculation',
  status: pickupMismatch.length === 0 ? 'pass' : 'fail',
  message: pickupMismatch.length === 0 ? 'Pickup calculation correct' : `${pickupMismatch.length} rows have incorrect pickup`,
  expected: 'Pickup = max(0, Forecast - OTB)',
  actual: pickupMismatch.length > 0 ? `${pickupMismatch.length} mismatches` : 'all correct',
  flaggedDates: pickupMismatch.slice(0, 5).map(d => ({
    date: d.Stay_Date,
    pickup: d.Pickup,
    forecast: d.Room_Nights_Final,
    otb: d.OTB_Room_Nights,
    expected: Math.max(0, d.Room_Nights_Final - d.OTB_Room_Nights)
  }))
});

// ============ BUSINESS LOGIC CHECKS ============

// Check 10: Expected ADR differs from Historical when growth != 1.0
if (hotelInfo && hotelInfo.growthTrend !== 1.0) {
  const adrSame = forecastData.filter(d =>
    d.Historical_ADR > 0 &&
    Math.abs(d.Expected_ADR - d.Historical_ADR) < 0.01
  );
  checks.push({
    category: 'business_logic',
    checkId: 'growth_applied_to_adr',
    status: adrSame.length === 0 ? 'pass' : 'warning',
    message: adrSame.length === 0 ? 'Growth trend applied to ADR' : `${adrSame.length} rows where Expected ADR = Historical ADR (growth not visible)`,
    expected: `Expected ADR = Historical ADR * ${hotelInfo.growthTrend}`,
    actual: adrSame.length > 0 ? `${adrSame.length} unchanged` : 'growth applied'
  });
}

// Check 11: Method switch at day 30 (Days_Until_Arrival)
const day30 = forecastData.find(d => d.Days_Until_Arrival === 30);
const day31 = forecastData.find(d => d.Days_Until_Arrival === 31);
if (day30 && day31) {
  checks.push({
    category: 'business_logic',
    checkId: 'method_switch_boundary',
    status: 'info',
    message: 'Day 30/31 boundary samples for manual verification',
    day30: {
      date: day30.Stay_Date,
      daysUntil: day30.Days_Until_Arrival,
      roomNights: day30.Room_Nights_Final,
      otb: day30.OTB_Room_Nights
    },
    day31: {
      date: day31.Stay_Date,
      daysUntil: day31.Days_Until_Arrival,
      roomNights: day31.Room_Nights_Final,
      otb: day31.OTB_Room_Nights
    }
  });
}

// Check 12: Capacity respected (if hotel info available)
if (hotelInfo && hotelInfo.maxRooms > 0) {
  const overCapacity = forecastData.filter(d => d.Room_Nights_Final > hotelInfo.maxRooms);
  checks.push({
    category: 'business_logic',
    checkId: 'capacity_respected',
    status: overCapacity.length === 0 ? 'pass' : 'fail',
    message: overCapacity.length === 0 ? 'Capacity respected' : `${overCapacity.length} rows exceed max rooms (${hotelInfo.maxRooms})`,
    expected: `<= ${hotelInfo.maxRooms}`,
    actual: overCapacity.length > 0 ? `${overCapacity.length} exceeded` : 'all within capacity',
    flaggedDates: overCapacity.slice(0, 5).map(d => ({
      date: d.Stay_Date,
      roomNights: d.Room_Nights_Final
    }))
  });
}

// ============ COMPARISON CHECKS (if input summary available) ============

if (otbDays.length > 0) {
  // Check 13: OTB data matches between input and output
  let otbMatches = 0;
  let otbMismatches = [];

  otbDays.forEach(inputDay => {
    const outputDay = forecastData.find(d => d.Stay_Date === inputDay.date);
    if (outputDay) {
      const inputOTB = inputDay.otbRoomNights;
      const outputOTB = outputDay.OTB_Room_Nights;
      const diff = Math.abs(inputOTB - outputOTB);
      if (diff < 0.01) {
        otbMatches++;
      } else {
        otbMismatches.push({
          date: inputDay.date,
          inputOTB: inputOTB,
          outputOTB: outputOTB,
          diff: diff
        });
      }
    }
  });

  checks.push({
    category: 'comparison',
    checkId: 'otb_input_vs_output',
    status: otbMismatches.length === 0 ? 'pass' : 'fail',
    message: otbMismatches.length === 0 ? 'OTB data matches input' : `${otbMismatches.length} days have OTB mismatch`,
    expected: 'Input OTB = Output OTB',
    actual: `${otbMatches} match, ${otbMismatches.length} mismatch`,
    flaggedDates: otbMismatches.slice(0, 5)
  });
}

// Check 14: Events applied on correct dates
if (events.length > 0) {
  events.forEach(event => {
    // Find forecast days within event date range
    const eventDays = forecastData.filter(d => {
      const stayDate = new Date(d.Stay_Date);
      const startDate = new Date(event.startDate);
      const endDate = new Date(event.endDate);
      return stayDate >= startDate && stayDate <= endDate;
    });

    if (eventDays.length > 0 && event.pickupImpact !== 0) {
      checks.push({
        category: 'comparison',
        checkId: `event_${event.eventIndex}_applied`,
        status: 'info',
        message: `Event "${event.eventName}" covers ${eventDays.length} forecast days`,
        event: {
          name: event.eventName,
          start: event.startDate,
          end: event.endDate,
          pickupImpact: event.pickupImpact,
          capacityOverride: event.overrideMaxRooms
        },
        sampleDays: eventDays.slice(0, 3).map(d => ({
          date: d.Stay_Date,
          roomNights: d.Room_Nights_Final,
          pickup: d.Pickup,
          otb: d.OTB_Room_Nights
        }))
      });
    }
  });
}

// ============ SUMMARY ============

const passCount = checks.filter(c => c.status === 'pass').length;
const failCount = checks.filter(c => c.status === 'fail').length;
const warningCount = checks.filter(c => c.status === 'warning').length;
const infoCount = checks.filter(c => c.status === 'info').length;

// Stats on forecast data
const roomNightsArr = forecastData.map(d => d.Room_Nights_Final);
const revenueArr = forecastData.map(d => d.Total_Revenue);
const adrArr = forecastData.filter(d => d.Expected_ADR > 0).map(d => d.Expected_ADR);
const occupancyArr = forecastData.map(d => d.Occupancy_Pct);

const calcStats = (arr) => ({
  min: Math.min(...arr),
  max: Math.max(...arr),
  avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100
});

checks.push({
  category: 'summary',
  checkId: 'validation_summary',
  status: failCount === 0 ? 'pass' : 'fail',
  message: failCount === 0 ? 'All checks passed' : `${failCount} checks failed`,
  results: {
    pass: passCount,
    fail: failCount,
    warning: warningCount,
    info: infoCount,
    total: checks.length
  },
  forecastStats: {
    dayCount: forecastData.length,
    roomNights: calcStats(roomNightsArr),
    totalRevenue: calcStats(revenueArr),
    expectedADR: adrArr.length > 0 ? calcStats(adrArr) : null,
    occupancy: calcStats(occupancyArr)
  },
  inputAvailable: {
    hotelInfo: !!hotelInfo,
    events: events.length,
    otbDays: otbDays.length
  }
});

// Return as array of items for n8n
return checks.map(item => ({ json: item }));
