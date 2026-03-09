/**
 * Hotel Revenue Forecasting System - Forecast Accuracy Measurement
 *
 * Evaluates forecast accuracy by comparing forecasts to actuals.
 * Calculates MAPE (Mean Absolute Percentage Error) and MAE (Mean Absolute Error)
 * per metric, aggregated by forecast horizon.
 *
 * Forecast Horizons:
 *   - 1w:  1-7 days ahead
 *   - 2w:  8-14 days ahead
 *   - 4w:  22-28 days ahead
 *   - 8w:  50-56 days ahead
 *
 * Run cadence: Weekly, appending to history file for trend tracking
 */

class ForecastAccuracyMeasurement {
  constructor(options = {}) {
    // Configurable thresholds
    this.options = {
      // Horizon definitions (days ahead when forecast was made)
      horizons: {
        '1w': { min: 1, max: 7, label: '1 Week' },
        '2w': { min: 8, max: 14, label: '2 Weeks' },
        '4w': { min: 22, max: 28, label: '4 Weeks' },
        '8w': { min: 50, max: 56, label: '8 Weeks' }
      },

      // Metrics to measure (forecast field -> actual field mapping)
      // If actual field is same as forecast, just use the name
      metrics: options.metrics || [
        'Room_Nights_Final',
        'Pickup',
        'Room_Revenue',
        'FB_Revenue',
        'Other_Revenue',
        'Total_Revenue',
        'Expected_ADR',
        'Occupancy_Pct',
        'RevPAR',
        'FB_RevPAR',
        'TRevPAR',
        'Other_RevPAR'
      ],

      // Field mappings (forecast field -> actual field if different)
      fieldMappings: options.fieldMappings || {
        'Room_Nights_Final': 'RoomNights',
        'Expected_ADR': 'ADR',
        'Occupancy_Pct': 'Occupancy'
      },

      // Date field names
      forecastDateField: options.forecastDateField || 'Stay_Date',
      actualDateField: options.actualDateField || 'Date',
      forecastCreatedField: options.forecastCreatedField || 'Forecast_Created_At',

      // Top N for best/worst metrics
      topN: options.topN || 3,

      // Minimum data points required for valid accuracy calculation
      minDataPoints: options.minDataPoints || 3,

      ...options
    };

    this.results = null;
    this.warnings = [];
  }

  /**
   * Main entry point: Calculate accuracy scores
   * @param {Array} forecasts - Array of forecast records
   * @param {Array} actuals - Array of actual results records
   * @param {Date} runDate - Date of this accuracy run (defaults to now)
   * @returns {Object} Accuracy results
   */
  calculateAccuracy(forecasts, actuals, runDate = new Date()) {
    // Validate inputs
    if (!Array.isArray(forecasts) || forecasts.length === 0) {
      throw new Error('CRITICAL: No forecast data provided');
    }
    if (!Array.isArray(actuals) || actuals.length === 0) {
      throw new Error('CRITICAL: No actuals data provided');
    }

    // Step 1: Align forecast and actual data by date
    const alignedData = this.alignDataByDate(forecasts, actuals);

    if (alignedData.length === 0) {
      throw new Error('CRITICAL: No matching dates between forecast and actuals');
    }

    // Step 2: Calculate horizon for each aligned record
    const dataWithHorizons = this.assignHorizons(alignedData);

    // Step 3: Calculate per-metric accuracy within each horizon
    const horizonAccuracy = this.calculateHorizonAccuracy(dataWithHorizons);

    // Step 4: Identify best/worst metrics per horizon
    const rankedMetrics = this.rankMetrics(horizonAccuracy);

    // Step 5: Calculate overall accuracy per horizon
    const overallAccuracy = this.calculateOverallAccuracy(horizonAccuracy);

    // Build final result
    this.results = {
      forecast_run_date: runDate.toISOString(),
      data_summary: {
        total_forecasts: forecasts.length,
        total_actuals: actuals.length,
        matched_records: alignedData.length,
        records_by_horizon: this.countByHorizon(dataWithHorizons)
      },
      overall_accuracy: overallAccuracy,
      per_metric_accuracy: horizonAccuracy,
      best_metrics: rankedMetrics.best,
      worst_metrics: rankedMetrics.worst,
      warnings: this.warnings
    };

    return this.results;
  }

  /**
   * Align forecast and actual data by date
   */
  alignDataByDate(forecasts, actuals) {
    const aligned = [];

    // Build lookup map for actuals by date
    const actualsMap = new Map();
    actuals.forEach(actual => {
      const dateStr = this.normalizeDate(actual[this.options.actualDateField]);
      if (dateStr) {
        actualsMap.set(dateStr, actual);
      }
    });

    // Match forecasts to actuals
    forecasts.forEach(forecast => {
      const forecastDateStr = this.normalizeDate(forecast[this.options.forecastDateField]);
      if (!forecastDateStr) {
        this.warnings.push(`Skipping forecast with invalid date: ${forecast[this.options.forecastDateField]}`);
        return;
      }

      const actual = actualsMap.get(forecastDateStr);
      if (actual) {
        aligned.push({
          date: forecastDateStr,
          forecast,
          actual,
          forecastCreatedAt: this.parseDate(forecast[this.options.forecastCreatedField])
        });
      }
    });

    // Warn about unmatched records
    const unmatchedForecasts = forecasts.length - aligned.length;
    if (unmatchedForecasts > 0) {
      this.warnings.push(`${unmatchedForecasts} forecast records had no matching actuals`);
    }

    return aligned;
  }

  /**
   * Assign forecast horizon to each aligned record
   * Horizon = Stay_Date - Forecast_Created_At (in days)
   */
  assignHorizons(alignedData) {
    return alignedData.map(record => {
      const stayDate = this.parseDate(record.date);
      const createdAt = record.forecastCreatedAt;

      if (!stayDate || !createdAt) {
        record.horizon = null;
        record.horizonDays = null;
        return record;
      }

      // Calculate days between forecast creation and stay date
      const horizonDays = Math.floor((stayDate - createdAt) / (1000 * 60 * 60 * 24));
      record.horizonDays = horizonDays;

      // Assign to horizon bucket
      record.horizon = this.getHorizonBucket(horizonDays);

      return record;
    });
  }

  /**
   * Get horizon bucket for a given number of days
   */
  getHorizonBucket(days) {
    for (const [key, range] of Object.entries(this.options.horizons)) {
      if (days >= range.min && days <= range.max) {
        return key;
      }
    }
    return null; // Outside defined horizons
  }

  /**
   * Calculate accuracy metrics per metric per horizon
   */
  calculateHorizonAccuracy(dataWithHorizons) {
    const results = {};

    // Initialize structure for each horizon
    Object.keys(this.options.horizons).forEach(horizon => {
      results[horizon] = {};
      this.options.metrics.forEach(metric => {
        results[horizon][metric] = {
          mape: null,
          mae: null,
          dataPoints: 0,
          errors: [],
          percentageErrors: []
        };
      });
    });

    // Group data by horizon
    const byHorizon = this.groupByHorizon(dataWithHorizons);

    // Calculate for each horizon
    Object.entries(byHorizon).forEach(([horizon, records]) => {
      if (!results[horizon]) return; // Skip records outside defined horizons

      this.options.metrics.forEach(metric => {
        const errors = [];
        const percentageErrors = [];

        records.forEach(record => {
          const forecastValue = this.getMetricValue(record.forecast, metric, 'forecast');
          const actualField = this.options.fieldMappings[metric] || metric;
          const actualValue = this.getMetricValue(record.actual, actualField, 'actual');

          // Skip if either value is null/undefined
          if (forecastValue == null || actualValue == null) return;

          // Calculate absolute error
          const error = Math.abs(forecastValue - actualValue);
          errors.push(error);

          // Calculate percentage error (avoid division by zero)
          if (actualValue !== 0) {
            const pctError = (error / Math.abs(actualValue)) * 100;
            percentageErrors.push(pctError);
          } else if (forecastValue === 0) {
            // Both are zero = perfect accuracy
            percentageErrors.push(0);
          }
          // If actual is 0 but forecast isn't, we can't calculate MAPE meaningfully
        });

        // Calculate MAE
        if (errors.length >= this.options.minDataPoints) {
          results[horizon][metric].mae = errors.reduce((sum, e) => sum + e, 0) / errors.length;
          results[horizon][metric].dataPoints = errors.length;
        }

        // Calculate MAPE
        if (percentageErrors.length >= this.options.minDataPoints) {
          results[horizon][metric].mape = percentageErrors.reduce((sum, e) => sum + e, 0) / percentageErrors.length;
        }

        // Store raw errors for debugging (optional, can be disabled)
        results[horizon][metric].errors = errors;
        results[horizon][metric].percentageErrors = percentageErrors;
      });
    });

    // Clean up raw error arrays in final output (keep only summary stats)
    Object.keys(results).forEach(horizon => {
      Object.keys(results[horizon]).forEach(metric => {
        delete results[horizon][metric].errors;
        delete results[horizon][metric].percentageErrors;
      });
    });

    return results;
  }

  /**
   * Rank metrics by accuracy (best and worst) per horizon
   */
  rankMetrics(horizonAccuracy) {
    const best = {};
    const worst = {};

    Object.entries(horizonAccuracy).forEach(([horizon, metrics]) => {
      // Get metrics with valid MAPE scores
      const validMetrics = Object.entries(metrics)
        .filter(([_, data]) => data.mape !== null)
        .map(([metric, data]) => ({
          metric,
          mape: data.mape,
          mae: data.mae,
          dataPoints: data.dataPoints
        }));

      if (validMetrics.length === 0) {
        best[horizon] = [];
        worst[horizon] = [];
        return;
      }

      // Sort by MAPE (lower is better)
      const sorted = validMetrics.sort((a, b) => a.mape - b.mape);

      // Best = lowest MAPE
      best[horizon] = sorted.slice(0, this.options.topN).map(m => ({
        metric: m.metric,
        mape: parseFloat(m.mape.toFixed(2)),
        mae: parseFloat(m.mae.toFixed(2)),
        accuracy_score: parseFloat((100 - m.mape).toFixed(2)) // Convert MAPE to accuracy %
      }));

      // Worst = highest MAPE
      worst[horizon] = sorted.slice(-this.options.topN).reverse().map(m => ({
        metric: m.metric,
        mape: parseFloat(m.mape.toFixed(2)),
        mae: parseFloat(m.mae.toFixed(2)),
        accuracy_score: parseFloat((100 - m.mape).toFixed(2))
      }));
    });

    return { best, worst };
  }

  /**
   * Calculate overall accuracy score per horizon
   * Overall = average MAPE across all metrics
   */
  calculateOverallAccuracy(horizonAccuracy) {
    const overall = {};

    Object.entries(horizonAccuracy).forEach(([horizon, metrics]) => {
      const validMapes = Object.values(metrics)
        .filter(m => m.mape !== null)
        .map(m => m.mape);

      if (validMapes.length === 0) {
        overall[horizon] = {
          mape: null,
          accuracy_score: null,
          metrics_measured: 0,
          total_data_points: 0
        };
        return;
      }

      const avgMape = validMapes.reduce((sum, m) => sum + m, 0) / validMapes.length;
      const totalDataPoints = Object.values(metrics).reduce((sum, m) => sum + m.dataPoints, 0);

      overall[horizon] = {
        mape: parseFloat(avgMape.toFixed(2)),
        accuracy_score: parseFloat((100 - avgMape).toFixed(2)),
        metrics_measured: validMapes.length,
        total_data_points: totalDataPoints
      };
    });

    return overall;
  }

  /**
   * Count records by horizon
   */
  countByHorizon(dataWithHorizons) {
    const counts = {};
    Object.keys(this.options.horizons).forEach(h => counts[h] = 0);
    counts['outside_horizons'] = 0;

    dataWithHorizons.forEach(record => {
      if (record.horizon && counts[record.horizon] !== undefined) {
        counts[record.horizon]++;
      } else {
        counts['outside_horizons']++;
      }
    });

    return counts;
  }

  /**
   * Group data by horizon
   */
  groupByHorizon(dataWithHorizons) {
    const groups = {};
    dataWithHorizons.forEach(record => {
      if (!record.horizon) return;
      if (!groups[record.horizon]) {
        groups[record.horizon] = [];
      }
      groups[record.horizon].push(record);
    });
    return groups;
  }

  /**
   * Get metric value from a record, handling field name variations
   */
  getMetricValue(record, fieldName, source) {
    // Try exact field name
    if (record[fieldName] !== undefined) {
      return this.parseNumber(record[fieldName]);
    }

    // Try common variations
    const variations = [
      fieldName,
      fieldName.replace(/_/g, ''),           // Remove underscores
      fieldName.toLowerCase(),                // Lowercase
      fieldName.replace(/_/g, '').toLowerCase()
    ];

    for (const variant of variations) {
      // Check all record keys case-insensitively
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === variant.toLowerCase()) {
          return this.parseNumber(record[key]);
        }
      }
    }

    return null;
  }

  /**
   * Parse a value as a number
   */
  parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

  /**
   * Normalize date to YYYY-MM-DD string
   */
  normalizeDate(value) {
    if (!value) return null;
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return null;
      return date.toISOString().split('T')[0];
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse a date value
   */
  parseDate(value) {
    if (!value) return null;
    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    } catch (e) {
      return null;
    }
  }

  /**
   * Append results to history file
   * @param {Array} existingHistory - Existing history array
   * @param {Object} newResult - New accuracy result to append
   * @returns {Array} Updated history array
   */
  static appendToHistory(existingHistory, newResult) {
    const history = Array.isArray(existingHistory) ? existingHistory : [];

    // Add the new result
    history.push({
      ...newResult,
      _history_added_at: new Date().toISOString()
    });

    // Sort by run date (newest last)
    history.sort((a, b) => new Date(a.forecast_run_date) - new Date(b.forecast_run_date));

    return history;
  }

  /**
   * Get accuracy trend over time for a specific horizon
   * @param {Array} history - History array
   * @param {string} horizon - Horizon key (1w, 2w, 4w, 8w)
   * @returns {Array} Array of {date, accuracy_score} objects
   */
  static getAccuracyTrend(history, horizon) {
    return history
      .filter(entry => entry.overall_accuracy && entry.overall_accuracy[horizon])
      .map(entry => ({
        date: entry.forecast_run_date,
        accuracy_score: entry.overall_accuracy[horizon].accuracy_score,
        mape: entry.overall_accuracy[horizon].mape
      }));
  }

  /**
   * Generate summary report from history
   */
  static generateTrendReport(history) {
    if (!Array.isArray(history) || history.length === 0) {
      return { error: 'No history data available' };
    }

    const horizons = ['1w', '2w', '4w', '8w'];
    const report = {
      generated_at: new Date().toISOString(),
      total_runs: history.length,
      date_range: {
        first: history[0].forecast_run_date,
        last: history[history.length - 1].forecast_run_date
      },
      trends: {}
    };

    horizons.forEach(horizon => {
      const trend = this.getAccuracyTrend(history, horizon);
      if (trend.length === 0) {
        report.trends[horizon] = null;
        return;
      }

      const scores = trend.map(t => t.accuracy_score).filter(s => s !== null);
      const latestScore = scores[scores.length - 1];
      const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;

      // Calculate improvement (latest vs first)
      const improvement = scores.length > 1 ? latestScore - scores[0] : 0;

      report.trends[horizon] = {
        latest_accuracy: latestScore,
        average_accuracy: parseFloat(avgScore.toFixed(2)),
        improvement_since_start: parseFloat(improvement.toFixed(2)),
        data_points: trend.length
      };
    });

    return report;
  }
}


// ============ N8N EXECUTION CODE ============
// This section runs when the script is executed in n8n

const input = $input.all();

// Expect two inputs: forecasts and actuals
// Can come from different sources (e.g., database query, file read)
let forecasts, actuals, existingHistory;

// Handle different input formats
if (input.length >= 2) {
  // Two separate inputs: forecasts and actuals
  forecasts = Array.isArray(input[0].json) ? input[0].json : [input[0].json];
  actuals = Array.isArray(input[1].json) ? input[1].json : [input[1].json];
  existingHistory = input[2]?.json || [];
} else if (input.length === 1 && input[0].json) {
  // Single input with named properties
  const data = input[0].json;
  forecasts = data.forecasts || [];
  actuals = data.actuals || [];
  existingHistory = data.history || [];
} else {
  throw new Error('Invalid input format. Expected forecasts and actuals data.');
}

// Flatten if nested arrays
if (forecasts.length === 1 && Array.isArray(forecasts[0])) {
  forecasts = forecasts[0];
}
if (actuals.length === 1 && Array.isArray(actuals[0])) {
  actuals = actuals[0];
}

console.log(`📊 Calculating accuracy: ${forecasts.length} forecasts, ${actuals.length} actuals`);

// Create measurement instance
const measurement = new ForecastAccuracyMeasurement({
  // Optional: customize metrics to measure
  // metrics: ['Room_Nights_Final', 'Room_Revenue', 'Total_Revenue', 'Occupancy_Pct'],

  // Optional: customize field mappings if your actuals use different field names
  // fieldMappings: {
  //   'Room_Nights_Final': 'actual_room_nights',
  //   'Room_Revenue': 'actual_room_revenue'
  // }
});

// Calculate accuracy
const accuracyResult = measurement.calculateAccuracy(forecasts, actuals);

// Append to history
const updatedHistory = ForecastAccuracyMeasurement.appendToHistory(existingHistory, accuracyResult);

// Generate trend report
const trendReport = ForecastAccuracyMeasurement.generateTrendReport(updatedHistory);

console.log(`✅ Accuracy calculated. Overall 1w accuracy: ${accuracyResult.overall_accuracy['1w']?.accuracy_score || 'N/A'}%`);

// Return results
return [{
  json: {
    success: true,
    accuracy_result: accuracyResult,
    trend_report: trendReport,
    history: updatedHistory,
    timestamp: new Date().toISOString()
  }
}];
