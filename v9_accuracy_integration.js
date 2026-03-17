// ============ FORECAST ACCURACY INTEGRATION ============
// Compares three room-night forecast methods (Traditional, Curve, Final)
// against actuals and reports WMAPE-based accuracy scores.
//
// Input 0: Forecast records — one per stay date per run
//   Required fields: Stay_Date, Forecast_Created_At,
//                    Room_Nights_Traditional, Room_Nights_Curve, Room_Nights_Final
//
// Input 1: Actuals (housestate) — one per past date
//   Required fields: Date, RoomNights

// ============ FORECAST ACCURACY CLASS ============

class ForecastAccuracyMeasurement {
  constructor(options = {}) {
    this.options = {
      maxHorizonDays:       options.maxHorizonDays       || 90,
      forecastDateField:    options.forecastDateField    || 'Stay_Date',
      actualDateField:      options.actualDateField      || 'Date',
      forecastCreatedField: options.forecastCreatedField || 'Forecast_Created_At',
      minDataPoints:        options.minDataPoints        || 1,
      ...options
    };
    this.warnings = [];
  }

  calculateAccuracy(forecasts, actuals, runDate = new Date()) {
    if (!Array.isArray(forecasts) || forecasts.length === 0)
      throw new Error('CRITICAL: No forecast data provided');
    if (!Array.isArray(actuals) || actuals.length === 0)
      throw new Error('CRITICAL: No actuals data provided');

    const today = new Date(runDate);
    today.setHours(0, 0, 0, 0);

    const aligned = this.alignDataByDate(forecasts, actuals);
    if (aligned.length === 0)
      throw new Error('CRITICAL: No matching dates between forecast and actuals');

    const past = aligned.filter(r => {
      const d = this.parseDate(r.date);
      return d && d < today;
    });
    if (past.length === 0)
      throw new Error('CRITICAL: No past dates found — all forecasted dates are in the future');

    const data             = this.assignDaysAhead(past);
    const methodComparison = this.compareMethodsOverall(data);
    const accuracyCurves   = this.calculateAccuracyByHorizon(data);
    const forecastRuns     = this.calculatePerRunAccuracy(data);

    return {
      forecast_run_date: runDate.toISOString(),
      data_summary: {
        total_forecasts:      forecasts.length,
        total_actuals:        actuals.length,
        matched_records:      aligned.length,
        past_dates_evaluated: past.length,
        future_dates_skipped: aligned.length - past.length,
        forecast_runs_found:  forecastRuns.length
      },
      summary: {
        traditional:          methodComparison.traditional,
        curve:                methodComparison.curve,
        final:                methodComparison.final,
        winner:               methodComparison.winner,
        horizon_band_counts:  methodComparison.horizon_band_counts,
        curve_vs_traditional: methodComparison.curve_vs_traditional
      },
      forecast_runs:   forecastRuns,
      accuracy_curves: accuracyCurves,
      warnings:        this.warnings
    };
  }

  // ---- Math helpers ----

  calculateMethodAccuracy(forecasts, actuals) {
    if (forecasts.length < this.options.minDataPoints) return null;

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
    let sumAbsError = 0, sumActual = 0;
    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sumAbsError += Math.abs(forecasts[i] - actuals[i]);
        sumActual   += Math.abs(actuals[i]);
      }
    }
    if (sumActual === 0) return sumAbsError === 0 ? 0 : null;
    return (sumAbsError / sumActual) * 100;
  }

  calculateMAE(forecasts, actuals) {
    let sumAbsError = 0, count = 0;
    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null) {
        sumAbsError += Math.abs(forecasts[i] - actuals[i]);
        count++;
      }
    }
    return count > 0 ? sumAbsError / count : null;
  }

  // Mean signed error. Positive = over-forecast, negative = under-forecast.
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

  // Std deviation of signed errors. High = erratic, low = consistent.
  calculateConsistency(forecasts, actuals) {
    const errors = [];
    for (let i = 0; i < forecasts.length; i++) {
      if (forecasts[i] != null && actuals[i] != null)
        errors.push(forecasts[i] - actuals[i]);
    }
    if (errors.length < 2) return null;
    const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
    const variance = errors.reduce((s, e) => s + (e - mean) ** 2, 0) / errors.length;
    return Math.sqrt(variance);
  }

  // ---- Data alignment ----

  alignDataByDate(forecasts, actuals) {
    const actualsMap = new Map();
    actuals.forEach(actual => {
      const dateStr = this.normalizeDate(actual[this.options.actualDateField]);
      if (dateStr) actualsMap.set(dateStr, actual);
    });

    const aligned = [];
    forecasts.forEach(forecast => {
      const dateStr = this.normalizeDate(forecast[this.options.forecastDateField]);
      if (!dateStr) {
        this.warnings.push(`Skipping forecast with invalid date: ${forecast[this.options.forecastDateField]}`);
        return;
      }
      const actual = actualsMap.get(dateStr);
      if (actual) {
        aligned.push({
          date:             dateStr,
          forecast,
          actual,
          forecastCreatedAt: this.parseDate(forecast[this.options.forecastCreatedField])
        });
      }
    });

    const unmatched = forecasts.length - aligned.length;
    if (unmatched > 0)
      this.warnings.push(`${unmatched} forecast records had no matching actuals`);

    return aligned;
  }

  assignDaysAhead(alignedData) {
    return alignedData.map(record => {
      // Use pre-computed Days_Until_Arrival when available (avoids DB write-time skew)
      const dua = this.parseNumber(record.forecast?.Days_Until_Arrival);
      if (dua != null) {
        record.daysAhead = Math.round(dua);
        return record;
      }
      // Fallback: derive from dates
      const stayDate  = this.parseDate(record.date);
      const createdAt = record.forecastCreatedAt;
      record.daysAhead = (stayDate && createdAt)
        ? Math.floor((stayDate - createdAt) / (1000 * 60 * 60 * 24))
        : null;
      return record;
    });
  }

  // ---- Accuracy calculations ----

  compareMethodsOverall(data) {
    const trad  = { forecasts: [], actuals: [] };
    const curve = { forecasts: [], actuals: [] };
    const fin   = { forecasts: [], actuals: [] };
    const bands = { '1_7': 0, '8_30': 0, '31_60': 0, '61_90': 0, 'over_90': 0 };

    data.forEach(record => {
      if (record.daysAhead == null || record.daysAhead < 1) return;

      const actual = this.getField(record.actual, 'RoomNights');
      if (actual == null) return;

      const tradV  = this.getField(record.forecast, 'Room_Nights_Traditional');
      const curveV = this.getField(record.forecast, 'Room_Nights_Curve');
      const finV   = this.getField(record.forecast, 'Room_Nights_Final');

      if (tradV  != null) { trad.forecasts.push(tradV);  trad.actuals.push(actual); }
      if (curveV != null) { curve.forecasts.push(curveV); curve.actuals.push(actual); }
      if (finV   != null) {
        fin.forecasts.push(finV);
        fin.actuals.push(actual);
        const d = record.daysAhead;
        if      (d <=  7) bands['1_7']++;
        else if (d <= 30) bands['8_30']++;
        else if (d <= 60) bands['31_60']++;
        else if (d <= 90) bands['61_90']++;
        else              bands['over_90']++;
      }
    });

    const tradAcc  = this.calculateMethodAccuracy(trad.forecasts,  trad.actuals);
    const curveAcc = this.calculateMethodAccuracy(curve.forecasts, curve.actuals);
    const finAcc   = this.calculateMethodAccuracy(fin.forecasts,   fin.actuals);

    const methods = [
      { name: 'traditional', wmape: tradAcc?.wmape },
      { name: 'curve',       wmape: curveAcc?.wmape },
      { name: 'final',       wmape: finAcc?.wmape }
    ].filter(m => m.wmape != null);

    const winner = methods.length > 0
      ? methods.reduce((best, m) => m.wmape < best.wmape ? m : best).name
      : null;

    return {
      traditional:  tradAcc,
      curve:        curveAcc,
      final:        finAcc,
      winner,
      horizon_band_counts: bands,
      curve_vs_traditional: (tradAcc?.wmape != null && curveAcc?.wmape != null) ? {
        improvement_pct: parseFloat((tradAcc.wmape - curveAcc.wmape).toFixed(2)),
        curve_is_better: curveAcc.wmape < tradAcc.wmape
      } : null
    };
  }

  calculatePerRunAccuracy(data) {
    const byRun = new Map();

    data.forEach(record => {
      if (record.daysAhead == null || record.daysAhead < 1) return;
      const createdAt = record.forecastCreatedAt;
      if (!createdAt) return;

      const key     = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
      const dateStr = key.split('T')[0];

      if (!byRun.has(key)) {
        byRun.set(key, {
          forecast_run_date: dateStr,
          trad:  { forecasts: [], actuals: [] },
          curve: { forecasts: [], actuals: [] },
          fin:   { forecasts: [], actuals: [] }
        });
      }

      const group  = byRun.get(key);
      const actual = this.getField(record.actual, 'RoomNights');
      if (actual == null) return;

      const tradV  = this.getField(record.forecast, 'Room_Nights_Traditional');
      const curveV = this.getField(record.forecast, 'Room_Nights_Curve');
      const finV   = this.getField(record.forecast, 'Room_Nights_Final');

      if (tradV  != null) { group.trad.forecasts.push(tradV);  group.trad.actuals.push(actual); }
      if (curveV != null) { group.curve.forecasts.push(curveV); group.curve.actuals.push(actual); }
      if (finV   != null) { group.fin.forecasts.push(finV);    group.fin.actuals.push(actual); }
    });

    return Array.from(byRun.values())
      .sort((a, b) => a.forecast_run_date.localeCompare(b.forecast_run_date))
      .map(run => ({
        forecast_run_date: run.forecast_run_date,
        traditional: this.calculateMethodAccuracy(run.trad.forecasts,  run.trad.actuals),
        curve:       this.calculateMethodAccuracy(run.curve.forecasts, run.curve.actuals),
        final:       this.calculateMethodAccuracy(run.fin.forecasts,   run.fin.actuals)
      }));
  }

  calculateAccuracyByHorizon(data) {
    const byHorizon = {};

    data.forEach(record => {
      const h = record.daysAhead;
      if (h == null || h < 1 || h > this.options.maxHorizonDays) return;

      if (!byHorizon[h]) byHorizon[h] = {
        trad:  { forecasts: [], actuals: [] },
        curve: { forecasts: [], actuals: [] },
        fin:   { forecasts: [], actuals: [] }
      };

      const actual = this.getField(record.actual, 'RoomNights');
      if (actual == null) return;

      const tradV  = this.getField(record.forecast, 'Room_Nights_Traditional');
      const curveV = this.getField(record.forecast, 'Room_Nights_Curve');
      const finV   = this.getField(record.forecast, 'Room_Nights_Final');

      if (tradV  != null) { byHorizon[h].trad.forecasts.push(tradV);  byHorizon[h].trad.actuals.push(actual); }
      if (curveV != null) { byHorizon[h].curve.forecasts.push(curveV); byHorizon[h].curve.actuals.push(actual); }
      if (finV   != null) { byHorizon[h].fin.forecasts.push(finV);    byHorizon[h].fin.actuals.push(actual); }
    });

    const buildCurve = (key) => {
      const points = [];
      for (let day = 1; day <= this.options.maxHorizonDays; day++) {
        const d      = byHorizon[day]?.[key];
        const result = d ? this.calculateMethodAccuracy(d.forecasts, d.actuals) : null;
        points.push(result
          ? { days_ahead: day, sample_size: result.sample_size, wmape: result.wmape, accuracy: result.accuracy, mae: result.mae }
          : { days_ahead: day, sample_size: d?.forecasts.length ?? 0, wmape: null, accuracy: null, mae: null }
        );
      }
      return points;
    };

    return {
      traditional: buildCurve('trad'),
      curve:       buildCurve('curve'),
      final:       buildCurve('fin')
    };
  }

  // ---- Utilities ----

  // Case-insensitive field lookup with underscore tolerance
  getField(record, fieldName) {
    if (record[fieldName] !== undefined) return this.parseNumber(record[fieldName]);
    const needle = fieldName.replace(/_/g, '').toLowerCase();
    for (const key of Object.keys(record)) {
      if (key.replace(/_/g, '').toLowerCase() === needle)
        return this.parseNumber(record[key]);
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
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    } catch { return null; }
  }

  parseDate(value) {
    if (!value) return null;
    try {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    } catch { return null; }
  }
}


// ============ N8N INTEGRATION ============

const allInputs = $input.all();
console.log('Total inputs received:', allInputs.length);

let forecastRecords = [];
let actuals         = [];

function isForecast(record) {
  if (!record || typeof record !== 'object') return false;
  const hasStayDate = record.Stay_Date !== undefined || record.StayDate !== undefined;
  const hasRoomNights = record.Room_Nights_Final !== undefined
    || record.Room_Nights_Traditional !== undefined
    || record.Room_Nights_Curve       !== undefined;
  return hasStayDate && hasRoomNights;
}

function isActual(record) {
  if (!record || typeof record !== 'object') return false;
  return record.Date !== undefined && record.RoomNights !== undefined;
}

function normalizeForecast(record) {
  // Normalise field name variant StayDate → Stay_Date
  if (record.StayDate && !record.Stay_Date) record.Stay_Date = record.StayDate;
  return record;
}

function extractRecords(obj, depth = 0) {
  if (depth > 5) return;
  if (Array.isArray(obj)) {
    obj.forEach(item => extractRecords(item, depth + 1));
  } else if (obj && typeof obj === 'object') {
    if (isForecast(obj)) {
      forecastRecords.push(normalizeForecast(obj));
    } else if (isActual(obj)) {
      actuals.push(obj);
    } else {
      Object.values(obj).forEach(val => {
        if (Array.isArray(val)) extractRecords(val, depth + 1);
      });
    }
  }
}

allInputs.forEach(item => extractRecords(item.json));

console.log('Forecast records found:', forecastRecords.length);
console.log('Actuals records found:', actuals.length);

if (forecastRecords.length === 0) {
  const sampleKeys = allInputs.slice(0, 3).map(item => Object.keys(item.json || {}));
  throw new Error(`No forecast data found. Expected records with Stay_Date and Room_Nights_Final/Traditional/Curve. Input keys: ${JSON.stringify(sampleKeys)}`);
}
if (actuals.length === 0) {
  throw new Error('No actuals data found. Expected records with Date and RoomNights.');
}

const measurement   = new ForecastAccuracyMeasurement();
const accuracyResult = measurement.calculateAccuracy(forecastRecords, actuals);

// ---- Text summary ----
const s = accuracyResult.summary;
const reportDate = new Date().toISOString().split('T')[0];

const emailSummary = `FORECAST ACCURACY REPORT
========================
Run Date: ${reportDate}
Days Evaluated: ${accuracyResult.data_summary.past_dates_evaluated}

OVERALL ACCURACY (Room Nights)
  Traditional: ${s.traditional?.accuracy ?? 'N/A'}%  (WMAPE ${s.traditional?.wmape ?? 'N/A'}%, MAE ${s.traditional?.mae ?? 'N/A'} rooms)
  Curve:       ${s.curve?.accuracy ?? 'N/A'}%  (WMAPE ${s.curve?.wmape ?? 'N/A'}%, MAE ${s.curve?.mae ?? 'N/A'} rooms)
  Final:       ${s.final?.accuracy ?? 'N/A'}%  (WMAPE ${s.final?.wmape ?? 'N/A'}%, MAE ${s.final?.mae ?? 'N/A'} rooms)
  Winner: ${s.winner ?? 'N/A'}
`;
console.log(emailSummary);

return [{
  json: {
    success:         true,
    data_summary:    accuracyResult.data_summary,
    summary:         accuracyResult.summary,
    forecast_runs:   accuracyResult.forecast_runs,
    accuracy_curves: accuracyResult.accuracy_curves,
    warnings:        accuracyResult.warnings,
    email_summary:   emailSummary,
    email_subject:   `Forecast Accuracy Report - ${reportDate}`,
    timestamp:       new Date().toISOString()
  }
}];
