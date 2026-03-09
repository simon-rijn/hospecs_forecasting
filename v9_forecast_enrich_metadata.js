// ============ FORECAST ENRICH METADATA ============
// Adds Sheet_Id and Previous_Forecasts_Address to each forecast item

// Input: Multiple forecast items OR single item with array
// References: Add a sheet to a workbook node, Get Client Metadata node

// Handle both: array of items via $input.all(), or single item containing array
const inputItems = $input.all();
const forecastArray = inputItems.length === 1 && Array.isArray(inputItems[0].json.forecasts)
  ? inputItems[0].json.forecasts
  : inputItems.map(item => item.json);
const sheetData = $('Add a sheet to a workbook').first().json;
const clientMetadata = $('Get Client Metadata').first().json;

// Extract the two values we need
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
