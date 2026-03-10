// ============ FORECAST PARSE JSON ============
// Converts forecast_JSON_string back to a normal array

// Input: Item with forecast_JSON_string from database
const forecastsJson = $input.first().json.forecast_JSON_string;

// Parse the JSON string back to an array
const forecastArray = JSON.parse(forecastsJson);

console.log('Parsed forecast items:', forecastArray.length);

return [{
  json: {
    Forecasts: forecastArray
  }
}];
