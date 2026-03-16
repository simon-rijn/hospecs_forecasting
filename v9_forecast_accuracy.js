/**
 * Hotel Revenue Forecasting System - Forecast Accuracy Measurement
 *
 * Evaluates forecast accuracy by comparing forecasts to actuals.
 *
 * Key Features:
 * - Compares THREE forecasting methods: Traditional, Curve-based, and Final
 * - Uses WMAPE (Weighted MAPE) as primary metric - handles zero values gracefully
 * - Focuses on PICKUP as the most important metric
 * - Calculates accuracy for ALL days (1-90) - no horizon buckets
 * - Only evaluates dates that have passed (stay date < today)
 *
 * Accuracy Metrics:
 *   - WMAPE: Σ|F-A| / Σ|A| × 100 (primary - handles zeros)
 *   - MAE: Σ|F-A| / n (secondary - same units as input)
 *   - Accuracy %: 100 - WMAPE (for reporting)
 *
 * Run cadence: Weekly, appending to history file for trend tracking
 */

class ForecastAccuracyMeasurement {
  constructor(options = {}) {
    this.options = {
      // Maximum forecast horizon to evaluate (days)
      maxHorizonDays: options.maxHorizonDays || 90,

      // PRIMARY METRIC: Pickup (the core forecasting challenge)
      primaryMetric: 'Pickup',

      // Metrics to measure accuracy for
      metrics: options.metrics || [
        'Pickup',              // PRIMARY - most important
        'Room_Nights_Final',
        'Room_Revenue',
        'FB_Revenue',
        'Other_Revenue',
        'Total_Revenue',
        'Expected_ADR',
        'Occupancy_Pct',
        'RevPAR',
        'TRevPAR'
      ],

      // Method comparison metrics (room nights only)
      methodMetrics: ['Room_Nights_Traditional', 'Room_Nights_Curve', 'Room_Nights_Final'],

      // Field mappings (forecast field -> actual field if different)
      fieldMappings: options.fieldMappings || {
        'Room_Nights_Final': 'RoomNights',
        'Room_Nights_Traditional': 'RoomNights',
        'Room_Nights_Curve': 'RoomNights',
        'Expected_ADR': 'ADR',
        'Occupancy_Pct': 'Occupancy',
        'Room_Revenue': 'RoomRevenue',
        'FB_Revenue': 'FB_Revenue',
        'Other_Revenue': 'OtherRevenue',
        'Total_Revenue': 'TotalRevenue'
      },

      // Date field names
      forecastDateField: options.forecastDateField || 'Stay_Date',
      actualDateField: options.actualDateField || 'Date',
      forecastCreatedField: options.forecastCreatedField || 'Forecast_Created_At',

      // OTB field for calculating actual pickup
      otbRoomNightsField: options.otbRoomNightsField || 'OTB_Room_Nights',

      // Top N for best/worst metrics
      topN: options.topN || 3,

      // Minimum data points required for valid accuracy calculation
      minDataPoints: options.minDataPoints || 1,

      ...options
    };

    this.results = null;
    this.warnings = [];
  }

  /**
   * Main entry point: Calculate accuracy scores
   * Only evaluates dates that have passed (stay date < today)
   */
  calculateAccuracy(forecasts, actuals, runDate = new Date()) {
    if (!Array.isArray(forecasts) || forecasts.length === 0) {
      throw new Error('CRITICAL: No forecast data provided');
    }
    if (!Array.isArray(actuals) || actuals.length === 0) {
      throw new Error('CRITICAL: No actuals data provided');
    }

    const today = new Date(runDate);
    today.setHours(0, 0, 0, 0);

    // Step 1: Align forecast and actual data by date
    const alignedData = this.alignDataByDate(forecasts, actuals);

    if (alignedData.length === 0) {
      throw new Error('CRITICAL: No matching dates between forecast and actuals');
    }

    // Step 2: Filter to only dates that have passed
    const pastDatesOnly = alignedData.filter(record => {
      const stayDate = this.parseDate(record.date);
      return stayDate && stayDate < today;
    });

    if (pastDatesOnly.length === 0) {
      throw new Error('CRITICAL: No past dates found - all forecasted dates are in the future');
    }

    // Step 3: Calculate actual pickup for each aligned record
    this.calculateActualPickup(pastDatesOnly);

    // Step 4: Calculate days ahead for each record
    const dataWithDaysAhead = this.assignDaysAhead(pastDatesOnly);

    // Step 5: Calculate per-day accuracy for all metrics
    const perDayAccuracy = this.calculatePerDayAccuracy(dataWithDaysAhead);

    // Step 6: Compare forecasting methods (Traditional vs Curve vs Final)
    const methodComparison = this.compareMethodsOverall(dataWithDaysAhead);

    // Step 7: Calculate overall summary statistics
    const overallSummary = this.calculateOverallSummary(perDayAccuracy);

    // Build final result
    this.results = {
      forecast_run_date: runDate.toISOString(),

      data_summary: {
        total_forecasts: forecasts.length,
        total_actuals: actuals.length,
        matched_records: alignedData.length,
        past_dates_evaluated: pastDatesOnly.length,
        future_dates_skipped: alignedData.length - pastDatesOnly.length
      },

      // Per-day accuracy (all 90 days)
      per_day_accuracy: perDayAccuracy,

      // METHOD COMPARISON: Traditional vs Curve vs Final
      method_comparison: methodComparison,

      // Overall summary statistics
      overall_summary: overallSummary,

      warnings: this.warnings
    };

    return this.results;
  }

  /**
   * Calculate actual pickup for each aligned record
   * Actual Pickup = Actual RoomNights - OTB RoomNights (at forecast time)
   */
  calculateActualPickup(alignedData) {
    alignedData.forEach(record => {
      const actualRoomNights = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      const otbRoomNights = this.getMetricValue(record.forecast, this.options.otbRoomNightsField, 'forecast');

      if (actualRoomNights != null && otbRoomNights != null) {
        record.actualPickup = Math.max(0, actualRoomNights - otbRoomNights);
      } else {
        record.actualPickup = null;
      }
    });
  }


  /**
   * Calculate accuracy metrics for a set of forecast/actual pairs
   */
  calculateMethodAccuracy(forecasts, actuals) {
    if (forecasts.length < this.options.minDataPoints) {
      return null;
    }

    const wmape = this.calculateWMAPE(forecasts, actuals);
    const mae = this.calculateMAE(forecasts, actuals);

    return {
      wmape: wmape != null ? parseFloat(wmape.toFixed(2)) : null,
      mae: mae != null ? parseFloat(mae.toFixed(2)) : null,
      accuracy: wmape != null ? parseFloat((100 - wmape).toFixed(2)) : null,
      sample_size: forecasts.length
    };
  }

  /**
   * Calculate WMAPE (Weighted Mean Absolute Percentage Error)
   * WMAPE = Σ|F-A| / Σ|A| × 100
   * Handles zero actuals gracefully
   */
  calculateWMAPE(forecasts, actuals) {
    let sumAbsError = 0;
    let sumActual = 0;

    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sumAbsError += Math.abs(forecasts[i] - actuals[i]);
        sumActual += Math.abs(actuals[i]);
      }
    }

    // Handle edge case: all actuals are zero
    if (sumActual === 0) {
      return sumAbsError === 0 ? 0 : null;
    }

    return (sumAbsError / sumActual) * 100;
  }

  /**
   * Calculate MAE (Mean Absolute Error)
   * MAE = Σ|F-A| / n
   */
  calculateMAE(forecasts, actuals) {
    let sumAbsError = 0;
    let count = 0;

    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sumAbsError += Math.abs(forecasts[i] - actuals[i]);
        count++;
      }
    }

    return count > 0 ? sumAbsError / count : null;
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

    const unmatchedForecasts = forecasts.length - aligned.length;
    if (unmatchedForecasts > 0) {
      this.warnings.push(`${unmatchedForecasts} forecast records had no matching actuals`);
    }

    return aligned;
  }

  /**
   * Assign days ahead for each aligned record
   */
  assignDaysAhead(alignedData) {
    return alignedData.map(record => {
      const stayDate = this.parseDate(record.date);
      const createdAt = record.forecastCreatedAt;

      if (!stayDate || !createdAt) {
        record.daysAhead = null;
        return record;
      }

      const daysAhead = Math.floor((stayDate - createdAt) / (1000 * 60 * 60 * 24));
      record.daysAhead = daysAhead;

      return record;
    });
  }

  /**
   * Calculate accuracy for each day (no buckets)
   * Returns detailed per-day accuracy for all metrics
   */
  calculatePerDayAccuracy(dataWithDaysAhead) {
    const perDayResults = [];

    dataWithDaysAhead.forEach(record => {
      const dayResult = {
        stay_date: record.date,
        days_ahead: record.daysAhead,
        metrics: {}
      };

      // Calculate accuracy for each metric
      this.options.metrics.forEach(metric => {
        let forecastValue, actualValue;

        if (metric === 'Pickup') {
          forecastValue = this.getMetricValue(record.forecast, 'Pickup', 'forecast');
          actualValue = record.actualPickup;
        } else {
          forecastValue = this.getMetricValue(record.forecast, metric, 'forecast');
          const actualField = this.options.fieldMappings[metric] || metric;
          actualValue = this.getMetricValue(record.actual, actualField, 'actual');
        }

        if (forecastValue != null && actualValue != null) {
          const error = forecastValue - actualValue;
          const absError = Math.abs(error);
          const pctError = actualValue !== 0 ? (absError / Math.abs(actualValue)) * 100 : null;

          dayResult.metrics[metric] = {
            forecast: parseFloat(forecastValue.toFixed(2)),
            actual: parseFloat(actualValue.toFixed(2)),
            error: parseFloat(error.toFixed(2)),
            abs_error: parseFloat(absError.toFixed(2)),
            pct_error: pctError != null ? parseFloat(pctError.toFixed(2)) : null
          };
        }
      });

      // Add method comparison for room nights
      const actualRoomNights = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      if (actualRoomNights != null) {
        dayResult.method_comparison = {
          traditional: this.getMetricValue(record.forecast, 'Room_Nights_Traditional', 'forecast'),
          curve: this.getMetricValue(record.forecast, 'Room_Nights_Curve', 'forecast'),
          final: this.getMetricValue(record.forecast, 'Room_Nights_Final', 'forecast'),
          actual: actualRoomNights
        };
      }

      perDayResults.push(dayResult);
    });

    // Sort by days ahead
    perDayResults.sort((a, b) => (a.days_ahead || 0) - (b.days_ahead || 0));

    return perDayResults;
  }

  /**
   * Compare forecasting methods overall (not by horizon)
   */
  compareMethodsOverall(dataWithDaysAhead) {
    const traditional = { forecasts: [], actuals: [] };
    const curve = { forecasts: [], actuals: [] };
    const final = { forecasts: [], actuals: [] };

    dataWithDaysAhead.forEach(record => {
      const actualRoomNights = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      if (actualRoomNights == null) return;

      const tradValue = this.getMetricValue(record.forecast, 'Room_Nights_Traditional', 'forecast');
      const curveValue = this.getMetricValue(record.forecast, 'Room_Nights_Curve', 'forecast');
      const finalValue = this.getMetricValue(record.forecast, 'Room_Nights_Final', 'forecast');

      if (tradValue != null) {
        traditional.forecasts.push(tradValue);
        traditional.actuals.push(actualRoomNights);
      }
      if (curveValue != null) {
        curve.forecasts.push(curveValue);
        curve.actuals.push(actualRoomNights);
      }
      if (finalValue != null) {
        final.forecasts.push(finalValue);
        final.actuals.push(actualRoomNights);
      }
    });

    const tradAccuracy = this.calculateMethodAccuracy(traditional.forecasts, traditional.actuals);
    const curveAccuracy = this.calculateMethodAccuracy(curve.forecasts, curve.actuals);
    const finalAccuracy = this.calculateMethodAccuracy(final.forecasts, final.actuals);

    // Determine winner
    const methods = [
      { name: 'traditional', wmape: tradAccuracy?.wmape },
      { name: 'curve', wmape: curveAccuracy?.wmape },
      { name: 'final', wmape: finalAccuracy?.wmape }
    ].filter(m => m.wmape != null);

    const winner = methods.length > 0
      ? methods.reduce((best, m) => m.wmape < best.wmape ? m : best).name
      : null;

    return {
      traditional: tradAccuracy,
      curve: curveAccuracy,
      final: finalAccuracy,
      winner,
      curve_vs_traditional: tradAccuracy?.wmape != null && curveAccuracy?.wmape != null
        ? {
            improvement_pct: parseFloat((tradAccuracy.wmape - curveAccuracy.wmape).toFixed(2)),
            curve_is_better: curveAccuracy.wmape < tradAccuracy.wmape
          }
        : null
    };
  }

  /**
   * Calculate overall summary statistics from per-day accuracy
   */
  calculateOverallSummary(perDayAccuracy) {
    const summary = {
      total_days_evaluated: perDayAccuracy.length,
      metrics: {}
    };

    // Aggregate by metric
    this.options.metrics.forEach(metric => {
      const values = perDayAccuracy
        .filter(day => day.metrics[metric])
        .map(day => day.metrics[metric]);

      if (values.length === 0) {
        summary.metrics[metric] = null;
        return;
      }

      const forecasts = values.map(v => v.forecast);
      const actuals = values.map(v => v.actual);
      const absErrors = values.map(v => v.abs_error);

      const wmape = this.calculateWMAPE(forecasts, actuals);
      const mae = absErrors.reduce((sum, e) => sum + e, 0) / absErrors.length;

      summary.metrics[metric] = {
        wmape: wmape != null ? parseFloat(wmape.toFixed(2)) : null,
        mae: parseFloat(mae.toFixed(2)),
        accuracy: wmape != null ? parseFloat((100 - wmape).toFixed(2)) : null,
        sample_size: values.length
      };
    });

    // Rank metrics by accuracy
    const rankedMetrics = Object.entries(summary.metrics)
      .filter(([_, data]) => data?.wmape != null)
      .map(([metric, data]) => ({ metric, ...data }))
      .sort((a, b) => a.wmape - b.wmape);

    summary.best_metrics = rankedMetrics.slice(0, this.options.topN);
    summary.worst_metrics = rankedMetrics.slice(-this.options.topN).reverse();

    return summary;
  }


  /**
   * Get metric value from a record
   */
  getMetricValue(record, fieldName, source) {
    if (record[fieldName] !== undefined) {
      return this.parseNumber(record[fieldName]);
    }

    // Try common variations
    const variations = [
      fieldName,
      fieldName.replace(/_/g, ''),
      fieldName.toLowerCase(),
      fieldName.replace(/_/g, '').toLowerCase()
    ];

    for (const variant of variations) {
      for (const key of Object.keys(record)) {
        if (key.toLowerCase() === variant.toLowerCase()) {
          return this.parseNumber(record[key]);
        }
      }
    }

    return null;
  }

  parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return isNaN(num) ? null : num;
  }

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
   */
  static appendToHistory(existingHistory, newResult) {
    const history = Array.isArray(existingHistory) ? existingHistory : [];
    history.push({
      ...newResult,
      _history_added_at: new Date().toISOString()
    });
    history.sort((a, b) => new Date(a.forecast_run_date) - new Date(b.forecast_run_date));
    return history;
  }

  /**
   * Get accuracy trend over time (overall)
   */
  static getAccuracyTrend(history) {
    return history
      .filter(entry => entry.overall_summary)
      .map(entry => ({
        date: entry.forecast_run_date,
        pickup_accuracy: entry.overall_summary.metrics?.Pickup?.accuracy || null,
        room_nights_accuracy: entry.overall_summary.metrics?.Room_Nights_Final?.accuracy || null,
        days_evaluated: entry.data_summary?.past_dates_evaluated || 0
      }));
  }

  /**
   * Get method comparison trend over time
   */
  static getMethodTrend(history) {
    return history
      .filter(entry => entry.method_comparison)
      .map(entry => ({
        date: entry.forecast_run_date,
        traditional_accuracy: entry.method_comparison.traditional?.accuracy || null,
        curve_accuracy: entry.method_comparison.curve?.accuracy || null,
        winner: entry.method_comparison.winner
      }));
  }

  /**
   * Generate summary report from history
   */
  static generateTrendReport(history) {
    if (!Array.isArray(history) || history.length === 0) {
      return { error: 'No history data available' };
    }

    const report = {
      generated_at: new Date().toISOString(),
      total_runs: history.length,
      date_range: {
        first: history[0].forecast_run_date,
        last: history[history.length - 1].forecast_run_date
      },
      accuracy_trend: this.getAccuracyTrend(history),
      method_trend: this.getMethodTrend(history)
    };

    // Calculate improvement over time
    const accuracyTrend = report.accuracy_trend;
    if (accuracyTrend.length > 1) {
      const first = accuracyTrend[0];
      const last = accuracyTrend[accuracyTrend.length - 1];

      report.improvement = {
        pickup: first.pickup_accuracy && last.pickup_accuracy
          ? parseFloat((last.pickup_accuracy - first.pickup_accuracy).toFixed(2))
          : null,
        room_nights: first.room_nights_accuracy && last.room_nights_accuracy
          ? parseFloat((last.room_nights_accuracy - first.room_nights_accuracy).toFixed(2))
          : null
      };
    }

    // Method win rates
    const methodTrend = report.method_trend;
    if (methodTrend.length > 0) {
      const curveWins = methodTrend.filter(t => t.winner === 'curve').length;
      const tradWins = methodTrend.filter(t => t.winner === 'traditional').length;

      report.method_win_rates = {
        curve: parseFloat(((curveWins / methodTrend.length) * 100).toFixed(1)),
        traditional: parseFloat(((tradWins / methodTrend.length) * 100).toFixed(1)),
        latest_winner: methodTrend[methodTrend.length - 1].winner
      };
    }

    return report;
  }
}


// ============ FORECAST STORAGE HELPER ============

/**
 * Extract lightweight forecast data for storage
 * Only saves true forecasts (9 fields) not derived metrics
 */
function extractForecastsForStorage(forecasts) {
  return forecasts.map(f => ({
    // Identity & Timing
    Stay_Date: f.Stay_Date,
    Forecast_Created_At: new Date().toISOString(),

    // Core Room Night Forecasts
    Pickup: f.Pickup,
    OTB_Room_Nights: f.OTB_Room_Nights,
    Room_Nights_Traditional: f.Room_Nights_Traditional,
    Room_Nights_Curve: f.Room_Nights_Curve,

    // Rate Forecast
    Expected_ADR: f.Expected_ADR,

    // Revenue Forecasts (validate ratio assumptions)
    FB_Revenue: f.FB_Revenue,
    Other_Revenue: f.Other_Revenue
  }));
}

/**
 * Convert forecasts to Excel-compatible format (array of rows)
 * Each forecast run becomes a sheet with ~90 rows
 */
function forecastsToExcelRows(forecasts) {
  const headers = [
    'Stay_Date',
    'Forecast_Created_At',
    'Pickup',
    'OTB_Room_Nights',
    'Room_Nights_Traditional',
    'Room_Nights_Curve',
    'Expected_ADR',
    'FB_Revenue',
    'Other_Revenue'
  ];

  const rows = [headers];

  forecasts.forEach(f => {
    rows.push([
      f.Stay_Date,
      f.Forecast_Created_At,
      f.Pickup,
      f.OTB_Room_Nights,
      f.Room_Nights_Traditional,
      f.Room_Nights_Curve,
      f.Expected_ADR,
      f.FB_Revenue,
      f.Other_Revenue
    ]);
  });

  return rows;
}

/**
 * Generate sheet name from forecast date
 * Format: YYYY-MM-DD (Excel-safe)
 */
function generateSheetName(forecastDate) {
  const date = new Date(forecastDate);
  return date.toISOString().split('T')[0];
}


// ============ N8N EXECUTION CODE ============

const input = $input.all();

let forecasts, actuals, existingHistory, mode;

// Handle different input formats
if (input.length >= 2) {
  forecasts = Array.isArray(input[0].json) ? input[0].json : [input[0].json];
  actuals = Array.isArray(input[1].json) ? input[1].json : [input[1].json];
  existingHistory = input[2]?.json || [];
  mode = 'accuracy';
} else if (input.length === 1 && input[0].json) {
  const data = input[0].json;

  // Check if this is a "save forecasts" operation
  if (data.mode === 'save') {
    mode = 'save';
    forecasts = data.forecasts || [];
  } else {
    mode = 'accuracy';
    forecasts = data.forecasts || [];
    actuals = data.actuals || [];
    existingHistory = data.history || [];
  }
} else {
  throw new Error('Invalid input format. Expected forecasts and actuals data.');
}

// Flatten if nested arrays
if (forecasts && forecasts.length === 1 && Array.isArray(forecasts[0])) {
  forecasts = forecasts[0];
}
if (actuals && actuals.length === 1 && Array.isArray(actuals[0])) {
  actuals = actuals[0];
}

// ============ MODE: SAVE FORECASTS ============
if (mode === 'save') {
  console.log(`💾 Extracting ${forecasts.length} forecasts for storage`);

  const forecastsToSave = extractForecastsForStorage(forecasts);
  const excelRows = forecastsToExcelRows(forecastsToSave);
  const sheetName = generateSheetName(new Date());

  console.log(`✅ Prepared ${forecastsToSave.length} forecasts for sheet: ${sheetName}`);

  return [{
    json: {
      success: true,
      mode: 'save',
      forecasts_to_save: forecastsToSave,
      excel_rows: excelRows,
      sheet_name: sheetName,
      row_count: forecastsToSave.length,
      timestamp: new Date().toISOString()
    }
  }];
}

// ============ MODE: CALCULATE ACCURACY ============
console.log(`📊 Calculating accuracy: ${forecasts.length} forecasts, ${actuals.length} actuals`);

// Create measurement instance
const measurement = new ForecastAccuracyMeasurement();

// Calculate accuracy (only past dates)
const accuracyResult = measurement.calculateAccuracy(forecasts, actuals);

// Append to history
const updatedHistory = ForecastAccuracyMeasurement.appendToHistory(existingHistory, accuracyResult);

// Generate trend report
const trendReport = ForecastAccuracyMeasurement.generateTrendReport(updatedHistory);

// Log summary
const pickupAccuracy = accuracyResult.overall_summary?.metrics?.Pickup;
const methodWinner = accuracyResult.method_comparison?.winner;
console.log(`✅ Accuracy calculated:`);
console.log(`   Days evaluated: ${accuracyResult.data_summary.past_dates_evaluated}`);
console.log(`   Pickup accuracy: ${pickupAccuracy?.accuracy || 'N/A'}%`);
console.log(`   Method winner: ${methodWinner || 'N/A'}`);

// Return results
return [{
  json: {
    success: true,
    mode: 'accuracy',
    accuracy_result: accuracyResult,
    trend_report: trendReport,
    history: updatedHistory,
    timestamp: new Date().toISOString()
  }
}];
