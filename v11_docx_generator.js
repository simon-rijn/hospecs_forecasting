/**
 * Hotel Revenue Forecasting System - Module 5: Word Document Generator (V11)
 *
 * Generates a fully-formatted 2-page .docx report using docx.js.
 *
 * Input: finds the Row_Type = 'report' item from $input.all().
 *        chart_png_base64 may be null (chart node not yet built) — image is skipped gracefully.
 *
 * Output: binary .docx file as base64 string.
 *
 * N8N wiring:
 *   Report Processor → [Filter: Row_Type = 'report'] → this node → (email / storage)
 *
 * Library: docx (npm: docx)
 * Install in n8n: Settings → Community Nodes → docx
 */

// ============ N8N EXECUTION CODE ============

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, PageBreak, ImageRun, WidthType,
  BorderStyle, ShadingType, Header, Footer, PageNumber,
  convertInchesToTwip
} = require('docx');

// ── Find report row from input ────────────────────────────────────────────────
const reportItem = $input.all().find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error(
    'Docx Generator V11: no report row found in input. ' +
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
    'Docx Generator V11: report row is missing required fields (meta, forecast_table). ' +
    `Got keys: ${Object.keys(data).join(', ')}`
  );
}

// ── Colour palette (hex without #) ────────────────────────────────────────────
const C = {
  DARK_BLUE:   '1B2A4A',
  MID_BLUE:    '2E5090',
  ACCENT:      'C0392B',
  AMBER:       'B07D00',
  GREEN:       '1A7A4A',
  MUTED:       '6B7280',
  WHITE:       'FFFFFF',
  LIGHT_BLUE:  'EBF0F8',
  PARTIAL_BG:  'FFF8E1',
  VARIANCE_BG: 'FEF2F2',
  BODY:        '1C1C1C',
  BORDER:      'D0D6E0'
};

// ── Number / date formatters ──────────────────────────────────────────────────
function formatValue(value, type) {
  if (value == null || value === '' || isNaN(Number(value))) return '—';
  const n = Number(value);
  switch (type) {
    case 'euro':
      // €25.702 — thousands separator = punt, no decimals
      return '€' + Math.round(n).toLocaleString('nl-NL', { maximumFractionDigits: 0 });
    case 'adr':
      // €59,98 — comma decimal, 2 places
      return '€' + n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'pct':
      // 65,7%
      return n.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    case 'yoy': {
      // -11,3% — always show sign
      const sign = n >= 0 ? '+' : '';
      return sign + n.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    }
    case 'integer':
      return Math.round(n).toString();
    default:
      return String(value);
  }
}

// ── Paragraph helpers ─────────────────────────────────────────────────────────

function makeHotelLabel(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 16, color: C.MUTED, bold: false })],
    spacing:  { after: 20 }
  });
}

function makePageTitle(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 40, bold: true, color: C.DARK_BLUE })],
    spacing:  { after: 40 }
  });
}

function makeSubtitle(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 18, color: C.MUTED })],
    spacing:  { after: 200 }
  });
}

function makeSectionHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 21, bold: true, color: C.DARK_BLUE })],
    spacing:  { before: 200, after: 80 }
  });
}

function makeBody(text, options = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 18, color: C.BODY, ...options })],
    alignment: AlignmentType.JUSTIFIED,
    spacing:   { after: 140 }
  });
}

function makeCaption(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 15, italics: true, color: C.MUTED })],
    spacing:  { after: 80 }
  });
}

function makeInsightHeading(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 19, bold: true, color: C.DARK_BLUE })],
    spacing:  { before: 160, after: 40 }
  });
}

function makeGapTitle(text) {
  return new Paragraph({
    children: [new TextRun({ text: `· ${text}`, size: 17, bold: true, color: C.DARK_BLUE })],
    spacing:  { before: 80, after: 20 }
  });
}

function makeGapBody(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 17, color: C.MUTED })],
    spacing:  { after: 80 }
  });
}

function makeReferral(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 17, italics: true, color: C.MUTED })],
    spacing:  { after: 80 }
  });
}

function makeFooterParagraph(text) {
  return new Paragraph({
    children:  [new TextRun({ text, size: 14, color: C.MUTED })],
    alignment: AlignmentType.CENTER
  });
}

function makePageBreak() {
  return new Paragraph({
    children: [new PageBreak()]
  });
}

// ── Table helpers ─────────────────────────────────────────────────────────────

// Column widths in twips (total = 8280)
const COL_WIDTHS = [700, 1400, 900, 900, 900, 800, 800, 1080, 800];

const HEADER_LABELS = [
  'Week', 'Periode', 'Forecast\nnachten', 'OTB\nnachten',
  'Pickup\nnodig', 'Bezetting', 'ADR', 'Kamer-\nomzet', 'YoY'
];

function headerCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { fill: C.DARK_BLUE, type: ShadingType.CLEAR, color: C.DARK_BLUE },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 8, color: C.DARK_BLUE },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: C.DARK_BLUE },
      left:   { style: BorderStyle.SINGLE, size: 8, color: C.DARK_BLUE },
      right:  { style: BorderStyle.SINGLE, size: 8, color: C.DARK_BLUE }
    },
    children: [new Paragraph({
      children:  [new TextRun({ text, size: 15, bold: true, color: C.WHITE })],
      alignment: AlignmentType.CENTER,
      spacing:   { before: 40, after: 40 }
    })]
  });
}

function dataCell(text, width, { align = AlignmentType.CENTER, color = C.BODY, bold = false, bgFill = C.WHITE } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { fill: bgFill, type: ShadingType.CLEAR, color: bgFill },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: C.BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: C.BORDER },
      left:   { style: BorderStyle.SINGLE, size: 4, color: C.BORDER },
      right:  { style: BorderStyle.SINGLE, size: 4, color: C.BORDER }
    },
    children: [new Paragraph({
      children:  [new TextRun({ text: String(text ?? '—'), size: 15, color, bold })],
      alignment: align,
      spacing:   { before: 30, after: 30 }
    })]
  });
}

function yoyColor(yoy) {
  if (yoy == null) return C.BODY;
  if (yoy < -10) return C.ACCENT;
  if (yoy < 0)   return C.AMBER;
  return C.GREEN;
}

function rowBackground(row, index) {
  if (row.is_partial)              return C.PARTIAL_BG;
  if ((row.variance_pct ?? 0) >= 14) return C.VARIANCE_BG;
  if (index % 2 === 0)             return C.LIGHT_BLUE;
  return C.WHITE;
}

function buildForecastTableRow(row, index) {
  const bg    = rowBackground(row, index);
  const yoyN  = row.yoy_pct;
  const yoyTxt = formatValue(yoyN, 'yoy');

  return new TableRow({
    cantSplit: true,
    children: [
      dataCell(row.week_key                             || '—', COL_WIDTHS[0], { bgFill: bg }),
      dataCell(row.period                               || '—', COL_WIDTHS[1], { align: AlignmentType.LEFT, bgFill: bg }),
      dataCell(formatValue(row.forecast_nights, 'integer'), COL_WIDTHS[2], { bgFill: bg }),
      dataCell(formatValue(row.otb_nights,      'integer'), COL_WIDTHS[3], { bgFill: bg }),
      dataCell(formatValue(row.pickup_needed,   'integer'), COL_WIDTHS[4], { bgFill: bg }),
      dataCell(formatValue(row.occupancy_pct,   'pct'),     COL_WIDTHS[5], { bgFill: bg }),
      dataCell(formatValue(row.adr,             'adr'),     COL_WIDTHS[6], { bgFill: bg }),
      dataCell(formatValue(row.room_revenue,    'euro'),    COL_WIDTHS[7], { bgFill: bg }),
      dataCell(yoyTxt, COL_WIDTHS[8], { color: yoyColor(yoyN), bold: true, bgFill: bg })
    ]
  });
}

function buildForecastTable(rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    cantSplit:   true,
    children: HEADER_LABELS.map((lbl, i) => headerCell(lbl, COL_WIDTHS[i]))
  });

  const dataRows = rows.map((row, i) => buildForecastTableRow(row, i));

  return new Table({
    width: { size: 8280, type: WidthType.DXA },
    rows:  [headerRow, ...dataRows]
  });
}

// ── Chart image ───────────────────────────────────────────────────────────────
// chart_png_base64 comes from a separate chart generation node.
// Returns an ImageRun paragraph or a placeholder caption if no image is present.

function buildChartBlock(base64png) {
  const captionText =
    'OTB vorig jaar (LY) = gerealiseerde kamernachten op vergelijkbaar meetmoment vorig jaar.  ' +
    'Forecast = modeluitkomst op basis van historische pickupcurves.  ' +
    `OTB huidig = geboekte nachten per ${meta.created_at || '—'}.`;

  if (!base64png) {
    return [
      makeCaption('[Grafiek niet beschikbaar — chart_png_base64 ontbreekt in invoer]'),
      makeCaption(captionText)
    ];
  }

  const imgBuffer = Buffer.from(base64png, 'base64');
  const imgParagraph = new Paragraph({
    children: [new ImageRun({
      data:         imgBuffer,
      transformation: {
        width:  Math.round(600 * 9525 / 9525),   // 600 px
        height: Math.round(250 * 9525 / 9525)    // 250 px
      }
    })],
    alignment: AlignmentType.CENTER,
    spacing:   { after: 40 }
  });

  return [imgParagraph, makeCaption(captionText)];
}

// ── Document structure ────────────────────────────────────────────────────────

const hotelLabel        = meta.hotel_name    || 'Hotel';
const reportPeriodLabel = meta.report_period || '';
const createdAtLabel    = meta.created_at    || '';

// ---- PAGE 1 ----
const page1Children = [
  // 1. Hotelnaam
  makeHotelLabel(hotelLabel),

  // 2. Paginatitel
  makePageTitle(meta.page1_title),

  // 3. Subtitel
  makeSubtitle(`${reportPeriodLabel}  ·  ${createdAtLabel}  ·  Hospecs Revenue Intelligence`),

  // 4. Huidige stand
  makeSectionHeading('Huidige stand'),
  makeBody(current_week?.summary || '—'),

  // 5. Weekoverzicht — table
  makeSectionHeading(`Weekoverzicht ${reportPeriodLabel}`),
  buildForecastTable(forecast_table || []),
  makeCaption(
    '* Gedeeltelijke week — OTB is definitief resultaat.  ' +
    'Rood gearceerde rijen hebben een forecastvariantie ≥ 14%.'
  ),

  // 6. Patroon en context
  makeSectionHeading('Patroon en context'),
  makeBody(page1_bridge || '—'),

  // 7. Doorverwijzing
  makeReferral('→  Zie pagina 2 voor de OTB-vergelijking en de onderliggende analyse.'),

  // 9. Pagina-einde
  makePageBreak()
];

// ---- PAGE 2 ----
const insightBlocks = (insights || []).flatMap(ins => [
  makeInsightHeading(ins.heading || ''),
  makeBody(ins.body || '—')
]);

const gapBlocks = (data_gaps || []).flatMap(gap => [
  makeGapTitle(gap.title || ''),
  makeGapBody(gap.body  || '—')
]);

const page2Children = [
  // 1. Hotelnaam
  makeHotelLabel(hotelLabel),

  // 2. Paginatitel
  makePageTitle(meta.page2_title),

  // 3. Subtitel
  makeSubtitle(`Vervolg van pagina 1  ·  ${reportPeriodLabel}  ·  ${createdAtLabel}`),

  // 4. Intro
  makeBody(page2_intro || '—'),

  // 5. Grafiek
  makeSectionHeading('OTB-vergelijking: vorig jaar · forecast · huidig'),
  ...buildChartBlock(chart_png_base64),

  // 6. Conclusies
  makeSectionHeading('Conclusies'),
  ...insightBlocks,

  // 7. Kennishiaten
  makeSectionHeading('Wat ontbreekt om scherpere conclusies te trekken'),
  ...gapBlocks
];

// ── Footers ───────────────────────────────────────────────────────────────────
function makeFooter(pageLabel) {
  return {
    default: new Footer({
      children: [
        makeFooterParagraph(`${pageLabel}  ·  ${hotelLabel}  ·  Hospecs Revenue Forecast`)
      ]
    })
  };
}

// ── Assemble document ─────────────────────────────────────────────────────────
// docx.js creates one section per page group to support different footers.
// Page 1: all page1Children + footer 1; Page 2: all page2Children + footer 2.

const doc = new Document({
  sections: [
    // ── Section 1: Page 1 ──────────────────────────────────────────────────
    {
      properties: {
        page: {
          size: {
            width:  12240,  // A4 width in twips (210mm)
            height: 15840   // A4 height in twips (297mm)
          },
          margin: {
            top:    1440,
            bottom: 1440,
            left:   1440,
            right:  1440
          }
        }
      },
      footers: makeFooter('Pagina 1 van 2'),
      children: page1Children
    },
    // ── Section 2: Page 2 ──────────────────────────────────────────────────
    {
      properties: {
        page: {
          size: {
            width:  12240,
            height: 15840
          },
          margin: {
            top:    1440,
            bottom: 1440,
            left:   1440,
            right:  1440
          }
        }
      },
      footers: makeFooter('Pagina 2 van 2'),
      children: page2Children
    }
  ]
});

// ── Render and return ─────────────────────────────────────────────────────────
const base64Docx = await Packer.toBase64String(doc);

const safeHotelName   = hotelLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
const safePeriod      = reportPeriodLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
const safeDate        = createdAtLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
const fileName        = `forecast_${safePeriod}_${safeDate}_${safeHotelName}.docx`;

console.log(`✅ Docx Generator V11: document built | ${forecast_table?.length ?? 0} weeks | ${fileName}`);

return [{
  json: {},
  binary: {
    data: {
      data:     base64Docx,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName
    }
  }
}];
