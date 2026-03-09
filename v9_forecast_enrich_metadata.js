// ============ FORECAST ENRICH METADATA ============
// Adds Sheet_Id and Previous_Forecasts_Address to each forecast item

// Input 0: Forecast output items
// Input 1: Create Sheets output (array with worksheet info)
// Input 2: Client Metadata (array with hotel metadata)

const forecastItems = $input.all();
const sheetData = $('Create Sheet').first().json;
const clientMetadata = $('Get Client Metadata').first().json;

// Extract the two values we need
const sheetId = sheetData?.id || null;
const previousForecastsAddress = clientMetadata?.previous_forecasts || null;

console.log('Sheet ID:', sheetId);
console.log('Previous Forecasts Address:', previousForecastsAddress);

// Add both fields to each forecast item
const enrichedItems = forecastItems.map(item => ({
  json: {
    ...item.json,
    Sheet_Id: sheetId,
    Previous_Forecasts_Address: previousForecastsAddress
  }
}));

console.log('Enriched', enrichedItems.length, 'forecast items with metadata');
return enrichedItems;
