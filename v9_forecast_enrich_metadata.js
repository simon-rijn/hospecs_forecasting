// ============ FORECAST ENRICH METADATA ============
// Adds Sheet_Id and Previous_Forecasts_Address to each forecast item
// Stringifies forecast array for database storage

// Input: Multiple forecast items OR single item with array
// References: Get Client Metadata node

// Input has 2 items: forecast data, client metadata
const inputItems = $input.all().map(item => item.json);

// Find each item by its unique properties
const forecastItem = inputItems.find(item => item.Forecast_output);
const clientMetadata = inputItems.find(item => item.data_previous_forecast);

// Extract values
const forecastArray = forecastItem?.Forecast_output || [];
const dataPreviousForecast = clientMetadata?.data_previous_forecast || null;

console.log('Data Previous Forecast:', dataPreviousForecast);
console.log('Forecast items:', forecastArray.length);

// Stringify the forecast array for database storage
const forecastsJson = JSON.stringify(forecastArray);

return [{
  json: {
    Forecasts_Json: forecastsJson,
    Data_Previous_Forecast: dataPreviousForecast
  }
}];
