/**
 * Hotel Revenue Forecasting System - Module 5: Word-Compatible HTML Generator (V11)
 *
 * Generates an HTML file using Microsoft Office HTML format (Word HTML).
 * When opened in Word, it renders as a proper 2-page document with:
 *   - Correct A4 page size and margins
 *   - Page headers and footers
 *   - Page breaks between the two sections
 *   - Formatted table with colour coding
 *   - Styled headings, body text, and captions
 *
 * No external npm packages — uses only Buffer (built-in Node.js).
 * Compatible with n8n Cloud.
 *
 * Output: binary .html file  (Word opens via File → Open → select the .html)
 *
 * N8N wiring:
 *   Report Processor → this node → (email attachment / Google Drive / Move Binary Data)
 */

// ============ N8N EXECUTION CODE ============

// ── Find report row ───────────────────────────────────────────────────────────
const reportItem = $input.all().find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error(
    'HTML Report Generator V11: no report row found. ' +
    'Make sure Report Processor is connected and produced Row_Type = "report".'
  );
}

const data = reportItem.json;
const { meta, current_week, forecast_table, chart_png_base64,
        page1_bridge, insights, data_gaps, page2_intro } = data;

if (!meta || !forecast_table) {
  throw new Error(
    `HTML Report Generator V11: missing meta or forecast_table. ` +
    `Got keys: ${Object.keys(data).join(', ')}`
  );
}

// ── Colour constants ──────────────────────────────────────────────────────────
const DARK_BLUE   = '#1A4FCC';   // feller, primair blauw
const ACCENT      = '#C0392B';
const AMBER       = '#B07D00';
const GREEN       = '#1A7A4A';
const MUTED       = '#6B7280';
const WHITE       = '#FFFFFF';
const LIGHT_BLUE  = '#E0EAFF';   // licht blauw passend bij het nieuwe primaire blauw
const PARTIAL_BG  = '#FFF8E1';
const VARIANCE_BG = '#FEF2F2';
const BODY_COL    = '#1C1C1C';
const BORDER      = '#D0D6E0';

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtEuro(n) {
  if (n == null || isNaN(+n)) return '—';
  return '€\u202f' + Math.round(+n).toLocaleString('nl-NL');
}
function fmtADR(n) {
  if (n == null || isNaN(+n)) return '—';
  return '€\u202f' + (+n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null || isNaN(+n)) return '—';
  return (+n).toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtYoY(n) {
  if (n == null || isNaN(+n)) return '—';
  const v = +n, sign = v >= 0 ? '+' : '';
  return sign + v.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function fmtInt(n) {
  if (n == null || isNaN(+n)) return '—';
  return String(Math.round(+n));
}
function yoyColor(n) {
  if (n == null) return BODY_COL;
  return n < -10 ? ACCENT : n < 0 ? AMBER : GREEN;
}
function rowBg(row, idx) {
  if (row.is_partial)              return PARTIAL_BG;
  if ((row.variance_pct ?? 0) >= 14) return VARIANCE_BG;
  return idx % 2 === 0 ? WHITE : LIGHT_BLUE;
}

// ── Page metadata ─────────────────────────────────────────────────────────────
const hotel  = esc(meta.hotel_name    || 'Hotel');
const period = esc(meta.report_period || '');
const dated  = esc(meta.created_at    || '');
const p1t    = esc(meta.page1_title   || 'Revenue Forecast Analyse');
const p2t    = esc(meta.page2_title   || 'OTB-vergelijking & Onderliggende Analyse');

// ── Forecast table ────────────────────────────────────────────────────────────
// Column % widths that match the twip ratios (total 8280 twips)
const COL_PCT = ['8.5%','16.9%','10.9%','10.9%','10.9%','9.7%','9.7%','13.0%','9.7%'];
const HEADERS  = ['Week','Periode','Forecast<br>nachten','OTB<br>nachten',
                  'Pickup<br>nodig','Bezetting','ADR','Kamer-<br>omzet','YoY'];

function buildTable(rows) {
  const colgroup = COL_PCT
    .map(w => `<col style="width:${w};mso-width-source:userset">`)
    .join('');

  const thead = HEADERS
    .map(h => `<th style="background:${DARK_BLUE};color:${WHITE};font-size:7.5pt;font-weight:700;`
            + `text-align:center;padding:4pt 4pt;border:1pt solid ${DARK_BLUE};">${h}</th>`)
    .join('');

  const tbody = rows.map((row, idx) => {
    const bg     = rowBg(row, idx);
    const yoyN   = row.yoy_pct;
    const yoyC   = yoyColor(yoyN);
    const tdBase = `font-size:7.5pt;padding:3pt 4pt;border:1pt solid ${BORDER};background:${bg};`;
    const tdC    = `${tdBase}text-align:center;`;
    const tdL    = `${tdBase}text-align:left;`;
    const tdY    = `${tdC}color:${yoyC};font-weight:700;`;
    return (
      `<tr>` +
      `<td style="${tdC}">${esc(row.week_key)||'—'}</td>` +
      `<td style="${tdL}">${esc(row.period)||'—'}</td>` +
      `<td style="${tdC}">${fmtInt(row.forecast_nights)}</td>` +
      `<td style="${tdC}">${fmtInt(row.otb_nights)}</td>` +
      `<td style="${tdC}">${fmtInt(row.pickup_needed)}</td>` +
      `<td style="${tdC}">${fmtPct(row.occupancy_pct)}</td>` +
      `<td style="${tdC}">${fmtADR(row.adr)}</td>` +
      `<td style="${tdC}">${fmtEuro(row.room_revenue)}</td>` +
      `<td style="${tdY}">${fmtYoY(yoyN)}</td>` +
      `</tr>`
    );
  }).join('\n');

  return (
    `<table style="border-collapse:collapse;width:100%;mso-table-layout-alt:fixed;` +
    `font-family:Calibri,Arial,sans-serif;font-size:7.5pt;" cellspacing="0" cellpadding="0">` +
    `<colgroup>${colgroup}</colgroup>` +
    `<thead><tr>${thead}</tr></thead>` +
    `<tbody>${tbody}</tbody>` +
    `</table>`
  );
}

// ── Chart block ───────────────────────────────────────────────────────────────
// Word's HTML renderer (Trident) does NOT support data:image/... URIs.
// When a PNG is available we use a cid: reference; the image is embedded as
// a separate MIME part in the MHTML envelope produced at the end of the file.
const CHART_CID = 'chart001.png@hospecs';
function buildChart(b64) {
  const cap = `OTB vorig jaar (LY) = gerealiseerde kamernachten op vergelijkbaar meetmoment vorig jaar. ` +
              `Forecast = modeluitkomst op basis van historische pickupcurves. ` +
              `OTB huidig = geboekte nachten per ${dated}.`;
  if (!b64) return (
    `<p style="font-size:8pt;color:${ACCENT};font-style:italic;">[Grafiek niet beschikbaar &mdash; chart_png_base64 ontbreekt]</p>` +
    `<p style="font-size:7.5pt;color:${MUTED};font-style:italic;">${esc(cap)}</p>`
  );
  return (
    `<p><img src="cid:${CHART_CID}" ` +
    `style="width:500pt;height:auto;display:block;" ` +
    `alt="OTB-vergelijking grafiek"></p>` +
    `<p style="font-size:7.5pt;color:${MUTED};font-style:italic;">${esc(cap)}</p>`
  );
}

// ── Paragraph helpers (inline styles, all Word-compatible) ────────────────────
function pStyle(opts = {}) {
  const {
    size = '9pt', color = BODY_COL, bold = false, italic = false,
    before = '0pt', after = '6pt', align = 'justify'
  } = opts;
  let s = `font-family:Calibri,Arial,sans-serif;font-size:${size};color:${color};`;
  s += `text-align:${align};margin-top:${before};margin-bottom:${after};`;
  s += `mso-line-height-rule:exactly;mso-pagination:widow-orphan;`;
  if (bold)   s += 'font-weight:700;';
  if (italic) s += 'font-style:italic;';
  return s;
}
function p(text, opts = {})    { return `<p style="${pStyle(opts)}">${esc(text)}</p>`; }
function h1(text)              { return `<h1 style="${pStyle({ size:'20pt', color:DARK_BLUE, bold:true, before:'0pt', after:'4pt', align:'left' })}">${esc(text)}</h1>`; }
function h2(text)              { return `<h2 style="${pStyle({ size:'10.5pt', color:DARK_BLUE, bold:true, before:'14pt', after:'5pt', align:'left' })};border-bottom:1.5pt solid ${LIGHT_BLUE};padding-bottom:2pt;">${esc(text)}</h2>`; }
function h3(text)              { return `<h3 style="${pStyle({ size:'10pt', color:DARK_BLUE, bold:true, before:'10pt', after:'2pt', align:'left' })}">${esc(text)}</h3>`; }
function label(text)           { return `<p style="${pStyle({ size:'8pt', color:MUTED, after:'2pt', align:'left' })}">${esc(text)}</p>`; }
function subtitle(text)        { return `<p style="${pStyle({ size:'9pt', color:MUTED, after:'14pt', align:'left' })}">${esc(text)}</p>`; }
function bodyTxt(text)         { return `<p style="${pStyle()}">${esc(text)}</p>`; }
function caption(text)         { return `<p style="${pStyle({ size:'7.5pt', color:MUTED, italic:true, after:'4pt', align:'left' })}">${esc(text)}</p>`; }
function referral(text)        { return `<p style="${pStyle({ size:'8.5pt', color:MUTED, italic:true, before:'12pt', after:'4pt', align:'left' })}">${esc(text)}</p>`; }
function gapTitle(text)        { return `<p style="${pStyle({ size:'9pt', color:DARK_BLUE, bold:true, before:'6pt', after:'1pt', align:'left' })}">&#183; ${esc(text)}</p>`; }
function gapBody(text)         { return `<p style="${pStyle({ size:'9pt', color:MUTED, after:'5pt', align:'left' })}">${esc(text)}</p>`; }

// ── Insights list ─────────────────────────────────────────────────────────────
function buildInsights(list) {
  if (!list || !list.length) return bodyTxt('—');
  return list.map(i => h3(i.heading || '') + bodyTxt(i.body || '—')).join('');
}

// ── Data gaps list ────────────────────────────────────────────────────────────
function buildGaps(list) {
  if (!list || !list.length) return bodyTxt('—');
  return list.map(g => gapTitle(g.title || '') + gapBody(g.body || '—')).join('');
}

// ── Build the HTML document ───────────────────────────────────────────────────
// Uses Microsoft Office HTML extensions for proper Word rendering:
//   - xmlns:o / xmlns:w namespaces on <html>
//   - <w:WordDocument> settings block
//   - @page Section1/Section2 with mso-header/footer references
//   - mso-element:header / mso-element:footer divs
//   - div.Section1 / div.Section2 for page scoping

const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40"
      lang="nl">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>${p1t} &mdash; ${hotel}</title>

<!--[if gte mso 9]><xml>
 <w:WordDocument>
  <w:View>Print</w:View>
  <w:Zoom>100</w:Zoom>
  <w:DoNotOptimizeForBrowser/>
 </w:WordDocument>
</xml><![endif]-->

<style>
/* ───────────────────────────────────────────────
   WORD PAGE SETUP
   A4, 2cm marges, geen kop-/voettekst
──────────────────────────────────────────────── */
@page Section1 {
  size:       21.0cm 29.7cm;
  margin:     2.0cm 1.8cm 2.0cm 1.8cm;
  mso-paper-source: 0;
}
@page Section2 {
  size:       21.0cm 29.7cm;
  margin:     2.0cm 1.8cm 2.0cm 1.8cm;
  mso-paper-source: 0;
}

div.Section1 { page: Section1; }
div.Section2 { page: Section2; }

/* ── Browser fallback layout ── */
body {
  font-family: Calibri, Arial, sans-serif;
  font-size: 10pt;
  color: ${BODY_COL};
  background: ${WHITE};
  margin: 0;
  padding: 0;
}
div.Section1, div.Section2 {
  background: ${WHITE};
  max-width: 170mm;
  margin: 0 auto;
  padding: 20mm 18mm;
}

/* ── Reset headings (Word adds margins) ── */
h1, h2, h3 { font-weight: normal; padding: 0; }
p           { margin: 0; padding: 0; }
table       { border-collapse: collapse; }
</style>
</head>
<body>

<!-- ═══════════════════════════════════════════════
     PAGINA 1
════════════════════════════════════════════════ -->
<div class="Section1">

  ${label(hotel)}
  ${h1(meta.page1_title || 'Revenue Forecast Analyse')}
  ${subtitle(`${period}\u2003\u00b7\u2003${dated}\u2003\u00b7\u2003Hospecs Revenue Intelligence`)}

  ${h2('Huidige stand')}
  ${bodyTxt(current_week?.summary || '—')}

  ${h2(`Weekoverzicht ${period}`)}
  ${buildTable(forecast_table || [])}
  ${caption('* Gedeeltelijke week — OTB is definitief resultaat.\u2003Rood gearceerde rijen hebben een forecastvariantie \u2265 14%.')}

  ${h2('Patroon en context')}
  ${bodyTxt(page1_bridge || '—')}

  ${referral('\u2192\u2003Zie pagina\u00a02 voor de OTB-vergelijking en de onderliggende analyse.')}

</div>


<!-- ═══════════════════════════════════════════════
     PAGINA 2
════════════════════════════════════════════════ -->
<div class="Section2">

  ${label(hotel)}
  ${h1(meta.page2_title || 'OTB-vergelijking & Onderliggende Analyse')}
  ${subtitle(`Vervolg van pagina\u00a01\u2003\u00b7\u2003${period}\u2003\u00b7\u2003${dated}`)}

  ${bodyTxt(page2_intro || '—')}

  ${h2('OTB-vergelijking: vorig jaar\u2003\u00b7\u2003forecast\u2003\u00b7\u2003huidig')}
  ${buildChart(chart_png_base64)}

  ${h2('Conclusies')}
  ${buildInsights(insights)}

  ${h2('Wat ontbreekt om scherpere conclusies te trekken')}
  ${buildGaps(data_gaps)}

</div>

</body>
</html>`;

// ── Build MHTML or plain HTML output ─────────────────────────────────────────
// Word cannot render data: URIs, so when a chart PNG is available we wrap
// the document in an MHTML (multipart/related) envelope that embeds the image
// as a separate MIME part referenced by cid: from the HTML.
// Without a chart PNG we fall back to plain HTML (smaller file, same result).

const safeHotel  = (meta.hotel_name    || 'Hotel').replace(/[^a-zA-Z0-9_-]/g, '_');
const safePeriod = (meta.report_period || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const safeDate   = (meta.created_at    || '').replace(/[^a-zA-Z0-9_-]/g, '_');

let outputContent, mimeType, fileName;

if (chart_png_base64) {
  // ── MHTML envelope ──────────────────────────────────────────────────────────
  // Both parts encoded as base64 (76-char lines, CRLF) per MIME spec.
  // quoted-printable is avoided because the HTML contains non-ASCII chars
  // (€, —, ×) that would need escaping; base64 is simpler and reliable.
  const htmlLines = Buffer.from(html, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  const pngLines  = chart_png_base64.match(/.{1,76}/g).join('\r\n');
  const boundary  = '----=_NextPart_HospecsForecast_001';

  const mhtml = [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`,
    'X-MimeOLE: Produced by Hospecs Revenue Intelligence',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `Content-Location: forecast_${safePeriod}.html`,
    '',
    htmlLines,
    '',
    `--${boundary}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    `Content-Location: chart001.png`,
    `Content-ID: <${CHART_CID}>`,
    '',
    pngLines,
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');

  outputContent = Buffer.from(mhtml, 'utf8').toString('base64');
  mimeType      = 'message/rfc822';            // .mht MIME type
  fileName      = `forecast_${safePeriod}_${safeDate}_${safeHotel}.mht`;

} else {
  // ── Plain HTML fallback ──────────────────────────────────────────────────────
  outputContent = Buffer.from(html, 'utf8').toString('base64');
  mimeType      = 'text/html';
  fileName      = `forecast_${safePeriod}_${safeDate}_${safeHotel}.html`;
}

console.log(
  `✅ HTML Report Generator V11: ${(forecast_table || []).length} weeks | ` +
  `${(insights || []).length} insights | ${(data_gaps || []).length} gaps | ` +
  `chart=${chart_png_base64 ? 'yes (MHTML)' : 'no (HTML)'} | ${fileName}`
);

return [{
  json: {
    fileName,
    Hotel_Name:          meta.hotel_name,
    Forecast_Created_At: data.Forecast_Created_At
  },
  binary: {
    data: {
      data:     outputContent,
      mimeType,
      fileName
    }
  }
}];
