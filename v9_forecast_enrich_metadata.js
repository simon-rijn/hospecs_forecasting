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

// Add metadata to each forecast item
const enrichedItems = forecastArray.map(item => ({
  ...item,
  Sheet_Id: sheetId,
  Previous_Forecasts_Address: previousForecastsAddress
}));

if (enrichedItems.length === 0) {
  return [];
}

// Get headers from first item's keys
const headers = Object.keys(enrichedItems[0]);

// Create data rows (values in same order as headers)
const dataRows = enrichedItems.map(item =>
  headers.map(key => item[key] ?? '')
);

// Combine: headers as first row, then data
const values = [headers, ...dataRows];

// Calculate range (e.g., A1:Z91 for 26 columns and 91 rows)
const lastCol = String.fromCharCode(64 + Math.min(headers.length, 26));
const range = `A1:${lastCol}${values.length}`;

console.log('Prepared', enrichedItems.length, 'rows with', headers.length, 'columns for Excel');
console.log('Range:', range);

return [{
  json: {
    values: values,
    range: range
  }
}];
