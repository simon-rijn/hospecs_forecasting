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

// ---- HTML report ----
const ds    = accuracyResult.data_summary;
const runs  = accuracyResult.forecast_runs  || [];
const ac    = accuracyResult.accuracy_curves || {};
const bands = s.horizon_band_counts || {};

function curveAccuracySeries(methodKey) {
  return (ac[methodKey] || []).map(p => ({ x: p.days_ahead, y: p.accuracy, n: p.sample_size }));
}

const curveTrad  = JSON.stringify(curveAccuracySeries('traditional'));
const curveCurve = JSON.stringify(curveAccuracySeries('curve'));
const curveFinal = JSON.stringify(curveAccuracySeries('final'));

const runLabels = JSON.stringify(runs.map(r => r.forecast_run_date));
const runTrad   = JSON.stringify(runs.map(r => r.traditional?.accuracy ?? null));
const runCurve  = JSON.stringify(runs.map(r => r.curve?.accuracy      ?? null));
const runFinal  = JSON.stringify(runs.map(r => r.final?.accuracy      ?? null));
const runSize   = JSON.stringify(runs.map(r => r.final?.sample_size   ?? 0));

const bandLabels = JSON.stringify(['1–7d', '8–30d', '31–60d', '61–90d', '>90d']);
const bandData   = JSON.stringify([
  bands['1_7'] || 0, bands['8_30'] || 0,
  bands['31_60'] || 0, bands['61_90'] || 0, bands['over_90'] || 0
]);

function fmt(v, unit = '%') { return v != null ? `${v}${unit}` : '—'; }

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
</style>
</head>
<body>
<h1>Forecast Accuracy Report</h1>
<p class="meta">Generated ${reportDate} &nbsp;·&nbsp; ${ds.forecast_runs_found} forecast runs &nbsp;·&nbsp; ${ds.past_dates_evaluated} stay dates evaluated &nbsp;·&nbsp; ${ds.matched_records} matched records</p>

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

<div class="section">
  <h2>Accuracy by Forecast Horizon</h2>
  <p class="meta" style="margin-bottom:12px">How accurate is each method when forecasting N days before arrival?</p>
  <div class="chart-wrap"><canvas id="horizonChart"></canvas></div>
</div>

<div class="section">
  <h2>Accuracy per Forecast Run</h2>
  <p class="meta" style="margin-bottom:12px">Each group = one forecast run. Hover to see sample size.</p>
  <div class="chart-wrap"><canvas id="runChart"></canvas></div>
</div>

<div class="section">
  <h2>Horizon Band Distribution</h2>
  <p class="meta" style="margin-bottom:12px">How many records feeding the overall score come from each horizon band.</p>
  <div class="chart-wrap" style="height:220px"><canvas id="bandChart"></canvas></div>
</div>

<script>
const TRAD_COLOR  = 'rgb(59,130,246)';
const CURVE_COLOR = 'rgb(234,88,12)';
const FINAL_COLOR = 'rgb(22,163,74)';

(function() {
  const tradPts  = ${curveTrad};
  const curvePts = ${curveCurve};
  const finalPts = ${curveFinal};
  const labels = Array.from({length: 90}, (_, i) => i + 1);
  function toY(pts) { return labels.map(d => { const p = pts.find(p => p.x === d); return p ? p.y : null; }); }
  new Chart(document.getElementById('horizonChart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Traditional', data: toY(tradPts),  borderColor: TRAD_COLOR,  tension: 0.3, spanGaps: false, pointRadius: 2 },
      { label: 'Curve',       data: toY(curvePts), borderColor: CURVE_COLOR, tension: 0.3, spanGaps: false, pointRadius: 2 },
      { label: 'Final',       data: toY(finalPts), borderColor: FINAL_COLOR, tension: 0.3, spanGaps: false, pointRadius: 2 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' }, tooltip: { callbacks: {
        label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y != null ? ctx.parsed.y.toFixed(1) + '%' : '—')
      }}},
      scales: {
        x: { title: { display: true, text: 'Days before arrival' } },
        y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100, ticks: { callback: v => v + '%' } }
      }
    }
  });
})();

(function() {
  const labels = ${runLabels};
  const sizes  = ${runSize};
  new Chart(document.getElementById('runChart'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Traditional', data: ${runTrad}, backgroundColor: 'rgba(59,130,246,0.7)',  borderColor: TRAD_COLOR,  borderWidth: 1 },
      { label: 'Curve',       data: ${runCurve}, backgroundColor: 'rgba(234,88,12,0.7)',  borderColor: CURVE_COLOR, borderWidth: 1 },
      { label: 'Final',       data: ${runFinal}, backgroundColor: 'rgba(22,163,74,0.7)',  borderColor: FINAL_COLOR, borderWidth: 1 }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' }, tooltip: { callbacks: {
        afterBody: ctx => 'Sample size: ' + (sizes[ctx[0].dataIndex] ?? '—')
      }}},
      scales: {
        x: { title: { display: true, text: 'Forecast run date' } },
        y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100, ticks: { callback: v => v + '%' } }
      }
    }
  });
})();

(function() {
  new Chart(document.getElementById('bandChart'), {
    type: 'bar',
    data: { labels: ${bandLabels}, datasets: [{ label: 'Records', data: ${bandData},
      backgroundColor: ['rgba(59,130,246,0.7)','rgba(234,88,12,0.7)','rgba(22,163,74,0.7)','rgba(168,85,247,0.7)','rgba(148,163,184,0.7)'],
      borderWidth: 0, borderRadius: 4
    }]},
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
    success:         true,
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
