// Parse to Plain Text v0.12 — 2026-05-18
/**
 * Hotel Revenue Forecasting System - Module 5b: Plain Text Formatter (V11)
 *
 * Converts the report row into a plain-text summary that can be used as
 * context/inspiration for a downstream "Schrijf E-mail AI" node.
 *
 * Input:  Row_Type = "report"  (same Merge8 output as HTML file creation)
 * Output: { Row_Type: "text_report", text: "...", ...meta fields }
 *
 * N8N wiring:
 *   Merge8 → this node → Schrijf E-mail AI node
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

const reportItem = allInputs.find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error('Text Formatter V11: no report row found.');
}

const {
  meta, current_week, forecast_table,
  page1_bridge, insights, data_gaps, page2_intro
} = reportItem.json;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtInt(n)  { return (n == null || isNaN(+n)) ? '—' : String(Math.round(+n)); }
function fmtPct(n)  { return (n == null || isNaN(+n)) ? '—' : (+n).toFixed(1) + '%'; }
function fmtEuro(n) { return (n == null || isNaN(+n)) ? '—' : '€' + Math.round(+n).toLocaleString('nl-NL'); }
function fmtADR(n)  { return (n == null || isNaN(+n)) ? '—' : '€' + (+n).toFixed(2); }
function fmtYoY(n)  {
  if (n == null || isNaN(+n)) return '—';
  return (+n >= 0 ? '+' : '') + (+n).toFixed(1) + '%';
}

// ── Build plain text ──────────────────────────────────────────────────────────
const lines = [];

const hotelName    = meta?.hotel_name    || 'Hotel';
const period       = meta?.report_period || '';
const createdAt    = meta?.created_at    || '';

lines.push(`REVENUE FORECAST — ${hotelName.toUpperCase()}`);
lines.push(`Periode: ${period}  |  Gegenereerd: ${createdAt}`);
lines.push('');

// Current week summary
lines.push('── HUIDIGE STAND ──────────────────────────────────────────────────');
lines.push(current_week?.summary || '—');
lines.push('');

// Forecast table (compact)
lines.push('── WEEKOVERZICHT ──────────────────────────────────────────────────');
const colW = [8, 16, 10, 10, 10, 9, 8, 10, 7];
const headers = ['Week', 'Periode', 'Forecast', 'OTB', 'Pickup', 'Bezet%', 'ADR', 'Omzet', 'YoY'];
lines.push(headers.map((h, i) => h.padEnd(colW[i])).join(' '));
lines.push('-'.repeat(colW.reduce((a, b) => a + b + 1, 0)));

for (const row of (forecast_table || [])) {
  const cells = [
    (row.week_key     || '—').padEnd(colW[0]),
    (row.period       || '—').padEnd(colW[1]),
    fmtInt(row.forecast_nights).padEnd(colW[2]),
    fmtInt(row.otb_nights).padEnd(colW[3]),
    fmtInt(row.pickup_needed).padEnd(colW[4]),
    fmtPct(row.occupancy_pct).padEnd(colW[5]),
    fmtADR(row.adr).padEnd(colW[6]),
    fmtEuro(row.room_revenue).padEnd(colW[7]),
    fmtYoY(row.yoy_pct).padEnd(colW[8]),
  ];
  lines.push(cells.join(' ') + (row.is_partial ? ' *' : ''));
}
lines.push('');

// Pattern & context
lines.push('── PATROON EN CONTEXT ─────────────────────────────────────────────');
lines.push(page1_bridge || '—');
lines.push('');

// Page 2 intro
lines.push('── OTB-VERGELIJKING ───────────────────────────────────────────────');
lines.push(page2_intro || '—');
lines.push('');

// Insights
lines.push('── CONCLUSIES ─────────────────────────────────────────────────────');
for (const ins of (insights || [])) {
  lines.push(`• ${ins.heading || ''}`);
  lines.push(`  ${ins.body    || '—'}`);
  lines.push('');
}
if (!insights?.length) lines.push('—\n');

// Data gaps
lines.push('── WAT ONTBREEKT ──────────────────────────────────────────────────');
for (const gap of (data_gaps || [])) {
  lines.push(`· ${gap.title || ''}`);
  lines.push(`  ${gap.body  || '—'}`);
  lines.push('');
}
if (!data_gaps?.length) lines.push('—\n');

const text = lines.join('\n');

console.log(`✅ Text Formatter V11: ${text.length} chars | ${(forecast_table||[]).length} weeks`);

return [{
  json: {
    Row_Type:            'text_report',
    text,
    hotel_name:          meta?.hotel_name,
    report_period:       meta?.report_period,
    Forecast_Created_At: reportItem.json.Forecast_Created_At
  }
}];
