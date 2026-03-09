// ============ FORECAST ENRICH METADATA ============
// Adds Sheet_Id and Previous_Forecasts_Address to each forecast item

// Input: Multiple forecast items OR single item with array
// References: Add a sheet to a workbook node, Get Client Metadata node

// Input has 3 items: forecast data, client metadata, sheet data
const inputItems = $input.all().map(item => item.json);

// Find each item by its unique properties
const forecastItem = inputItems.find(item => item.Forecast_output);
const clientMetadata = inputItems.find(item => item.previous_forecasts);
const sheetData = inputItems.find(item => item['@odata.context'] || item.name?.startsWith('forecast_'));

// Extract values
const forecastArray = forecastItem?.Forecast_output || [];
const sheetId = sheetData?.id || null;
const previousForecastsAddress = clientMetadata?.previous_forecasts || null;

console.log('Sheet ID:', sheetId);
console.log('Previous Forecasts Address:', previousForecastsAddress);

// Add both fields to each forecast item and return as separate items
const enrichedItems = forecastArray.map(item => ({
  json: {
    ...item,
    Sheet_Id: sheetId,
    Previous_Forecasts_Address: previousForecastsAddress
  }
}));

console.log('Enriched', enrichedItems.length, 'forecast items with metadata');
return enrichedItems;
