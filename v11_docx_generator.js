/**
 * Hotel Revenue Forecasting System - Module 5: HTML Report Generator (V11)
 *
 * Generates a fully-formatted 2-page HTML report.
 * Word can open .html files directly (File → Open) and treats them as editable documents.
 *
 * No external npm packages required — runs on n8n Cloud without restrictions.
 * All rendering uses standard HTML5 + embedded CSS.
 *
 * Input: finds the Row_Type = 'report' item from $input.all().
 *        chart_png_base64 may be null — image section is skipped gracefully.
 *
 * Output: binary .html file (base64 encoded).
 *
 * N8N wiring:
 *   Report Processor → this node → (email / Move Binary Data / Google Drive)
 */

// ============ N8N EXECUTION CODE ============

// ── Find report row from input ────────────────────────────────────────────────
const reportItem = $input.all().find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error(
    'HTML Report Generator V11: no report row found in input. ' +
    'Make sure Report Processor is connected and produced a Row_Type = "report" item.'
  );
}

const data = reportItem.json;
const {
  meta,
  current_week,
  forecast_table,
  chart_png_base64,
  page1_bridge,
  insights,
  data_gaps,
  page2_intro
} = data;

if (!meta || !forecast_table) {
  throw new Error(
    'HTML Report Generator V11: report row is missing required fields (meta, forecast_table). ' +
    `Got keys: ${Object.keys(data).join(', ')}`
  );
}

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  DARK_BLUE:   '#1B2A4A',
  ACCENT:      '#C0392B',
  AMBER:       '#B07D00',
  GREEN:       '#1A7A4A',
  MUTED:       '#6B7280',
  WHITE:       '#FFFFFF',
  LIGHT_BLUE:  '#EBF0F8',
  PARTIAL_BG:  '#FFF8E1',
  VARIANCE_BG: '#FEF2F2',
  BODY:        '#1C1C1C',
  BORDER:      '#D0D6E0',
  PAGE_BG:     '#F3F4F6'
};

// ── Number formatters ─────────────────────────────────────────────────────────
function fmtEuro(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return '€' + Math.round(Number(n)).toLocaleString('nl-NL', { maximumFractionDigits: 0 });
}
function fmtADR(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtYoY(n) {
  if (n == null || isNaN(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '';
  return sign + v.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtInt(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return Math.round(Number(n)).toString();
}
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── YoY colour logic ──────────────────────────────────────────────────────────
function yoyColor(yoy) {
  if (yoy == null) return C.BODY;
  if (yoy < -10) return C.ACCENT;
  if (yoy < 0)   return C.AMBER;
  return C.GREEN;
}

// ── Row background logic ──────────────────────────────────────────────────────
function rowBg(row) {
  if (row.is_partial)              return C.PARTIAL_BG;
  if ((row.variance_pct ?? 0) >= 14) return C.VARIANCE_BG;
  return null; // handled by nth-child CSS alternating rows
}

// ── Forecast table HTML ───────────────────────────────────────────────────────
function buildForecastTable(rows) {
  const headerCells = [
    'Week', 'Periode', 'Forecast<br>nachten', 'OTB<br>nachten',
    'Pickup<br>nodig', 'Bezetting', 'ADR', 'Kamer-<br>omzet', 'YoY'
  ].map(h => `<th>${h}</th>`).join('');

  const dataRows = rows.map((row) => {
    const bg       = rowBg(row);
    const bgStyle  = bg ? `background:${bg};` : '';
    const yoyN     = row.yoy_pct;
    const yoyStyle = `color:${yoyColor(yoyN)};font-weight:700;`;

    return `<tr style="${bgStyle}">
      <td>${esc(row.week_key)  || '—'}</td>
      <td class="left">${esc(row.period) || '—'}</td>
      <td>${fmtInt(row.forecast_nights)}</td>
      <td>${fmtInt(row.otb_nights)}</td>
      <td>${fmtInt(row.pickup_needed)}</td>
      <td>${fmtPct(row.occupancy_pct)}</td>
      <td>${fmtADR(row.adr)}</td>
      <td>${fmtEuro(row.room_revenue)}</td>
      <td style="${yoyStyle}">${fmtYoY(yoyN)}</td>
    </tr>`;
  }).join('\n');

  return `
<div class="table-wrap">
  <table class="forecast-table">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>
${dataRows}
    </tbody>
  </table>
</div>
<p class="caption">* Gedeeltelijke week — OTB is definitief resultaat. &nbsp;
Rood gearceerde rijen hebben een forecastvariantie ≥ 14%.</p>`;
}

// ── Chart block ───────────────────────────────────────────────────────────────
function buildChartBlock(base64png) {
  const caption = `OTB vorig jaar (LY) = gerealiseerde kamernachten op vergelijkbaar meetmoment vorig jaar. &nbsp;
Forecast = modeluitkomst op basis van historische pickupcurves. &nbsp;
OTB huidig = geboekte nachten per ${esc(meta.created_at || '—')}.`;

  if (!base64png) {
    return `<p class="caption placeholder">[Grafiek niet beschikbaar — chart_png_base64 ontbreekt in invoer]</p>
<p class="caption">${caption}</p>`;
  }

  return `<div class="chart-wrap">
  <img src="data:image/png;base64,${base64png}" alt="OTB-vergelijking grafiek" style="width:100%;max-width:600px;display:block;margin:0 auto;">
</div>
<p class="caption">${caption}</p>`;
}

// ── Insights blocks ───────────────────────────────────────────────────────────
function buildInsights(insightList) {
  if (!insightList || insightList.length === 0) return '<p class="body">—</p>';
  return insightList.map(ins => `
<h3 class="insight-heading">${esc(ins.heading || '')}</h3>
<p class="body">${esc(ins.body || '—')}</p>`).join('\n');
}

// ── Data gaps blocks ──────────────────────────────────────────────────────────
function buildDataGaps(gapList) {
  if (!gapList || gapList.length === 0) return '<p class="body">—</p>';
  return gapList.map(gap => `
<p class="gap-title">· ${esc(gap.title || '')}</p>
<p class="gap-body">${esc(gap.body || '—')}</p>`).join('\n');
}

// ── Metadata ──────────────────────────────────────────────────────────────────
const hotelLabel  = esc(meta.hotel_name    || 'Hotel');
const periodLabel = esc(meta.report_period || '');
const dateLabel   = esc(meta.created_at    || '');
const p1Title     = esc(meta.page1_title   || 'Revenue Forecast Analyse');
const p2Title     = esc(meta.page2_title   || 'OTB-vergelijking & Onderliggende Analyse');

// ── Full HTML document ────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${p1Title} — ${hotelLabel}</title>
<style>
  /* ── Reset ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ── Page / body ── */
  body {
    font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
    font-size: 10pt;
    color: ${C.BODY};
    background: ${C.PAGE_BG};
    line-height: 1.5;
  }

  /* ── Page container ── */
  .page {
    width: 210mm;
    min-height: 297mm;
    padding: 20mm 18mm;
    background: ${C.WHITE};
    margin: 10mm auto;
    box-shadow: 0 2px 16px rgba(0,0,0,.12);
    position: relative;
  }

  /* ── Header labels ── */
  .hotel-label {
    font-size: 8pt;
    color: ${C.MUTED};
    margin-bottom: 4px;
  }

  /* ── Page title ── */
  h1.page-title {
    font-size: 22pt;
    font-weight: 700;
    color: ${C.DARK_BLUE};
    margin-bottom: 4px;
    line-height: 1.15;
  }

  /* ── Subtitle ── */
  .subtitle {
    font-size: 9pt;
    color: ${C.MUTED};
    margin-bottom: 20px;
  }

  /* ── Section headings ── */
  h2.section {
    font-size: 11pt;
    font-weight: 700;
    color: ${C.DARK_BLUE};
    margin-top: 20px;
    margin-bottom: 6px;
    border-bottom: 2px solid ${C.LIGHT_BLUE};
    padding-bottom: 3px;
  }

  /* ── Body text ── */
  p.body {
    font-size: 9.5pt;
    color: ${C.BODY};
    text-align: justify;
    margin-bottom: 10px;
    line-height: 1.55;
  }

  /* ── Caption ── */
  p.caption {
    font-size: 7.5pt;
    color: ${C.MUTED};
    font-style: italic;
    margin-top: 4px;
    margin-bottom: 8px;
  }
  p.caption.placeholder {
    color: ${C.ACCENT};
    font-style: normal;
    font-weight: 600;
  }

  /* ── Referral ── */
  p.referral {
    font-size: 8.5pt;
    color: ${C.MUTED};
    font-style: italic;
    margin-top: 16px;
    margin-bottom: 4px;
  }

  /* ── Footer ── */
  .page-footer {
    position: absolute;
    bottom: 10mm;
    left: 18mm;
    right: 18mm;
    text-align: center;
    font-size: 7pt;
    color: ${C.MUTED};
    border-top: 1px solid ${C.BORDER};
    padding-top: 4px;
  }

  /* ── Forecast table ── */
  .table-wrap { overflow-x: auto; margin-bottom: 4px; }

  table.forecast-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8pt;
  }
  table.forecast-table thead tr {
    background: ${C.DARK_BLUE};
    color: ${C.WHITE};
  }
  table.forecast-table thead th {
    padding: 5px 6px;
    text-align: center;
    font-weight: 600;
    font-size: 7.5pt;
    border: 1px solid ${C.DARK_BLUE};
  }
  table.forecast-table tbody td {
    padding: 4px 6px;
    text-align: center;
    border: 1px solid ${C.BORDER};
    vertical-align: middle;
  }
  table.forecast-table tbody td.left { text-align: left; }
  table.forecast-table tbody tr:nth-child(even) { background: ${C.LIGHT_BLUE}; }
  table.forecast-table tbody tr:nth-child(odd)  { background: ${C.WHITE}; }
  /* Override alternating with specific row types (inline style on tr takes precedence) */

  /* ── Chart ── */
  .chart-wrap {
    margin: 8px 0;
    padding: 8px;
    background: ${C.LIGHT_BLUE};
    border: 1px solid ${C.BORDER};
    border-radius: 4px;
    text-align: center;
  }

  /* ── Insight headings ── */
  h3.insight-heading {
    font-size: 10pt;
    font-weight: 700;
    color: ${C.DARK_BLUE};
    margin-top: 14px;
    margin-bottom: 3px;
  }

  /* ── Data gaps ── */
  p.gap-title {
    font-size: 9pt;
    font-weight: 700;
    color: ${C.DARK_BLUE};
    margin-top: 8px;
    margin-bottom: 1px;
  }
  p.gap-body {
    font-size: 9pt;
    color: ${C.MUTED};
    margin-bottom: 6px;
  }

  /* ── Print / page break ── */
  @media print {
    body { background: white; }
    .page {
      width: 210mm;
      min-height: 297mm;
      padding: 20mm 18mm;
      margin: 0;
      box-shadow: none;
      page-break-after: always;
    }
    .page:last-child { page-break-after: auto; }
    .page-footer { position: fixed; bottom: 10mm; }
  }
</style>
</head>
<body>

<!-- ══════════════════════════════════════════ PAGE 1 ══════════════════════════ -->
<div class="page" id="page1">

  <p class="hotel-label">${hotelLabel}</p>
  <h1 class="page-title">${p1Title}</h1>
  <p class="subtitle">${periodLabel} &nbsp;·&nbsp; ${dateLabel} &nbsp;·&nbsp; Hospecs Revenue Intelligence</p>

  <h2 class="section">Huidige stand</h2>
  <p class="body">${esc(current_week?.summary || '—')}</p>

  <h2 class="section">Weekoverzicht ${periodLabel}</h2>
  ${buildForecastTable(forecast_table || [])}

  <h2 class="section">Patroon en context</h2>
  <p class="body">${esc(page1_bridge || '—')}</p>

  <p class="referral">→ &nbsp;Zie pagina 2 voor de OTB-vergelijking en de onderliggende analyse.</p>

  <div class="page-footer">Pagina 1 van 2 &nbsp;·&nbsp; ${hotelLabel} &nbsp;·&nbsp; Hospecs Revenue Forecast</div>
</div>

<!-- ══════════════════════════════════════════ PAGE 2 ══════════════════════════ -->
<div class="page" id="page2">

  <p class="hotel-label">${hotelLabel}</p>
  <h1 class="page-title">${p2Title}</h1>
  <p class="subtitle">Vervolg van pagina 1 &nbsp;·&nbsp; ${periodLabel} &nbsp;·&nbsp; ${dateLabel}</p>

  <p class="body">${esc(page2_intro || '—')}</p>

  <h2 class="section">OTB-vergelijking: vorig jaar &nbsp;·&nbsp; forecast &nbsp;·&nbsp; huidig</h2>
  ${buildChartBlock(chart_png_base64)}

  <h2 class="section">Conclusies</h2>
  ${buildInsights(insights)}

  <h2 class="section">Wat ontbreekt om scherpere conclusies te trekken</h2>
  ${buildDataGaps(data_gaps)}

  <div class="page-footer">Pagina 2 van 2 &nbsp;·&nbsp; ${hotelLabel} &nbsp;·&nbsp; Hospecs Revenue Forecast</div>
</div>

</body>
</html>`;

// ── Return as binary file ─────────────────────────────────────────────────────
const safeHotel  = (meta.hotel_name    || 'Hotel').replace(/[^a-zA-Z0-9_-]/g, '_');
const safePeriod = (meta.report_period || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const safeDate   = (meta.created_at    || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const fileName   = `forecast_${safePeriod}_${safeDate}_${safeHotel}.html`;

const base64Html = Buffer.from(html, 'utf8').toString('base64');

console.log(
  `✅ HTML Report Generator V11: document built | ` +
  `${(forecast_table || []).length} weeks | ` +
  `${(insights || []).length} insights | ${fileName}`
);

return [{
  json: { fileName, Hotel_Name: meta.hotel_name, Forecast_Created_At: data.Forecast_Created_At },
  binary: {
    data: {
      data:     base64Html,
      mimeType: 'text/html',
      fileName
    }
  }
}];
