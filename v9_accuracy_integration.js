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
        'Room_Nights_Final'
      ],
      methodMetrics: ['Room_Nights_Traditional', 'Room_Nights_Curve', 'Room_Nights_Final'],
      fieldMappings: options.fieldMappings || {
        'Room_Nights_Final': 'RoomNights',
        'Room_Nights_Traditional': 'RoomNights',
        'Room_Nights_Curve': 'RoomNights'
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
    const methodComparison  = this.compareMethodsOverall(dataWithDaysAhead);
    const accuracyCurves    = this.calculateAccuracyByHorizon(dataWithDaysAhead);
    const forecastRuns      = this.calculatePerRunAccuracy(dataWithDaysAhead);

    this.results = {
      forecast_run_date: runDate.toISOString(),
      data_summary: {
        total_forecasts: forecasts.length,
        total_actuals: actuals.length,
        matched_records: alignedData.length,
        past_dates_evaluated: pastDatesOnly.length,
        future_dates_skipped: alignedData.length - pastDatesOnly.length,
        forecast_runs_found: forecastRuns.length
      },
      summary: {
        traditional: methodComparison.traditional,
        curve: methodComparison.curve,
        final: methodComparison.final,
        winner: methodComparison.winner
      },
      forecast_runs: forecastRuns,
      accuracy_curves: accuracyCurves,
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
    const mae   = this.calculateMAE(forecasts, actuals);
    const bias  = this.calculateBias(forecasts, actuals);
    const cons  = this.calculateConsistency(forecasts, actuals);

    return {
      wmape:       wmape != null ? parseFloat(wmape.toFixed(2)) : null,
      mae:         mae   != null ? parseFloat(mae.toFixed(2))   : null,
      accuracy:    wmape != null ? parseFloat((100 - wmape).toFixed(2)) : null,
      bias:        bias  != null ? parseFloat(bias.toFixed(2))  : null,
      consistency: cons  != null ? parseFloat(cons.toFixed(2))  : null,
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

  // Mean signed error in rooms. Positive = optimistic (over-forecast), negative = pessimistic.
  calculateBias(forecasts, actuals) {
    let sum = 0, count = 0;
    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sum += forecasts[i] - actuals[i];
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  // Standard deviation of signed errors in rooms. High = erratic, low = consistent.
  calculateConsistency(forecasts, actuals) {
    const errors = [];
    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        errors.push(forecasts[i] - actuals[i]);
      }
    }
    if (errors.length < 2) return null;
    const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
    const variance = errors.reduce((s, e) => s + (e - mean) ** 2, 0) / errors.length;
    return Math.sqrt(variance);
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
      // Prefer the pre-computed field stored on the forecast record itself,
      // because Forecast_Created_At can reflect DB write time rather than
      // the date the forecast was originally generated.
      const duaRaw = record.forecast?.[this.options.daysUntilArrivalField || 'Days_Until_Arrival'];
      const dua = this.parseNumber(duaRaw);
      if (dua != null) {
        record.daysAhead = Math.round(dua);
        return record;
      }

      // Fallback: derive from dates
      const stayDate = this.parseDate(record.date);
      const createdAt = record.forecastCreatedAt;

      if (!stayDate || !createdAt) {
        record.daysAhead = null;
        return record;
      }

      record.daysAhead = Math.floor((stayDate - createdAt) / (1000 * 60 * 60 * 24));
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
    const horizonBands = { '1_7': 0, '8_30': 0, '31_60': 0, '61_90': 0, 'over_90': 0 };

    dataWithDaysAhead.forEach(record => {
      // Only evaluate forecasts made before the stay date; post-arrival records
      // have an already-final OTB and add noise rather than signal.
      if (record.daysAhead == null || record.daysAhead < 1) return;

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
        // Track which horizon bands are contributing to the overall metric
        const d = record.daysAhead;
        if      (d <=  7)  horizonBands['1_7']++;
        else if (d <= 30)  horizonBands['8_30']++;
        else if (d <= 60)  horizonBands['31_60']++;
        else if (d <= 90)  horizonBands['61_90']++;
        else               horizonBands['over_90']++;
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
      horizon_band_counts: horizonBands,
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
   * Calculate accuracy per forecast run (grouped by Forecast_Created_At).
   * Returns one entry per distinct run date, sorted oldest → newest.
   * Enables a time-series chart: "how did accuracy change across runs?"
   */
  calculatePerRunAccuracy(dataWithDaysAhead) {
    const byRun = new Map();

    dataWithDaysAhead.forEach(record => {
      if (record.daysAhead == null || record.daysAhead < 1) return;

      const runDate = record.forecastCreatedAt;
      if (!runDate) return;

      const runKey     = runDate instanceof Date ? runDate.toISOString() : String(runDate);
      const runDateStr = runKey.split('T')[0];

      if (!byRun.has(runKey)) {
        byRun.set(runKey, {
          forecast_run_date: runDateStr,
          traditional: { forecasts: [], actuals: [] },
          curve:        { forecasts: [], actuals: [] },
          final:        { forecasts: [], actuals: [] }
        });
      }

      const group      = byRun.get(runKey);
      const rnActual   = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      if (rnActual == null) return;

      const tradF  = this.getMetricValue(record.forecast, 'Room_Nights_Traditional', 'forecast');
      const curveF = this.getMetricValue(record.forecast, 'Room_Nights_Curve',       'forecast');
      const finalF = this.getMetricValue(record.forecast, 'Room_Nights_Final',       'forecast');

      if (tradF  != null) { group.traditional.forecasts.push(tradF);  group.traditional.actuals.push(rnActual); }
      if (curveF != null) { group.curve.forecasts.push(curveF);        group.curve.actuals.push(rnActual); }
      if (finalF != null) { group.final.forecasts.push(finalF);        group.final.actuals.push(rnActual); }
    });

    return Array.from(byRun.values())
      .sort((a, b) => a.forecast_run_date.localeCompare(b.forecast_run_date))
      .map(run => ({
        forecast_run_date: run.forecast_run_date,
        traditional: this.calculateMethodAccuracy(run.traditional.forecasts, run.traditional.actuals),
        curve:       this.calculateMethodAccuracy(run.curve.forecasts,       run.curve.actuals),
        final:       this.calculateMethodAccuracy(run.final.forecasts,       run.final.actuals)
      }));
  }

  /**
   * Calculate accuracy curves by forecast horizon (days_ahead) for each method.
   * Returns three arrays of 90 data points (days 1-90) — one per method.
   *
   * This answers: "How accurate is method X when forecasting N days ahead?"
   */
  calculateAccuracyByHorizon(dataWithDaysAhead) {
    const byHorizon = {};

    dataWithDaysAhead.forEach(record => {
      const horizon = record.daysAhead;
      if (horizon == null || horizon < 1 || horizon > 90) return;

      if (!byHorizon[horizon]) {
        byHorizon[horizon] = {
          traditional: { forecasts: [], actuals: [] },
          curve:        { forecasts: [], actuals: [] },
          final:        { forecasts: [], actuals: [] }
        };
      }

      const rnActual = this.getMetricValue(record.actual, 'RoomNights', 'actual');
      if (rnActual == null) return;

      const tradForecast  = this.getMetricValue(record.forecast, 'Room_Nights_Traditional', 'forecast');
      const curveForecast = this.getMetricValue(record.forecast, 'Room_Nights_Curve', 'forecast');
      const finalForecast = this.getMetricValue(record.forecast, 'Room_Nights_Final', 'forecast');

      if (tradForecast != null)  { byHorizon[horizon].traditional.forecasts.push(tradForecast);  byHorizon[horizon].traditional.actuals.push(rnActual); }
      if (curveForecast != null) { byHorizon[horizon].curve.forecasts.push(curveForecast);        byHorizon[horizon].curve.actuals.push(rnActual); }
      if (finalForecast != null) { byHorizon[horizon].final.forecasts.push(finalForecast);        byHorizon[horizon].final.actuals.push(rnActual); }
    });

    const buildCurve = (methodKey) => {
      const points = [];
      for (let day = 1; day <= 90; day++) {
        const d = byHorizon[day]?.[methodKey];
        // Route through calculateMethodAccuracy so minDataPoints is enforced
        // consistently — horizon points with too few samples return null metrics.
        const result = d ? this.calculateMethodAccuracy(d.forecasts, d.actuals) : null;
        if (result) {
          points.push({
            days_ahead:  day,
            sample_size: result.sample_size,
            wmape:       result.wmape,
            accuracy:    result.accuracy,
            mae:         result.mae
          });
        } else {
          points.push({ days_ahead: day, sample_size: d?.forecasts.length ?? 0, wmape: null, accuracy: null, mae: null });
        }
      }
      return points;
    };

    return {
      traditional: buildCurve('traditional'),
      curve:       buildCurve('curve'),
      final:       buildCurve('final')
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

// Debug: Show structure of first few inputs
allInputs.slice(0, 3).forEach((item, i) => {
  console.log(`Input ${i} keys:`, Object.keys(item.json || {}));
  if (item.json && typeof item.json === 'object') {
    const sample = JSON.stringify(item.json).substring(0, 200);
    console.log(`Input ${i} sample:`, sample);
  }
});

// Separate forecast arrays from actuals
// Input structure: merged arrays where some contain forecast data, others contain housestate
let forecastArrays = [];
let actuals = [];

// Helper to check if record is a forecast
function isForecast(record) {
  if (!record || typeof record !== 'object') return false;
  // Check for Stay_Date (or StayDate) and Pickup
  const hasStayDate = record.Stay_Date !== undefined || record.StayDate !== undefined;
  const hasPickup = record.Pickup !== undefined;
  return hasStayDate && hasPickup;
}

// Helper to check if record is actuals
function isActual(record) {
  if (!record || typeof record !== 'object') return false;
  return record.Date !== undefined && record.RoomNights !== undefined;
}

// Helper to normalize forecast record
function normalizeForecast(record) {
  if (record.StayDate && !record.Stay_Date) {
    record.Stay_Date = record.StayDate;
  }
  // Room_Nights_Traditional and Room_Nights_Curve are output directly by the
  // forecast engine (v9_hotel_forecasting_output.js) and do not need derivation.
  //
  // Legacy fallback only — for exports that pre-date the direct output fields.
  // NOTE: OTB + Pickup is lossy when pickup is clamped to 0 (forecast < OTB),
  // so this will understate the traditional forecast in those cases.
  if (record.Room_Nights_Traditional == null && record.Pickup_Traditional != null) {
    const otb = parseFloat(record.OTB_Room_Nights) || 0;
    record.Room_Nights_Traditional = otb + (parseFloat(record.Pickup_Traditional) || 0);
  }
  if (record.Room_Nights_Curve == null && record.Pickup_Curve != null) {
    const otb = parseFloat(record.OTB_Room_Nights) || 0;
    record.Room_Nights_Curve = otb + (parseFloat(record.Pickup_Curve) || 0);
  }
  return record;
}

// Recursively find forecasts and actuals in nested structures
function extractRecords(obj, depth = 0) {
  if (depth > 5) return; // Prevent infinite recursion

  if (Array.isArray(obj)) {
    obj.forEach(item => extractRecords(item, depth + 1));
  } else if (obj && typeof obj === 'object') {
    if (isForecast(obj)) {
      forecastArrays.push(normalizeForecast(obj));
    } else if (isActual(obj)) {
      actuals.push(obj);
    } else {
      // Check common wrapper keys
      const wrapperKeys = ['Forecasts', 'forecasts', 'data', 'records', 'items', 'rows'];
      for (const key of wrapperKeys) {
        if (obj[key] && (Array.isArray(obj[key]) || typeof obj[key] === 'object')) {
          extractRecords(obj[key], depth + 1);
        }
      }
      // Also check all array-valued keys
      Object.values(obj).forEach(val => {
        if (Array.isArray(val)) {
          extractRecords(val, depth + 1);
        }
      });
    }
  }
}

allInputs.forEach((item, index) => {
  extractRecords(item.json);
});

console.log('Forecast records found:', forecastArrays.length);
console.log('Actuals records found:', actuals.length);

// Debug: Show sample of what was found
if (forecastArrays.length > 0) {
  console.log('Sample forecast:', JSON.stringify(forecastArrays[0]).substring(0, 200));
}
if (actuals.length > 0) {
  console.log('Sample actual:', JSON.stringify(actuals[0]).substring(0, 200));
}

// Validate we have data
if (forecastArrays.length === 0) {
  // Provide more helpful error message
  const sampleKeys = allInputs.slice(0, 3).map(item => Object.keys(item.json || {}));
  throw new Error(`No forecast data found. Expected records with Stay_Date and Pickup fields. Input keys found: ${JSON.stringify(sampleKeys)}`);
}

if (actuals.length === 0) {
  throw new Error('No actuals data found in input. Expected records with Date and RoomNights fields.');
}

// Run accuracy calculation
const measurement = new ForecastAccuracyMeasurement();
const accuracyResult = measurement.calculateAccuracy(forecastArrays, actuals);


// Format email-friendly summary
const s = accuracyResult.summary;

const emailSummary = `FORECAST ACCURACY REPORT
========================
Run Date: ${new Date().toISOString().split('T')[0]}
Days Evaluated: ${accuracyResult.data_summary.past_dates_evaluated}

OVERALL ACCURACY (Room Nights)
  Traditional: ${s.traditional?.accuracy ?? 'N/A'}%  (WMAPE ${s.traditional?.wmape ?? 'N/A'}%, MAE ${s.traditional?.mae ?? 'N/A'} rooms)
  Curve:       ${s.curve?.accuracy ?? 'N/A'}%  (WMAPE ${s.curve?.wmape ?? 'N/A'}%, MAE ${s.curve?.mae ?? 'N/A'} rooms)
  Final:       ${s.final?.accuracy ?? 'N/A'}%  (WMAPE ${s.final?.wmape ?? 'N/A'}%, MAE ${s.final?.mae ?? 'N/A'} rooms)
  Winner: ${s.winner ?? 'N/A'}
`;

console.log(emailSummary);

// ============ HTML REPORT ============
const ds   = accuracyResult.data_summary;
const runs = accuracyResult.forecast_runs  || [];
const ac   = accuracyResult.accuracy_curves || {};
const bands = s.horizon_band_counts || {};

// Curve series — one value per day 1-90
function curveAccuracySeries(methodKey) {
  const pts = ac[methodKey] || [];
  return pts.map(p => ({ x: p.days_ahead, y: p.accuracy, n: p.sample_size }));
}

const curveTrad  = JSON.stringify(curveAccuracySeries('traditional'));
const curveCurve = JSON.stringify(curveAccuracySeries('curve'));
const curveFinal = JSON.stringify(curveAccuracySeries('final'));

// Per-run series
const runLabels = JSON.stringify(runs.map(r => r.forecast_run_date));
const runTrad   = JSON.stringify(runs.map(r => r.traditional?.accuracy ?? null));
const runCurve  = JSON.stringify(runs.map(r => r.curve?.accuracy      ?? null));
const runFinal  = JSON.stringify(runs.map(r => r.final?.accuracy      ?? null));
const runSize   = JSON.stringify(runs.map(r => r.final?.sample_size   ?? 0));

// Horizon band bar data
const bandLabels = JSON.stringify(['1–7d', '8–30d', '31–60d', '61–90d', '>90d']);
const bandData   = JSON.stringify([
  bands['1_7'] || 0, bands['8_30'] || 0,
  bands['31_60'] || 0, bands['61_90'] || 0, bands['over_90'] || 0
]);

function fmt(v, unit = '%') { return v != null ? `${v}${unit}` : '—'; }
const reportDate = new Date().toISOString().split('T')[0];

const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Forecast Accuracy Report — ${reportDate}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f4f6f9; color: #1a1a2e; padding: 24px; }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
  .meta { font-size: 0.85rem; color: #666; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .card { background: #fff; border-radius: 10px; padding: 18px 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  .card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: .05em; color: #888; margin-bottom: 6px; }
  .card .value { font-size: 1.8rem; font-weight: 700; }
  .card .sub   { font-size: 0.8rem; color: #888; margin-top: 4px; }
  .card.winner { border-left: 4px solid #22c55e; }
  .section { background: #fff; border-radius: 10px; padding: 20px 24px; box-shadow: 0 1px 4px rgba(0,0,0,.08); margin-bottom: 24px; }
  .section h2 { font-size: 1rem; font-weight: 600; margin-bottom: 16px; color: #333; }
  .chart-wrap { position: relative; height: 300px; }
  .method-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .method-table th { text-align: left; padding: 8px 12px; background: #f8f9fb; font-weight: 600; color: #555; border-bottom: 2px solid #e5e7eb; }
  .method-table td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
  .method-table tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-gray  { background: #f1f5f9; color: #475569; }
  .warn { background: #fffbeb; border-left: 3px solid #f59e0b; padding: 10px 14px; border-radius: 6px; font-size: 0.85rem; color: #78350f; margin-top: 12px; }
</style>
</head>
<body>
<h1>Forecast Accuracy Report</h1>
<p class="meta">Generated ${reportDate} &nbsp;·&nbsp; ${ds.forecast_runs_found} forecast runs &nbsp;·&nbsp; ${ds.past_dates_evaluated} stay dates evaluated &nbsp;·&nbsp; ${ds.matched_records} matched records</p>

<!-- Summary cards -->
<div class="grid">
  <div class="card${s.winner === 'traditional' ? ' winner' : ''}">
    <div class="label">Traditional</div>
    <div class="value">${fmt(s.traditional?.accuracy)}</div>
    <div class="sub">WMAPE ${fmt(s.traditional?.wmape)} &nbsp;·&nbsp; n=${s.traditional?.sample_size ?? '—'}</div>
  </div>
  <div class="card${s.winner === 'curve' ? ' winner' : ''}">
    <div class="label">Curve</div>
    <div class="value">${fmt(s.curve?.accuracy)}</div>
    <div class="sub">WMAPE ${fmt(s.curve?.wmape)} &nbsp;·&nbsp; n=${s.curve?.sample_size ?? '—'}</div>
  </div>
  <div class="card${s.winner === 'final' ? ' winner' : ''}">
    <div class="label">Final</div>
    <div class="value">${fmt(s.final?.accuracy)}</div>
    <div class="sub">WMAPE ${fmt(s.final?.wmape)} &nbsp;·&nbsp; n=${s.final?.sample_size ?? '—'}</div>
  </div>
  <div class="card">
    <div class="label">Winner</div>
    <div class="value" style="font-size:1.3rem;text-transform:capitalize">${s.winner ?? '—'}</div>
    <div class="sub">${s.curve_vs_traditional ? (s.curve_vs_traditional.curve_is_better ? 'Curve beats traditional' : 'Traditional beats curve') + ' by ' + Math.abs(s.curve_vs_traditional.improvement_pct) + 'pp' : ''}</div>
  </div>
</div>

<!-- Method comparison table -->
<div class="section">
  <h2>Method Comparison</h2>
  <table class="method-table">
    <thead><tr><th>Method</th><th>Accuracy</th><th>WMAPE</th><th>MAE (rooms)</th><th>Bias</th><th>Consistency</th><th>Sample</th></tr></thead>
    <tbody>
      ${['traditional','curve','final'].map(m => {
        const d = s[m];
        const isWinner = s.winner === m;
        return d ? '<tr>' +
          '<td>' + m.charAt(0).toUpperCase() + m.slice(1) + (isWinner ? ' <span class="badge badge-green">winner</span>' : '') + '</td>' +
          '<td><strong>' + fmt(d.accuracy) + '</strong></td>' +
          '<td>' + fmt(d.wmape) + '</td>' +
          '<td>' + fmt(d.mae, '') + '</td>' +
          '<td>' + fmt(d.bias, '') + '</td>' +
          '<td>' + fmt(d.consistency, '') + '</td>' +
          '<td><span class="badge badge-gray">' + d.sample_size + '</span></td>' +
          '</tr>' : '';
      }).join('')}
    </tbody>
  </table>
</div>

<!-- Accuracy curves by horizon -->
<div class="section">
  <h2>Accuracy by Forecast Horizon</h2>
  <p class="meta" style="margin-bottom:12px">How accurate is each method when forecasting N days before arrival? Points with insufficient data (< minDataPoints) are omitted.</p>
  <div class="chart-wrap"><canvas id="horizonChart"></canvas></div>
</div>

<!-- Per-run accuracy -->
<div class="section">
  <h2>Accuracy per Forecast Run</h2>
  <p class="meta" style="margin-bottom:12px">Each bar = one forecast run. Bar colour = sample size. Runs with very few matching past dates are unreliable.</p>
  <div class="chart-wrap"><canvas id="runChart"></canvas></div>
</div>

<!-- Horizon band distribution -->
<div class="section">
  <h2>Horizon Band Distribution</h2>
  <p class="meta" style="margin-bottom:12px">How many records in the overall metric come from each horizon band. A heavily skewed distribution means the overall score mainly reflects one horizon.</p>
  <div class="chart-wrap" style="height:220px"><canvas id="bandChart"></canvas></div>
</div>

<script>
const TRAD_COLOR  = 'rgb(59,130,246)';
const CURVE_COLOR = 'rgb(234,88,12)';
const FINAL_COLOR = 'rgb(22,163,74)';
const ALPHA = 0.15;

// 1. Horizon accuracy curve
(function() {
  const tradPts  = ${curveTrad};
  const curvePts = ${curveCurve};
  const finalPts = ${curveFinal};
  const labels = Array.from({length: 90}, (_, i) => i + 1);
  function toY(pts) {
    return labels.map(d => { const p = pts.find(p => p.x === d); return p ? p.y : null; });
  }
  new Chart(document.getElementById('horizonChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Traditional', data: toY(tradPts),  borderColor: TRAD_COLOR,  backgroundColor: TRAD_COLOR.replace(')',','+ALPHA+')').replace('rgb','rgba'),  tension: 0.3, spanGaps: false, pointRadius: 2 },
        { label: 'Curve',       data: toY(curvePts), borderColor: CURVE_COLOR, backgroundColor: CURVE_COLOR.replace(')',','+ALPHA+')').replace('rgb','rgba'), tension: 0.3, spanGaps: false, pointRadius: 2 },
        { label: 'Final',       data: toY(finalPts), borderColor: FINAL_COLOR, backgroundColor: FINAL_COLOR.replace(')',','+ALPHA+')').replace('rgb','rgba'), tension: 0.3, spanGaps: false, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' }, tooltip: { callbacks: {
        label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + '%' : '—')
      }}},
      scales: {
        x: { title: { display: true, text: 'Days before arrival' } },
        y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100,
             ticks: { callback: v => v + '%' } }
      }
    }
  });
})();

// 2. Per-run accuracy
(function() {
  const labels  = ${runLabels};
  const trad    = ${runTrad};
  const curve   = ${runCurve};
  const fin     = ${runFinal};
  const sizes   = ${runSize};
  const maxSize = Math.max(...sizes, 1);
  new Chart(document.getElementById('runChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Traditional', data: trad, backgroundColor: TRAD_COLOR.replace(')',',0.7)').replace('rgb','rgba'),  borderColor: TRAD_COLOR,  borderWidth: 1 },
        { label: 'Curve',       data: curve, backgroundColor: CURVE_COLOR.replace(')',',0.7)').replace('rgb','rgba'), borderColor: CURVE_COLOR, borderWidth: 1 },
        { label: 'Final',       data: fin,   backgroundColor: FINAL_COLOR.replace(')',',0.7)').replace('rgb','rgba'), borderColor: FINAL_COLOR, borderWidth: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' }, tooltip: { callbacks: {
        afterBody: ctx => 'Sample size: ' + (sizes[ctx[0].dataIndex] ?? '—')
      }}},
      scales: {
        x: { title: { display: true, text: 'Forecast run date' } },
        y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100,
             ticks: { callback: v => v + '%' } }
      }
    }
  });
})();

// 3. Horizon band distribution
(function() {
  new Chart(document.getElementById('bandChart'), {
    type: 'bar',
    data: {
      labels: ${bandLabels},
      datasets: [{ label: 'Records', data: ${bandData},
        backgroundColor: ['rgba(59,130,246,0.7)','rgba(234,88,12,0.7)','rgba(22,163,74,0.7)','rgba(168,85,247,0.7)','rgba(148,163,184,0.7)'],
        borderWidth: 0, borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: 'Horizon band' } },
        y: { title: { display: true, text: 'Records' }, beginAtZero: true }
      }
    }
  });
})();
<\/script>
</body>
</html>`;

return [{
  json: {
    success: true,
    data_summary:    accuracyResult.data_summary,
    summary:         accuracyResult.summary,
    forecast_runs:   accuracyResult.forecast_runs,
    accuracy_curves: accuracyResult.accuracy_curves,
    warnings:        accuracyResult.warnings,
    email_summary:   emailSummary,
    email_subject:   `Forecast Accuracy Report - ${reportDate}`,
    html_report:     htmlReport,
    timestamp:       new Date().toISOString()
  }
}];
