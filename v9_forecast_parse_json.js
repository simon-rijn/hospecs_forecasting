// ============ FORECAST PARSE JSON ============
// Converts Forecasts_Json string back to a normal array

// Input: Item with Forecasts_Json string
const forecastsJson = $input.first().json.Forecasts_Json;

// Parse the JSON string back to an array
const forecastArray = JSON.parse(forecastsJson);

console.log('Parsed forecast items:', forecastArray.length);

return [{
  json: {
    Forecasts: forecastArray
  }
}];
