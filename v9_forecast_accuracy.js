/**
 * Hotel Revenue Forecasting System - Forecast Accuracy Measurement
 *
 * Evaluates forecast accuracy by comparing forecasts to actuals.
 *
 * Key Features:
 * - Compares THREE forecasting methods: Traditional, Curve-based, and Final
 * - Uses WMAPE (Weighted MAPE) as primary metric - handles zero values gracefully
 * - Focuses on PICKUP as the most important metric
 * - Tracks accuracy by forecast horizon
 *
 * Forecast Horizons:
 *   - 1w:  1-7 days ahead
 *   - 2w:  8-14 days ahead
 *   - 30d: 25-30 days ahead
 *   - 60d: 55-60 days ahead
 *   - 90d: 85-90 days ahead
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
      // Horizon definitions (days ahead when forecast was made)
      horizons: options.horizons || {
        '1w':  { min: 1, max: 7, label: '1 Week' },
        '2w':  { min: 8, max: 14, label: '2 Weeks' },
        '30d': { min: 25, max: 30, label: '30 Days' },
        '60d': { min: 55, max: 60, label: '60 Days' },
        '90d': { min: 85, max: 90, label: '90 Days' }
      },

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
      minDataPoints: options.minDataPoints || 3,

      ...options
    };

    this.results = null;
    this.warnings = [];
  }

  /**
   * Main entry point: Calculate accuracy scores
   */
  calculateAccuracy(forecasts, actuals, runDate = new Date()) {
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

    // Step 2: Calculate actual pickup for each aligned record
    this.calculateActualPickup(alignedData);

    // Step 3: Assign horizon for each aligned record
    const dataWithHorizons = this.assignHorizons(alignedData);

    // Step 4: Compare forecasting methods (Traditional vs Curve vs Final)
    const methodComparison = this.compareMethodsByHorizon(dataWithHorizons);

    // Step 5: Calculate per-metric accuracy within each horizon
    const horizonAccuracy = this.calculateHorizonAccuracy(dataWithHorizons);

    // Step 6: Calculate Pickup-specific accuracy (primary focus)
    const pickupAccuracy = this.calculatePickupAccuracy(dataWithHorizons);

    // Step 7: Identify best/worst metrics per horizon
    const rankedMetrics = this.rankMetrics(horizonAccuracy);

    // Step 8: Calculate overall accuracy per horizon
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

      // METHOD COMPARISON: Traditional vs Curve vs Final
      method_comparison: methodComparison,

      // PRIMARY METRIC: Pickup accuracy
      pickup_accuracy: pickupAccuracy,

      // Overall accuracy per horizon
      overall_accuracy: overallAccuracy,

      // Per-metric breakdown
      per_metric_accuracy: horizonAccuracy,

      // Best and worst performing metrics
      best_metrics: rankedMetrics.best,
      worst_metrics: rankedMetrics.worst,

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
   * Compare forecasting methods by horizon
   * Returns accuracy for Traditional, Curve, and Final methods
   */
  compareMethodsByHorizon(dataWithHorizons) {
    const comparison = {};
    const byHorizon = this.groupByHorizon(dataWithHorizons);

    Object.keys(this.options.horizons).forEach(horizon => {
      const records = byHorizon[horizon] || [];

      if (records.length < this.options.minDataPoints) {
        comparison[horizon] = {
          traditional: null,
          curve: null,
          final: null,
          winner: null,
          sample_size: records.length
        };
        return;
      }

      // Extract values for each method
      const traditional = { forecasts: [], actuals: [] };
      const curve = { forecasts: [], actuals: [] };
      const final = { forecasts: [], actuals: [] };

      records.forEach(record => {
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

      // Calculate accuracy for each method
      const tradAccuracy = this.calculateMethodAccuracy(traditional.forecasts, traditional.actuals);
      const curveAccuracy = this.calculateMethodAccuracy(curve.forecasts, curve.actuals);
      const finalAccuracy = this.calculateMethodAccuracy(final.forecasts, final.actuals);

      // Determine winner (lowest WMAPE)
      const methods = [
        { name: 'traditional', wmape: tradAccuracy?.wmape },
        { name: 'curve', wmape: curveAccuracy?.wmape },
        { name: 'final', wmape: finalAccuracy?.wmape }
      ].filter(m => m.wmape != null);

      const winner = methods.length > 0
        ? methods.reduce((best, m) => m.wmape < best.wmape ? m : best).name
        : null;

      comparison[horizon] = {
        traditional: tradAccuracy,
        curve: curveAccuracy,
        final: finalAccuracy,
        winner,
        sample_size: records.length
      };

      // Calculate improvement of curve over traditional
      if (tradAccuracy?.wmape != null && curveAccuracy?.wmape != null) {
        comparison[horizon].curve_vs_traditional = {
          improvement_pct: parseFloat((tradAccuracy.wmape - curveAccuracy.wmape).toFixed(2)),
          curve_is_better: curveAccuracy.wmape < tradAccuracy.wmape
        };
      }
    });

    return comparison;
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
   * Calculate Pickup-specific accuracy (PRIMARY METRIC)
   */
  calculatePickupAccuracy(dataWithHorizons) {
    const pickupAccuracy = {};
    const byHorizon = this.groupByHorizon(dataWithHorizons);

    Object.keys(this.options.horizons).forEach(horizon => {
      const records = byHorizon[horizon] || [];
      const forecasts = [];
      const actuals = [];

      records.forEach(record => {
        const forecastPickup = this.getMetricValue(record.forecast, 'Pickup', 'forecast');
        const actualPickup = record.actualPickup;

        if (forecastPickup != null && actualPickup != null) {
          forecasts.push(forecastPickup);
          actuals.push(actualPickup);
        }
      });

      if (forecasts.length >= this.options.minDataPoints) {
        const wmape = this.calculateWMAPE(forecasts, actuals);
        const mae = this.calculateMAE(forecasts, actuals);

        pickupAccuracy[horizon] = {
          wmape: wmape != null ? parseFloat(wmape.toFixed(2)) : null,
          mae: mae != null ? parseFloat(mae.toFixed(2)) : null,
          accuracy: wmape != null ? parseFloat((100 - wmape).toFixed(2)) : null,
          sample_size: forecasts.length,
          avg_forecast_pickup: parseFloat((forecasts.reduce((a, b) => a + b, 0) / forecasts.length).toFixed(1)),
          avg_actual_pickup: parseFloat((actuals.reduce((a, b) => a + b, 0) / actuals.length).toFixed(1))
        };
      } else {
        pickupAccuracy[horizon] = {
          wmape: null,
          mae: null,
          accuracy: null,
          sample_size: forecasts.length
        };
      }
    });

    return pickupAccuracy;
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
   * Assign forecast horizon to each aligned record
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

      const horizonDays = Math.floor((stayDate - createdAt) / (1000 * 60 * 60 * 24));
      record.horizonDays = horizonDays;
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
    return null;
  }

  /**
   * Calculate accuracy metrics per metric per horizon (using WMAPE)
   */
  calculateHorizonAccuracy(dataWithHorizons) {
    const results = {};
    const byHorizon = this.groupByHorizon(dataWithHorizons);

    Object.keys(this.options.horizons).forEach(horizon => {
      results[horizon] = {};
      const records = byHorizon[horizon] || [];

      this.options.metrics.forEach(metric => {
        const forecasts = [];
        const actuals = [];

        records.forEach(record => {
          let forecastValue, actualValue;

          // Special handling for Pickup
          if (metric === 'Pickup') {
            forecastValue = this.getMetricValue(record.forecast, 'Pickup', 'forecast');
            actualValue = record.actualPickup;
          } else {
            forecastValue = this.getMetricValue(record.forecast, metric, 'forecast');
            const actualField = this.options.fieldMappings[metric] || metric;
            actualValue = this.getMetricValue(record.actual, actualField, 'actual');
          }

          if (forecastValue != null && actualValue != null) {
            forecasts.push(forecastValue);
            actuals.push(actualValue);
          }
        });

        if (forecasts.length >= this.options.minDataPoints) {
          const wmape = this.calculateWMAPE(forecasts, actuals);
          const mae = this.calculateMAE(forecasts, actuals);

          results[horizon][metric] = {
            wmape: wmape != null ? parseFloat(wmape.toFixed(2)) : null,
            mae: mae != null ? parseFloat(mae.toFixed(2)) : null,
            accuracy: wmape != null ? parseFloat((100 - wmape).toFixed(2)) : null,
            dataPoints: forecasts.length
          };
        } else {
          results[horizon][metric] = {
            wmape: null,
            mae: null,
            accuracy: null,
            dataPoints: forecasts.length
          };
        }
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
      const validMetrics = Object.entries(metrics)
        .filter(([_, data]) => data.wmape !== null)
        .map(([metric, data]) => ({
          metric,
          wmape: data.wmape,
          mae: data.mae,
          accuracy: data.accuracy,
          dataPoints: data.dataPoints
        }));

      if (validMetrics.length === 0) {
        best[horizon] = [];
        worst[horizon] = [];
        return;
      }

      // Sort by WMAPE (lower is better)
      const sorted = validMetrics.sort((a, b) => a.wmape - b.wmape);

      best[horizon] = sorted.slice(0, this.options.topN).map(m => ({
        metric: m.metric,
        wmape: m.wmape,
        mae: m.mae,
        accuracy: m.accuracy
      }));

      worst[horizon] = sorted.slice(-this.options.topN).reverse().map(m => ({
        metric: m.metric,
        wmape: m.wmape,
        mae: m.mae,
        accuracy: m.accuracy
      }));
    });

    return { best, worst };
  }

  /**
   * Calculate overall accuracy score per horizon
   */
  calculateOverallAccuracy(horizonAccuracy) {
    const overall = {};

    Object.entries(horizonAccuracy).forEach(([horizon, metrics]) => {
      const validWmapes = Object.values(metrics)
        .filter(m => m.wmape !== null)
        .map(m => m.wmape);

      if (validWmapes.length === 0) {
        overall[horizon] = {
          wmape: null,
          accuracy: null,
          metrics_measured: 0,
          total_data_points: 0
        };
        return;
      }

      const avgWmape = validWmapes.reduce((sum, m) => sum + m, 0) / validWmapes.length;
      const totalDataPoints = Object.values(metrics).reduce((sum, m) => sum + m.dataPoints, 0);

      overall[horizon] = {
        wmape: parseFloat(avgWmape.toFixed(2)),
        accuracy: parseFloat((100 - avgWmape).toFixed(2)),
        metrics_measured: validWmapes.length,
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
   * Get accuracy trend over time for a specific horizon
   */
  static getAccuracyTrend(history, horizon) {
    return history
      .filter(entry => entry.overall_accuracy && entry.overall_accuracy[horizon])
      .map(entry => ({
        date: entry.forecast_run_date,
        accuracy: entry.overall_accuracy[horizon].accuracy,
        wmape: entry.overall_accuracy[horizon].wmape,
        pickup_accuracy: entry.pickup_accuracy?.[horizon]?.accuracy || null
      }));
  }

  /**
   * Get method comparison trend over time
   */
  static getMethodTrend(history, horizon) {
    return history
      .filter(entry => entry.method_comparison && entry.method_comparison[horizon])
      .map(entry => ({
        date: entry.forecast_run_date,
        traditional_accuracy: entry.method_comparison[horizon].traditional?.accuracy || null,
        curve_accuracy: entry.method_comparison[horizon].curve?.accuracy || null,
        winner: entry.method_comparison[horizon].winner
      }));
  }

  /**
   * Generate summary report from history
   */
  static generateTrendReport(history) {
    if (!Array.isArray(history) || history.length === 0) {
      return { error: 'No history data available' };
    }

    const horizons = ['1w', '2w', '30d', '60d', '90d'];
    const report = {
      generated_at: new Date().toISOString(),
      total_runs: history.length,
      date_range: {
        first: history[0].forecast_run_date,
        last: history[history.length - 1].forecast_run_date
      },
      trends: {},
      method_trends: {},
      pickup_trends: {}
    };

    horizons.forEach(horizon => {
      // Overall accuracy trend
      const trend = this.getAccuracyTrend(history, horizon);
      if (trend.length > 0) {
        const scores = trend.map(t => t.accuracy).filter(s => s !== null);
        const latestScore = scores[scores.length - 1];
        const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
        const improvement = scores.length > 1 ? latestScore - scores[0] : 0;

        report.trends[horizon] = {
          latest_accuracy: latestScore,
          average_accuracy: parseFloat(avgScore.toFixed(2)),
          improvement_since_start: parseFloat(improvement.toFixed(2)),
          data_points: trend.length
        };
      }

      // Method comparison trend
      const methodTrend = this.getMethodTrend(history, horizon);
      if (methodTrend.length > 0) {
        const curveWins = methodTrend.filter(t => t.winner === 'curve').length;
        const tradWins = methodTrend.filter(t => t.winner === 'traditional').length;

        report.method_trends[horizon] = {
          curve_win_rate: parseFloat(((curveWins / methodTrend.length) * 100).toFixed(1)),
          traditional_win_rate: parseFloat(((tradWins / methodTrend.length) * 100).toFixed(1)),
          latest_winner: methodTrend[methodTrend.length - 1].winner
        };
      }

      // Pickup accuracy trend
      const pickupScores = trend.map(t => t.pickup_accuracy).filter(s => s !== null);
      if (pickupScores.length > 0) {
        report.pickup_trends[horizon] = {
          latest_accuracy: pickupScores[pickupScores.length - 1],
          average_accuracy: parseFloat((pickupScores.reduce((a, b) => a + b, 0) / pickupScores.length).toFixed(2))
        };
      }
    });

    return report;
  }
}


// ============ N8N EXECUTION CODE ============

const input = $input.all();

let forecasts, actuals, existingHistory;

// Handle different input formats
if (input.length >= 2) {
  forecasts = Array.isArray(input[0].json) ? input[0].json : [input[0].json];
  actuals = Array.isArray(input[1].json) ? input[1].json : [input[1].json];
  existingHistory = input[2]?.json || [];
} else if (input.length === 1 && input[0].json) {
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
const measurement = new ForecastAccuracyMeasurement();

// Calculate accuracy
const accuracyResult = measurement.calculateAccuracy(forecasts, actuals);

// Append to history
const updatedHistory = ForecastAccuracyMeasurement.appendToHistory(existingHistory, accuracyResult);

// Generate trend report
const trendReport = ForecastAccuracyMeasurement.generateTrendReport(updatedHistory);

// Log summary
const pickup1w = accuracyResult.pickup_accuracy['1w'];
const method1w = accuracyResult.method_comparison['1w'];
console.log(`✅ Accuracy calculated:`);
console.log(`   Pickup (1w): ${pickup1w?.accuracy || 'N/A'}% accuracy`);
console.log(`   Method winner (1w): ${method1w?.winner || 'N/A'}`);

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
