/**
 * Input Summary Node - Extracts key data points from merged input for comparison
 *
 * Outputs array of items with 'type' field for easy filtering:
 * - type: "hotel_info" (1 item)
 * - type: "event" (1 per event)
 * - type: "otb_day" (1 per forecast day)
 * - type: "historical_stats" (1 item with aggregated stats)
 * - type: "summary" (1 item with counts and date ranges)
 *
 * Use n8n Filter node to select specific types for inspection
 */

const allItems = $input.all();
const allInputs = allItems.map(item => item.json);

const output = [];

// ============ 1. HOTEL INFO ============
const hotelInfo = allInputs.find(obj => obj.Max_Rooms);
if (hotelInfo) {
  output.push({
    type: 'hotel_info',
    hotelName: hotelInfo.Hotel_Name || 'Unknown',
    maxRooms: Number(hotelInfo.Max_Rooms) || 0,
    growthTrend: Number(hotelInfo.Growth_Trend) || 1.0,
    hotelType: hotelInfo.Hotel_Type || 'Unknown',
    seasonalHotel: hotelInfo.Seasonal_Hotel || 'No'
  });
}

// ============ 2. EVENTS ============
const eventsObj = allInputs.find(obj => obj.Events);
const events = (eventsObj && eventsObj.Events) || [];

events.forEach((event, idx) => {
  output.push({
    type: 'event',
    eventIndex: idx + 1,
    eventName: event.Event_Name || `Event ${idx + 1}`,
    startDate: event.Start_Date || null,
    endDate: event.End_Date || null,
    pickupImpact: Number(event.Pickup_Impact) || 0,
    overrideMaxRooms: event.Override_Max_Rooms != null ? Number(event.Override_Max_Rooms) : null
  });
});

// ============ 3. OTB DATA (Current Housestate) ============
// Find the hotel data array
const hotelDataObj = allInputs.find(item => {
  const keys = Object.keys(item);
  return keys.some(key =>
    key !== 'Historical Housestats' &&
    key !== 'Historical Reservations' &&
    key !== 'Events' &&
    key !== 'Trends' &&
    key !== 'Previous Forecasts' &&
    key !== 'Forecast Accuracy History' &&
    !key.startsWith('Max_') &&
    !key.startsWith('Hotel_') &&
    Array.isArray(item[key])
  );
});

let otbData = [];
if (hotelDataObj) {
  const hotelKey = Object.keys(hotelDataObj).find(key =>
    Array.isArray(hotelDataObj[key]) &&
    hotelDataObj[key].length > 0 &&
    hotelDataObj[key][0].Date
  );
  if (hotelKey) {
    otbData = hotelDataObj[hotelKey];
  }
}

// Also try direct array format
if (otbData.length === 0) {
  const directArray = allInputs.find(item =>
    item.Date && item.RoomNights !== undefined
  );
  if (directArray) {
    otbData = allInputs.filter(item => item.Date && item.RoomNights !== undefined);
  }
}

otbData.forEach((day, idx) => {
  const roomNights = Number(day.RoomNights) || 0;
  const roomRevenue = Number(day.RoomRevenue) || 0;
  const otbADR = roomNights > 0 ? roomRevenue / roomNights : null;

  output.push({
    type: 'otb_day',
    dayIndex: idx + 1,
    date: day.Date || null,
    weekday: day.Weekday || null,
    otbRoomNights: roomNights,
    otbRoomRevenue: roomRevenue,
    otbTotalRevenue: Number(day.TotalRevenue) || 0,
    otbFBRevenue: day.FB_Revenue != null ? Number(day.FB_Revenue) : null,
    otbOtherRevenue: day.OtherRevenue != null ? Number(day.OtherRevenue) : null,
    otbADR: otbADR != null ? Math.round(otbADR * 100) / 100 : null
  });
});

// ============ 4. HISTORICAL STATS ============
const histObj = allInputs.find(item =>
  item['Historical Housestats'] || item['Historical Housestates']
);
const histData = histObj ?
  (histObj['Historical Housestats'] || histObj['Historical Housestates'] || []) :
  [];

if (histData.length > 0) {
  // Calculate stats per weekday
  const weekdayStats = {};
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  weekdays.forEach(wd => {
    const days = histData.filter(d => d.Weekday === wd);
    if (days.length > 0) {
      const roomNights = days.map(d => Number(d.RoomNights) || 0);
      const avgRN = roomNights.reduce((a, b) => a + b, 0) / days.length;
      weekdayStats[wd] = {
        sampleSize: days.length,
        avgRoomNights: Math.round(avgRN * 10) / 10
      };
    }
  });

  // Get date range
  const dates = histData
    .map(d => d.Date)
    .filter(d => d)
    .sort();

  output.push({
    type: 'historical_stats',
    totalDays: histData.length,
    dateRangeStart: dates[0] || null,
    dateRangeEnd: dates[dates.length - 1] || null,
    weekdayStats: weekdayStats
  });
}

// ============ 5. SUMMARY ============
output.push({
  type: 'summary',
  hotelInfoFound: !!hotelInfo,
  eventCount: events.length,
  otbDayCount: otbData.length,
  historicalDayCount: histData.length,
  otbDateRange: otbData.length > 0 ? {
    start: otbData[0]?.Date || null,
    end: otbData[otbData.length - 1]?.Date || null
  } : null,
  eventsWithCapacityOverride: events.filter(e => e.Override_Max_Rooms != null).length,
  eventsWithPickupImpact: events.filter(e => Number(e.Pickup_Impact) !== 0).length
});

// Return as array of items for n8n
return output.map(item => ({ json: item }));
