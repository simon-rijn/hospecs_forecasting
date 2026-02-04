// ============ HOTEL FORECASTING OUTPUT ============
const forecastWrapper = $input.first().json;

if (!forecastWrapper.success) {
  throw new Error('Cannot output forecast - generation failed');
}

const forecastData = forecastWrapper; // alias voor leesbaarheid

console.log('✅ Preparing output:', (forecastData.forecast || []).length, 'days');

// Dynamische hotel info (meegestuurd vanuit forecasting engine)
const hotelInfo = forecastData.hotelInfo || {};
const hotelName = hotelInfo.hotelName || hotelInfo.Hotel_Name || 'Unknown Hotel';

// Bouw output items
const outputItems = (forecastData.forecast || []).map(day => {
  // 🔒 ALTIJD via Date-object werken, nooit direct day.stayDate.toISOString()
  const stayDateObj = new Date(day.stayDate);

  // Veilige datum-string
  const stayDateStr = isNaN(stayDateObj.getTime())
    ? String(day.stayDate || '').split('T')[0]           // fallback: gebruik de ruwe string
    : stayDateObj.toISOString().split('T')[0];           // normale ISO-datum

  return {
    json: {
      Stay_Date: stayDateStr,
      Weekday: day.weekday,
      Days_Until_Arrival: day.daysUntilArrival,
      Room_Nights_Final: day.roomNightsFinal,
      Pickup: day.pickup,
      Room_Revenue: parseFloat(Number(day.roomRevenue || 0).toFixed(2)),
      FB_Revenue: parseFloat(Number(day.fbRevenue || 0).toFixed(2)),
      Other_Revenue: parseFloat(Number(day.otherRevenue || 0).toFixed(2)),
      Total_Revenue: parseFloat(Number(day.totalRevenue || 0).toFixed(2)),
      Historical_ADR: parseFloat(Number(day.historicalADR || 0).toFixed(2)),
      Expected_ADR: parseFloat(Number(day.expectedADR || 0).toFixed(2)),
      OTB_ADR: day.otbADR != null ? parseFloat(Number(day.otbADR).toFixed(2)) : null,
      Occupancy_Pct: parseFloat(Number(day.occupancy || 0).toFixed(1)),
      RevPAR: parseFloat(Number(day.revpar || 0).toFixed(2)),
      FB_RevPAR: parseFloat(Number(day.fbRevpar || 0).toFixed(2)),
      TRevPAR: parseFloat(Number(day.trevpar || 0).toFixed(2)),
      Other_RevPAR: parseFloat(Number(day.otherRevpar || 0).toFixed(2)),
      OTB_Room_Nights: day.otbRoomNights,
      OTB_Room_Revenue: parseFloat(Number(day.otbRoomRevenue || 0).toFixed(2)),
      OTB_Total_Revenue: parseFloat(Number(day.otbTotalRevenue || 0).toFixed(2)),

      // Alleen hotelnaam, geen Hotel_Id
      Hotel_Name: hotelName,

      Forecast_Created_At: new Date().toISOString()
    }
  };
});

console.log('✅ Output ready:', outputItems.length, 'items');
return outputItems;
