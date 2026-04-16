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

// ── Find report row and chart PNG from merged inputs ─────────────────────────
// This node receives merged output from two upstream nodes:
//   1. Report Processor  → contains Row_Type = "report"
//   2. QuickChart HTTP Request (format:base64) → contains JSON { data: "data:image/png;base64,..." }
//
// No separate Chart Merger or PNG Extractor node needed.
const allInputs = $input.all();

const reportItem = allInputs.find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error(
    'HTML Report Generator V11: no report row found. ' +
    'Make sure Report Processor is connected and produced Row_Type = "report".'
  );
}

const data = reportItem.json;
const { meta, current_week, forecast_table,
        page1_bridge, insights, data_gaps, page2_intro } = data;

if (!meta || !forecast_table) {
  throw new Error(
    `HTML Report Generator V11: missing meta or forecast_table. ` +
    `Got keys: ${Object.keys(data).join(', ')}`
  );
}

// QuickChart base64 response — the HTTP Request node stores the text body
// under whatever name is set in outputPropertyName (e.g. "data" or "chart").
// Rather than hardcoding the name, scan all string values in the candidate
// item and return the first one that looks like a raw base64 PNG.
function extractChartBase64(items) {
  const known = new Set(['week', 'summary', 'report', 'context', 'chart']);
  const candidate = items.find(item => !known.has(item.json?.Row_Type));
  if (!candidate) return null;

  // Find the first string value in $json that is (or contains) base64 PNG data.
  // This works regardless of what outputPropertyName was set to in the HTTP node.
  let raw = null;
  for (const val of Object.values(candidate.json || {})) {
    if (typeof val === 'string' && val.length > 100) {
      raw = val;
      break;
    }
  }
  if (raw == null) return null;

  // If it's a string that looks like JSON, parse it
  if (typeof raw === 'string' && raw.trimStart().startsWith('{')) {
    try { raw = JSON.parse(raw).data ?? raw; } catch {}
  }

  // Strip data URI prefix if present, validate result looks like base64
  const b64 = String(raw).replace(/^data:image\/[^;]+;base64,/, '');
  return /^[A-Za-z0-9+/]/.test(b64) ? b64 : null;
}

const chart_png_base64 = extractChartBase64(allInputs);
console.log(`Chart PNG: ${chart_png_base64 ? `found (${chart_png_base64.length} chars)` : 'not found'}`);


// ── Colour constants ──────────────────────────────────────────────────────────
const DARK_BLUE   = '#1A4FCC';   // feller, primair blauw
const ACCENT      = '#C0392B';
const AMBER       = '#B07D00';
const GREEN       = '#1A7A4A';
const MUTED       = '#6B7280';
const WHITE       = '#FFFFFF';
const LIGHT_BLUE  = '#E0EAFF';   // licht blauw passend bij het nieuwe primaire blauw
const HIST_BG     = '#EEF2F7';   // licht grijs-blauw voor historische rijen
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
  if (row.type === 'historical') return HIST_BG;
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
const COL_PCT = ['18%','12%','12%','12%','18%','14%','14%'];
const HEADERS  = ['Maand','Kamer-<br>nachten','Bezetting','ADR','Kamer-<br>omzet','Totale<br>omzet','YoY'];

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
      `<td style="${tdL}">${esc(row.label)||'—'}</td>` +
      `<td style="${tdC}">${fmtInt(row.room_nights)}</td>` +
      `<td style="${tdC}">${fmtPct(row.occupancy_pct)}</td>` +
      `<td style="${tdC}">${fmtADR(row.adr)}</td>` +
      `<td style="${tdC}">${fmtEuro(row.room_revenue)}</td>` +
      `<td style="${tdC}">${fmtEuro(row.total_revenue)}</td>` +
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
  // Word ignores CSS width on <img>; use HTML attributes for reliable sizing.
  // 250pt @ 96dpi ≈ 333px wide; height maintains 900×420 aspect ratio → 155px.
  // Centering via text-align:center on the wrapping paragraph (margin:auto ignored by Word).
  return (
    `<p style="text-align:center;margin-top:6pt;margin-bottom:2pt;">` +
    `<img src="cid:${CHART_CID}" width="333" height="155" ` +
    `style="width:250pt;height:auto;" ` +
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

// ── Page-fit estimation ───────────────────────────────────────────────────────
// Estimates content height in cm so we can decide whether a page break is needed.
// A4 usable height = 29.7cm − 2cm top − 2cm bottom = 25.7cm.
// Conservative (90%) threshold avoids underflow from estimation error.
const EST_PAGE_H   = 25.7 * 0.90;   // ~23.1cm safe threshold
const EST_CHARS_PL = 75;             // conservative chars/line at 9pt on 17.4cm width
const EST_LINE_H   = 0.42;           // cm per line (9pt + leading)
const EST_PARA_GAP = 0.21;           // cm paragraph margin-bottom (6pt)

function estTextH(str) {
  if (!str) return 0.35;
  return Math.max(1, Math.ceil(str.length / EST_CHARS_PL)) * EST_LINE_H + EST_PARA_GAP;
}

// Fixed element heights (in cm) derived from pt sizes in the style functions above
const EH = {
  label:    0.35,   // 8pt + 2pt after
  h1:       0.90,   // 20pt + 4pt after
  h2:       1.06,   // 14pt before + 10.5pt text + 5pt after + border
  h3:       0.80,   // 10pt before + 10pt text + 2pt after
  subtitle: 0.82,   // 9pt + 14pt after
  tableHdr: 0.55,   // header row
  tableRow: 0.46,   // data row
  caption:  0.40,   // 7.5pt + 4pt after
  chart:    4.75,   // 155px image + top/bottom spacing + caption
  gapTitle: 0.56,   // 6pt before + 9pt text + 1pt after
};

// Page 1 content above the analysis section
const estP1Height =
  EH.label + EH.h1 + EH.subtitle +
  EH.h2 + estTextH(current_week?.summary) +
  EH.h2 + EH.tableHdr + EH.tableRow * (forecast_table || []).length + EH.caption +
  EH.h2 + estTextH(page1_bridge);

// Analysis section (grafiek + conclusies + gaps)
const estAnalysisHeight =
  estTextH(page2_intro) +
  EH.h2 + EH.chart +
  EH.h2 + (insights  || []).reduce((s, i) => s + EH.h3  + estTextH(i.body),  0) +
  EH.h2 + (data_gaps || []).reduce((s, g) => s + EH.gapTitle + estTextH(g.body), 0);

const needsPageBreak = (estP1Height + estAnalysisHeight) > EST_PAGE_H;

console.log(
  `Page-fit: p1=${estP1Height.toFixed(1)}cm | analysis=${estAnalysisHeight.toFixed(1)}cm | ` +
  `total=${(estP1Height + estAnalysisHeight).toFixed(1)}cm / ${EST_PAGE_H.toFixed(1)}cm → ` +
  `${needsPageBreak ? 'PAGE BREAK' : 'single page'}`
);

// ── Analysis section HTML (shared for both single-page and two-page layout) ──
const analysisHtml =
  bodyTxt(page2_intro || '—') +
  h2('OTB-vergelijking: vorig jaar\u2003\u00b7\u2003forecast\u2003\u00b7\u2003huidig') +
  buildChart(chart_png_base64) +
  h2('Conclusies & actiepunten') +
  buildInsights(insights) +
  h2('Wat ontbreekt om scherpere conclusies te trekken') +
  buildGaps(data_gaps);

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
@page {
  size:       21.0cm 29.7cm;
  margin:     2.0cm 1.8cm 2.0cm 1.8cm;
  mso-paper-source: 0;
}

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
  /* No padding — @page margin handles spacing in Word.
     Browser preview uses body padding instead. */
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

  ${h2('Maandoverzicht')}
  ${buildTable(forecast_table || [])}
  ${caption('Grijs gearceerde rijen zijn historische gerealiseerde maanden. Overige rijen zijn geforecast maanden.')}

  ${h2('Patroon en context')}
  ${bodyTxt(page1_bridge || '—')}

  ${needsPageBreak
    ? referral('\u2192\u2003Zie pagina\u00a02 voor de OTB-vergelijking en de onderliggende analyse.')
    : analysisHtml
  }

</div>

${needsPageBreak ? `
<br style="mso-special-character:line-break;page-break-before:always">

<!-- ═══════════════════════════════════════════════
     PAGINA 2
════════════════════════════════════════════════ -->
<div class="Section2">

  ${label(hotel)}
  ${h1(meta.page2_title || 'OTB-vergelijking & Onderliggende Analyse')}
  ${subtitle(`Vervolg van pagina\u00a01\u2003\u00b7\u2003${period}\u2003\u00b7\u2003${dated}`)}

  ${analysisHtml}

</div>
` : ''}

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
  `✅ HTML Report Generator V11: ${(forecast_table || []).length} months | ` +
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
