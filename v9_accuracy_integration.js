// ============ FORECAST ACCURACY INTEGRATION ============
// Wrapper that handles merge node input and calculates accuracy
//
// Input 0: Up to 15 forecast arrays (from DB, each containing ~90 forecast records)
// Input 1: ~100 days of historical housestate (actuals)

// ============ FORECAST ACCURACY CLASS (embedded) ============

class ForecastAccuracyMeasurement {
  constructor(options = {}) {
    this.options = {
      maxHorizonDays: options.maxHorizonDays || 90,
      primaryMetric: 'Pickup',
      metrics: options.metrics || [
        'Pickup',
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
      methodMetrics: ['Room_Nights_Traditional', 'Room_Nights_Curve', 'Room_Nights_Final'],
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
      forecastDateField: options.forecastDateField || 'Stay_Date',
      actualDateField: options.actualDateField || 'Date',
      forecastCreatedField: options.forecastCreatedField || 'Forecast_Created_At',
      otbRoomNightsField: options.otbRoomNightsField || 'OTB_Room_Nights',
      topN: options.topN || 3,
      minDataPoints: options.minDataPoints || 1,
      ...options
    };
    this.results = null;
    this.warnings = [];
  }

  calculateAccuracy(forecasts, actuals, runDate = new Date()) {
    if (!Array.isArray(forecasts) || forecasts.length === 0) {
      throw new Error('CRITICAL: No forecast data provided');
    }
    if (!Array.isArray(actuals) || actuals.length === 0) {
      throw new Error('CRITICAL: No actuals data provided');
    }

    const today = new Date(runDate);
    today.setHours(0, 0, 0, 0);

    const alignedData = this.alignDataByDate(forecasts, actuals);

    if (alignedData.length === 0) {
      throw new Error('CRITICAL: No matching dates between forecast and actuals');
    }

    const pastDatesOnly = alignedData.filter(record => {
      const stayDate = this.parseDate(record.date);
      return stayDate && stayDate < today;
    });

    if (pastDatesOnly.length === 0) {
      throw new Error('CRITICAL: No past dates found - all forecasted dates are in the future');
    }

    this.calculateActualPickup(pastDatesOnly);
    const dataWithDaysAhead = this.assignDaysAhead(pastDatesOnly);
    const perDayAccuracy = this.calculatePerDayAccuracy(dataWithDaysAhead);
    const methodComparison = this.compareMethodsOverall(dataWithDaysAhead);
    const overallSummary = this.calculateOverallSummary(perDayAccuracy);
    const accuracyByHorizon = this.calculateAccuracyByHorizon(dataWithDaysAhead);

    this.results = {
      forecast_run_date: runDate.toISOString(),
      data_summary: {
        total_forecasts: forecasts.length,
        total_actuals: actuals.length,
        matched_records: alignedData.length,
        past_dates_evaluated: pastDatesOnly.length,
        future_dates_skipped: alignedData.length - pastDatesOnly.length
      },
      per_day_accuracy: perDayAccuracy,
      method_comparison: methodComparison,
      overall_summary: overallSummary,
      accuracy_by_horizon: accuracyByHorizon,
      warnings: this.warnings
    };

    return this.results;
  }

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

  calculateWMAPE(forecasts, actuals) {
    let sumAbsError = 0;
    let sumActual = 0;

    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sumAbsError += Math.abs(forecasts[i] - actuals[i]);
        sumActual += Math.abs(actuals[i]);
      }
    }

    if (sumActual === 0) {
      return sumAbsError === 0 ? 0 : null;
    }

    return (sumAbsError / sumActual) * 100;
  }

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

  alignDataByDate(forecasts, actuals) {
    const aligned = [];

    const actualsMap = new Map();
    actuals.forEach(actual => {
      const dateStr = this.normalizeDate(actual[this.options.actualDateField]);
      if (dateStr) {
        actualsMap.set(dateStr, actual);
      }
    });

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

  calculatePerDayAccuracy(dataWithDaysAhead) {
    const perDayResults = [];

    dataWithDaysAhead.forEach(record => {
      const dayResult = {
        stay_date: record.date,
        days_ahead: record.daysAhead,
        metrics: {}
      };

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

    perDayResults.sort((a, b) => (a.days_ahead || 0) - (b.days_ahead || 0));

    return perDayResults;
  }

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

  calculateOverallSummary(perDayAccuracy) {
    const summary = {
      total_days_evaluated: perDayAccuracy.length,
      metrics: {}
    };

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

    const rankedMetrics = Object.entries(summary.metrics)
      .filter(([_, data]) => data?.wmape != null)
      .map(([metric, data]) => ({ metric, ...data }))
      .sort((a, b) => a.wmape - b.wmape);

    summary.best_metrics = rankedMetrics.slice(0, this.options.topN);
    summary.worst_metrics = rankedMetrics.slice(-this.options.topN).reverse();

    return summary;
  }

  /**
   * Calculate accuracy curve by forecast horizon (days_ahead)
   * Returns 90 data points showing accuracy at each horizon from 1-90 days
   *
   * This answers: "How accurate are forecasts made N days before the stay date?"
   */
  calculateAccuracyByHorizon(dataWithDaysAhead) {
    // Group data by days_ahead (horizon)
    const byHorizon = {};

    dataWithDaysAhead.forEach(record => {
      const horizon = record.daysAhead;
      if (horizon == null || horizon < 1 || horizon > 90) return;

      if (!byHorizon[horizon]) {
        byHorizon[horizon] = {
          pickup: { forecasts: [], actuals: [] },
          roomNights: { forecasts: [], actuals: [] },
          traditional: { forecasts: [], actuals: [] },
          curve: { forecasts: [], actuals: [] }
        };
      }

      // Pickup
      const pickupForecast = this.getMetricValue(record.forecast, 'Pickup', 'forecast');
      const pickupActual = record.actualPickup;
      if (pickupForecast != null && pickupActual != null) {
        byHorizon[horizon].pickup.forecasts.push(pickupForecast);
        byHorizon[horizon].pickup.actuals.push(pickupActual);
      }

      // Room Nights (Final)
      const rnForecast = this.getMetricValue(record.forecast, 'Room_Nights_Final', 'forecast');
      const rnActual = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      if (rnForecast != null && rnActual != null) {
        byHorizon[horizon].roomNights.forecasts.push(rnForecast);
        byHorizon[horizon].roomNights.actuals.push(rnActual);
      }

      // Traditional method
      const tradForecast = this.getMetricValue(record.forecast, 'Room_Nights_Traditional', 'forecast');
      if (tradForecast != null && rnActual != null) {
        byHorizon[horizon].traditional.forecasts.push(tradForecast);
        byHorizon[horizon].traditional.actuals.push(rnActual);
      }

      // Curve method
      const curveForecast = this.getMetricValue(record.forecast, 'Room_Nights_Curve', 'forecast');
      if (curveForecast != null && rnActual != null) {
        byHorizon[horizon].curve.forecasts.push(curveForecast);
        byHorizon[horizon].curve.actuals.push(rnActual);
      }
    });

    // Build accuracy curve with 90 data points
    const accuracyCurve = [];

    for (let day = 1; day <= 90; day++) {
      const data = byHorizon[day];

      const point = {
        days_ahead: day,
        sample_size: data ? data.pickup.forecasts.length : 0,
        pickup: null,
        room_nights: null,
        traditional: null,
        curve: null
      };

      if (data && data.pickup.forecasts.length > 0) {
        const pickupWmape = this.calculateWMAPE(data.pickup.forecasts, data.pickup.actuals);
        point.pickup = {
          wmape: pickupWmape != null ? parseFloat(pickupWmape.toFixed(2)) : null,
          accuracy: pickupWmape != null ? parseFloat((100 - pickupWmape).toFixed(2)) : null,
          mae: parseFloat(this.calculateMAE(data.pickup.forecasts, data.pickup.actuals).toFixed(2))
        };
      }

      if (data && data.roomNights.forecasts.length > 0) {
        const rnWmape = this.calculateWMAPE(data.roomNights.forecasts, data.roomNights.actuals);
        point.room_nights = {
          wmape: rnWmape != null ? parseFloat(rnWmape.toFixed(2)) : null,
          accuracy: rnWmape != null ? parseFloat((100 - rnWmape).toFixed(2)) : null,
          mae: parseFloat(this.calculateMAE(data.roomNights.forecasts, data.roomNights.actuals).toFixed(2))
        };
      }

      if (data && data.traditional.forecasts.length > 0) {
        const tradWmape = this.calculateWMAPE(data.traditional.forecasts, data.traditional.actuals);
        point.traditional = {
          wmape: tradWmape != null ? parseFloat(tradWmape.toFixed(2)) : null,
          accuracy: tradWmape != null ? parseFloat((100 - tradWmape).toFixed(2)) : null
        };
      }

      if (data && data.curve.forecasts.length > 0) {
        const curveWmape = this.calculateWMAPE(data.curve.forecasts, data.curve.actuals);
        point.curve = {
          wmape: curveWmape != null ? parseFloat(curveWmape.toFixed(2)) : null,
          accuracy: curveWmape != null ? parseFloat((100 - curveWmape).toFixed(2)) : null
        };
      }

      accuracyCurve.push(point);
    }

    // Calculate curve statistics
    const validPoints = accuracyCurve.filter(p => p.pickup?.accuracy != null);
    const curveStats = {
      data_points_with_data: validPoints.length,
      avg_accuracy: validPoints.length > 0
        ? parseFloat((validPoints.reduce((sum, p) => sum + p.pickup.accuracy, 0) / validPoints.length).toFixed(2))
        : null,
      best_horizon: null,
      worst_horizon: null,
      accuracy_at_7_days: accuracyCurve[6]?.pickup?.accuracy ?? null,
      accuracy_at_14_days: accuracyCurve[13]?.pickup?.accuracy ?? null,
      accuracy_at_30_days: accuracyCurve[29]?.pickup?.accuracy ?? null,
      accuracy_at_60_days: accuracyCurve[59]?.pickup?.accuracy ?? null,
      accuracy_at_90_days: accuracyCurve[89]?.pickup?.accuracy ?? null,
      // Flatness metric: difference between best and worst accuracy
      flatness: null
    };

    if (validPoints.length > 0) {
      const sorted = [...validPoints].sort((a, b) => b.pickup.accuracy - a.pickup.accuracy);
      curveStats.best_horizon = { days: sorted[0].days_ahead, accuracy: sorted[0].pickup.accuracy };
      curveStats.worst_horizon = { days: sorted[sorted.length - 1].days_ahead, accuracy: sorted[sorted.length - 1].pickup.accuracy };
      curveStats.flatness = parseFloat((curveStats.best_horizon.accuracy - curveStats.worst_horizon.accuracy).toFixed(2));
    }

    return {
      curve: accuracyCurve,
      stats: curveStats
    };
  }

  getMetricValue(record, fieldName, source) {
    if (record[fieldName] !== undefined) {
      return this.parseNumber(record[fieldName]);
    }

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
}


// ============ N8N INTEGRATION CODE ============

const allInputs = $input.all();

console.log('Total inputs received:', allInputs.length);

// Separate forecast arrays from actuals
// Input structure: merged arrays where some contain forecast data, others contain housestate
let forecastArrays = [];
let actuals = [];

allInputs.forEach((item, index) => {
  const data = item.json;

  // Check if this is a forecast record (has Stay_Date and Pickup fields)
  if (data.Stay_Date && data.Pickup !== undefined) {
    forecastArrays.push(data);
  }
  // Check if this is an actuals record (has Date and RoomNights fields)
  else if (data.Date && data.RoomNights !== undefined) {
    actuals.push(data);
  }
  // Check if this is a nested array of forecasts
  else if (Array.isArray(data)) {
    data.forEach(record => {
      if (record.Stay_Date && record.Pickup !== undefined) {
        forecastArrays.push(record);
      } else if (record.Date && record.RoomNights !== undefined) {
        actuals.push(record);
      }
    });
  }
  // Check if this contains a Forecasts array (from parse node)
  else if (data.Forecasts && Array.isArray(data.Forecasts)) {
    forecastArrays.push(...data.Forecasts);
  }
});

console.log('Forecast records found:', forecastArrays.length);
console.log('Actuals records found:', actuals.length);

// Validate we have data
if (forecastArrays.length === 0) {
  throw new Error('No forecast data found in input. Expected records with Stay_Date and Pickup fields.');
}

if (actuals.length === 0) {
  throw new Error('No actuals data found in input. Expected records with Date and RoomNights fields.');
}

// Run accuracy calculation
const measurement = new ForecastAccuracyMeasurement();
const accuracyResult = measurement.calculateAccuracy(forecastArrays, actuals);

// Format email-friendly summary
const pickupAccuracy = accuracyResult.overall_summary?.metrics?.Pickup;
const methodWinner = accuracyResult.method_comparison?.winner;
const roomRevenueAccuracy = accuracyResult.overall_summary?.metrics?.Room_Revenue;
const totalRevenueAccuracy = accuracyResult.overall_summary?.metrics?.Total_Revenue;
const horizonStats = accuracyResult.accuracy_by_horizon?.stats;

const emailSummary = `FORECAST ACCURACY REPORT
========================
Run Date: ${new Date().toISOString().split('T')[0]}
Days Evaluated: ${accuracyResult.data_summary.past_dates_evaluated}

PRIMARY METRIC - PICKUP
  Accuracy: ${pickupAccuracy?.accuracy ?? 'N/A'}%
  WMAPE: ${pickupAccuracy?.wmape ?? 'N/A'}%

METHOD COMPARISON (Room Nights)
  Traditional: ${accuracyResult.method_comparison.traditional?.accuracy ?? 'N/A'}%
  Curve-based: ${accuracyResult.method_comparison.curve?.accuracy ?? 'N/A'}%
  Winner: ${methodWinner ?? 'N/A'}

ACCURACY BY HORIZON (Pickup)
  7 days out:  ${horizonStats?.accuracy_at_7_days ?? 'N/A'}%
  14 days out: ${horizonStats?.accuracy_at_14_days ?? 'N/A'}%
  30 days out: ${horizonStats?.accuracy_at_30_days ?? 'N/A'}%
  60 days out: ${horizonStats?.accuracy_at_60_days ?? 'N/A'}%
  90 days out: ${horizonStats?.accuracy_at_90_days ?? 'N/A'}%

  Best horizon:  ${horizonStats?.best_horizon?.days ?? 'N/A'} days (${horizonStats?.best_horizon?.accuracy ?? 'N/A'}%)
  Worst horizon: ${horizonStats?.worst_horizon?.days ?? 'N/A'} days (${horizonStats?.worst_horizon?.accuracy ?? 'N/A'}%)
  Flatness (spread): ${horizonStats?.flatness ?? 'N/A'}% (lower = more consistent)

REVENUE ACCURACY
  Room Revenue: ${roomRevenueAccuracy?.accuracy ?? 'N/A'}%
  Total Revenue: ${totalRevenueAccuracy?.accuracy ?? 'N/A'}%
`;

console.log(emailSummary);

// Extract the 90-point accuracy curve for charting
const accuracyCurve = accuracyResult.accuracy_by_horizon?.curve || [];

return [{
  json: {
    success: true,
    accuracy_result: accuracyResult,
    accuracy_curve: accuracyCurve,
    horizon_stats: horizonStats,
    email_summary: emailSummary,
    email_subject: `Forecast Accuracy Report - ${new Date().toISOString().split('T')[0]}`,
    timestamp: new Date().toISOString()
  }
}];
