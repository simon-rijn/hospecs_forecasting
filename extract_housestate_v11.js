// Hotel Data Processing Script for n8n
// Version: v11
//
// Fixes vs v2_updated:
// - 1.1 (KRITIEK): parseNLNumber() vervangt toNumber() voor alle revenue-velden.
//       Verwerkt Nederlandse getalnotatie correct: punt = duizendscheidingsteken,
//       komma = decimaalteken. Bijv. "2.797,78" → 2797.78, "283,08" → 283.08.
// - 1.2: Negatieve waarden ("-390,19", "-2.089,19") correct verwerkt.
// - 2.1 (KRITIEK): Iteratie start nu bij rij 0 (niet bij headerInfo.index + 1).
//       Datarijen worden herkend op basis van inhoud (weekdag + datum), niet offset.
//       Hierdoor worden dag 1–12 van elke maand niet langer overgeslagen.
// - 2.3: Deduplicatie op datum vóór output; duplicaten worden gelogd als waarschuwing.
// - Check B: Datumcontinuïteitscheck — ontbrekende dagen worden gerapporteerd.
// - Check C: Duplicate-check in summary (door deduplicatiestap).
// - Check D: Bestandsnaam vs. inhoud check (indien filename beschikbaar in metadata).
// - Check E: Negatieve revenue-waarden worden gelogd als waarschuwing per record.

// -------------------- Constants & Utilities --------------------

const WEEKDAY_MAP = {
  ma: 'Monday',
  di: 'Tuesday',
  wo: 'Wednesday',
  do: 'Thursday',
  vr: 'Friday',
  za: 'Saturday',
  zo: 'Sunday',
};

// Hotel names to search for (case-insensitive contains match)
const HOTEL_NAMES = [
  'de Hoeve van Nunspeet',
  // Placeholder for other hotel names - to be added later
  'andere klant 1',
  'andere klant 2',
  'andere klant 3',
  'andere klant 4',
  'andere klant 5',
  'andere klant 6',
  'andere klant 7',
  'andere klant 8',
  'andere klant 9',
  'andere klant 10',
  'andere klant 11',
  'andere klant 12',
  'andere klant 13',
  'andere klant 14',
  'andere klant 15',
  'andere klant 16',
  'andere klant 17',
  'andere klant 18',
  'andere klant 19',
];

// OLD FORMAT: weekday + date combined in one cell, e.g. "ma, 01-09-2025"
const DATE_PATTERN = /^(ma|di|wo|do|vr|za|zo),?\s+\d{2}-\d{2}-\d{4}$/i;

// NEW FORMAT: weekday only, e.g. "wo," or "ma,"
const WEEKDAY_ONLY_PATTERN = /^(ma|di|wo|do|vr|za|zo),?$/i;

// NEW FORMAT: date only, e.g. "01-01-2025"
const DATE_ONLY_PATTERN = /^\d{2}-\d{2}-\d{4}$/;

function isString(v) { return typeof v === 'string'; }

// -------------------- Number Parsing (Fix 1.1 + 1.2) --------------------

/**
 * Parses a Dutch-formatted number string to a JavaScript float.
 * Dutch notation: punt = duizendscheidingsteken, komma = decimaalteken.
 *
 * Examples:
 *   "2.797,78"  → 2797.78   (RoomRevenue, TotalRevenue, FB_Revenue)
 *   "283,08"    → 283.08    (OtherRevenue onder €1.000, geen duizendteken)
 *   "1.472,06"  → 1472.06   (OtherRevenue boven €1.000)
 *   "-390,19"   → -390.19   (negatieve correctieboeking)
 *   "-2.089,19" → -2089.19  (negatieve correctieboeking met duizendteken)
 *   "-0,02"     → -0.02
 *
 * Als de input al een getal is, wordt het direct teruggegeven.
 * Bij null/undefined/leeg wordt null teruggegeven.
 */
function parseNLNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  // Already a JS number (e.g. pre-parsed by n8n Excel node)
  if (typeof value === 'number') return isFinite(value) ? value : null;

  if (!isString(value)) return null;

  const s = value.replace(/\s|\u00A0/g, '').replace(/[€$%]/g, '').trim();
  if (s === '') return null;

  // Preserve leading minus sign (Fix 1.2)
  const negative = s.startsWith('-');
  const abs = negative ? s.slice(1) : s;

  // Dutch notation: remove all dots (thousands separator), replace comma with dot (decimal)
  const normalized = abs.replace(/\./g, '').replace(',', '.');

  const result = parseFloat(normalized);
  if (isNaN(result)) return null;

  return negative ? -result : result;
}

// For non-revenue integer fields (RoomNights) — keep simpler parsing
function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? Math.round(value) : null;
  if (isString(value)) {
    const cleaned = value.replace(/\s|\u00A0/g, '').replace(/[^\d\-]/g, '');
    const num = parseInt(cleaned, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

// -------------------- Format Detection --------------------

function detectFormat(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const keys = Object.keys(rows[i] || {});
    if (keys.some(k => k.startsWith('__EMPTY_'))) return 'new';
    if (keys.some(k => k === 'Periode:' || k.match(/^_\d+$/))) return 'old';
  }
  return 'unknown';
}

// -------------------- Date Row Detection --------------------

// OLD FORMAT: "ma, 01-09-2025"
function isDateRowOld(cellValue) {
  if (!cellValue || !isString(cellValue)) return false;
  return DATE_PATTERN.test(cellValue.trim());
}

// NEW FORMAT: weekday in __EMPTY_4, date in __EMPTY_5
function isDateRowNew(row) {
  const weekdayCell = row['__EMPTY_4'];
  const dateCell = row['__EMPTY_5'];
  if (!weekdayCell || !dateCell) return false;
  if (!isString(weekdayCell) || !isString(dateCell)) return false;
  return WEEKDAY_ONLY_PATTERN.test(weekdayCell.trim()) && DATE_ONLY_PATTERN.test(dateCell.trim());
}

function isDateRow(row, format, dateColumnKey) {
  if (format === 'new') return isDateRowNew(row);
  return isDateRowOld(row[dateColumnKey]);
}

function extractWeekday(datumStr) {
  if (!datumStr || !isString(datumStr)) return 'Unknown';
  const abbr = datumStr.split(',')[0].trim().toLowerCase().split(/\s+/)[0];
  return WEEKDAY_MAP[abbr] || 'Unknown';
}

function parseDateToISO(datumStr) {
  if (!datumStr || !isString(datumStr)) return null;
  const m = datumStr.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
  if (!m) return null;
  const [, dd, MM, yyyy] = m;
  return `${yyyy}-${MM}-${dd}`;
}

// -------------------- Page Break / Header Row Detection --------------------

function isPageBreakRow(row) {
  for (const val of Object.values(row)) {
    if (isString(val)) {
      const lower = val.toLowerCase();
      if (lower.includes('user:') || lower.includes('print date') || lower.match(/page\s+\d+/i)) {
        return true;
      }
    }
  }
  return false;
}

function isRepeatedHeaderRow(row) {
  const values = Object.values(row).filter(v => isString(v) && v.trim());
  if (values.length <= 2) {
    const joined = values.join(' ').toLowerCase();
    if (joined.includes('hotelstatus') || joined.includes('hotel de hoeve')) {
      return true;
    }
  }
  return false;
}

// -------------------- Hotel Name Extraction --------------------

function extractHotelName(rows) {
  const searchRows = rows.slice(0, Math.min(3, rows.length));
  for (const hotelName of HOTEL_NAMES) {
    const normalized = hotelName.toLowerCase();
    for (const row of searchRows) {
      for (const key of Object.keys(row)) {
        if (isString(key) && key.trim().toLowerCase().includes(normalized)) return hotelName;
      }
      for (const value of Object.values(row)) {
        if (isString(value) && value.trim().toLowerCase().includes(normalized)) return hotelName;
      }
    }
  }
  return 'error';
}

// -------------------- Header Detection --------------------

function normalizeHeaderLabel(val) {
  if (!isString(val)) return '';
  return val.replace(/\u00A0/g, ' ').toLowerCase().trim().replace(/[.,:;]+/g, '').replace(/\s+/g, ' ');
}

function findHeaderRow(rows, format) {
  // Strategy 1: strict anchored detection
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = rows[i] || {};
    let normDatum = '';
    if (format === 'new') {
      normDatum = normalizeHeaderLabel(row['__EMPTY_3']);
    } else {
      normDatum = normalizeHeaderLabel(row['Periode:']);
    }
    if (normDatum === 'datum') {
      const values = Object.values(row).map(normalizeHeaderLabel);
      let score = 0;
      if (values.some(v => v === 'bezet')) score++;
      if (values.some(v => v === 'totaal')) score++;
      if (values.some(v => v === 'accom' || v.startsWith('accom'))) score++;
      if (score >= 2) return { row, index: i, format };
    }
  }

  // Strategy 2: heuristic fallback
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    let score = 0;
    for (const v of Object.values(row)) {
      const s = normalizeHeaderLabel(v);
      if (!s) continue;
      if (s.includes('datum')) score += 2;
      if (s.includes('bezet')) score += 2;
      if (s.includes('accom')) score += 2;
      if (s.includes('totaal')) score += 2;
    }
    if (score >= 4) return { row, index: i, format };
  }
  return null;
}

function createColumnMapping(headerRow, format) {
  const mapping = { format };
  for (const [key, value] of Object.entries(headerRow)) {
    const s = normalizeHeaderLabel(value);
    if (!s) continue;
    if (s === 'datum') { mapping.date = key; continue; }
    if (s === 'bezet') { mapping.roomNights = key; continue; }
    if (s === 'totaal') { mapping.totalRevenue = key; continue; }
    if (s === 'accom' || s.startsWith('accom')) { mapping.roomRevenue = key; continue; }
    if (s === 'f&b' || s === 'fb' || s === 'f & b') { mapping.fbRevenue = key; continue; }
    if (s === 'extras' || s === 'other' || s === 'overig') { mapping.otherRevenue = key; continue; }
  }

  if (format === 'new') {
    mapping.splitDate = true;
    mapping.weekdayCol = '__EMPTY_4';
    mapping.dateCol = '__EMPTY_5';
    // NEW FORMAT: "Bezet" header is at __EMPTY_14 but data is at __EMPTY_15
    if (mapping.roomNights && mapping.roomNights === '__EMPTY_14') {
      mapping.roomNights = '__EMPTY_15';
    }
  }
  return mapping;
}

function withFallback(mapping, format) {
  const m = { ...mapping };
  if (format === 'new') {
    if (!m.date) m.date = '__EMPTY_3';
    if (!m.roomNights) m.roomNights = '__EMPTY_15';
    if (!m.roomRevenue) m.roomRevenue = '__EMPTY_54';
    if (!m.fbRevenue) m.fbRevenue = '__EMPTY_57';
    if (!m.otherRevenue) m.otherRevenue = '__EMPTY_61';
    if (!m.totalRevenue) m.totalRevenue = '__EMPTY_63';
    m.splitDate = true;
    m.weekdayCol = '__EMPTY_4';
    m.dateCol = '__EMPTY_5';
  } else {
    if (!m.date) m.date = 'Periode:';
    if (!m.roomNights) m.roomNights = '_4';
    if (!m.roomRevenue) m.roomRevenue = '_34';
    if (!m.fbRevenue) m.fbRevenue = '_35';
    if (!m.otherRevenue) m.otherRevenue = '_38';
    if (!m.totalRevenue) m.totalRevenue = '_40';
  }
  return m;
}

function computeMissingColumns(mapping) {
  const missing = [];
  if (!mapping.date) missing.push('date');
  if (!mapping.roomNights) missing.push('roomNights');
  if (!mapping.roomRevenue) missing.push('roomRevenue');
  if (!mapping.fbRevenue) missing.push('fbRevenue');
  if (!mapping.otherRevenue) missing.push('otherRevenue');
  if (!mapping.totalRevenue) missing.push('totalRevenue');
  return missing;
}

// -------------------- Row Processing --------------------

// NON_DATA_MARKERS: these values in the weekday/date column indicate non-data rows
const NON_DATA_MARKERS = new Set([
  'datum', 'summary', 'type', 'revenue', 'ooo rooms', 'pseudorooms',
  'state', 'soort tarief', 'totaal', 'systeemdatum:', 'kamers', 'bedden',
  'aankomsten', 'vertrekkers', 'inhuis', 'januari', 'februari', 'maart',
  'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober',
  'november', 'december', 'hotelstatus'
]);

function processRowObject(rowObj, mapping, format) {
  // NEW FORMAT: skip page break and repeated header rows
  if (format === 'new') {
    if (isPageBreakRow(rowObj)) return { kind: 'skip' };
    if (isRepeatedHeaderRow(rowObj)) return { kind: 'skip' };
  }

  let rawDateCell, weekdayStr, dateStr;

  if (mapping.splitDate) {
    // NEW FORMAT: date split across two columns
    weekdayStr = rowObj[mapping.weekdayCol];
    dateStr = rowObj[mapping.dateCol];

    if (!weekdayStr && !dateStr) return { kind: 'skip' };
    if (!isString(weekdayStr) || !isString(dateStr)) return { kind: 'skip' };

    weekdayStr = weekdayStr.trim();
    dateStr = dateStr.trim();

    const normWeekday = normalizeHeaderLabel(weekdayStr);
    const normDate = normalizeHeaderLabel(dateStr);
    if (NON_DATA_MARKERS.has(normWeekday) || NON_DATA_MARKERS.has(normDate)) {
      return { kind: 'skip' };
    }

    if (!WEEKDAY_ONLY_PATTERN.test(weekdayStr) || !DATE_ONLY_PATTERN.test(dateStr)) {
      if (/\d{2}-\d{2}-\d{4}/.test(dateStr)) {
        return { kind: 'error', error: `Ongeldig datumpatroon (nieuw formaat): weekdag="${weekdayStr}", datum="${dateStr}"` };
      }
      return { kind: 'skip' };
    }

    rawDateCell = `${weekdayStr} ${dateStr}`;

  } else {
    // OLD FORMAT: date in single column
    rawDateCell = rowObj[mapping.date];
    if (!rawDateCell || !isString(rawDateCell)) return { kind: 'skip' };
    rawDateCell = rawDateCell.trim();

    if (NON_DATA_MARKERS.has(normalizeHeaderLabel(rawDateCell))) return { kind: 'skip' };

    if (!isDateRowOld(rawDateCell)) {
      if (/\b\d{2}-\d{2}-\d{4}\b/.test(rawDateCell)) {
        return { kind: 'error', error: `Ongeldig datumpatroon: "${rawDateCell}" (verwacht: "ma|di|wo|do|vr|za|zo, DD-MM-YYYY")` };
      }
      return { kind: 'skip' };
    }
  }

  const isoDate = parseDateToISO(rawDateCell);
  if (!isoDate) {
    return { kind: 'error', error: `Datum niet te parsen: "${rawDateCell}"` };
  }

  const englishWeekday = extractWeekday(rawDateCell);

  // Parse revenue fields with Dutch number notation (Fix 1.1 + 1.2)
  const accom = parseNLNumber(rowObj[mapping.roomRevenue]);
  const fb    = parseNLNumber(rowObj[mapping.fbRevenue]);
  const other = parseNLNumber(rowObj[mapping.otherRevenue]);
  const total = parseNLNumber(rowObj[mapping.totalRevenue]);

  // Parse room nights as integer (not a revenue field)
  const rn = toInteger(rowObj[mapping.roomNights]);

  const out = {
    Date: isoDate,
    Weekday: englishWeekday,
    RoomNights: rn,
    RoomRevenue: accom,
    FB_Revenue: fb,
    OtherRevenue: other,
    TotalRevenue: total,
  };

  const warnings = [];

  // Check A — Revenue-som (tolerantie < €0,01)
  if (accom !== null && fb !== null && other !== null && total !== null) {
    const calculatedSum = accom + fb + other;
    const diff = Math.abs(calculatedSum - total);
    if (diff > 0.01) {
      warnings.push(
        `Revenue-som mismatch: ${accom.toFixed(2)} + ${fb.toFixed(2)} + ${other.toFixed(2)} = ${calculatedSum.toFixed(2)}, maar TotalRevenue = ${total.toFixed(2)} (verschil: ${diff.toFixed(2)})`
      );
    }
  }

  // Check E — Negatieve revenue-waarden (waarschuwing, niet fout)
  if (accom !== null && accom < 0) warnings.push(`Negatieve RoomRevenue: ${accom}`);
  if (fb !== null && fb < 0)    warnings.push(`Negatieve FB_Revenue: ${fb}`);
  if (other !== null && other < 0) warnings.push(`Negatieve OtherRevenue: ${other}`);
  if (total !== null && total < 0) warnings.push(`Negatieve TotalRevenue: ${total}`);

  if (warnings.length) out._warnings = warnings;

  return { kind: 'ok', value: out };
}

// -------------------- Post-processing Checks --------------------

/**
 * Check B: Datumcontinuïteit
 * Geeft een array van ontbrekende datums terug (als ISO strings).
 */
function checkDateContinuity(records) {
  if (records.length < 2) return [];
  const missing = [];
  for (let i = 1; i < records.length; i++) {
    const prev = new Date(records[i - 1].Date);
    const curr = new Date(records[i].Date);
    const diffDays = Math.round((curr - prev) / 86400000);
    if (diffDays > 1) {
      // Log all missing dates in the gap
      for (let d = 1; d < diffDays; d++) {
        const missing_date = new Date(prev);
        missing_date.setDate(missing_date.getDate() + d);
        missing.push(missing_date.toISOString().split('T')[0]);
      }
    }
  }
  return missing;
}

/**
 * Check D: Bestandsnaam vs. inhoud
 * Probeert datumrange uit bestandsnaam te parsen en vergelijkt met data.
 * Formaat: HouseStateV2_D-M-YYYY_-_D-M-YYYY.csv
 * Geeft null terug als bestandsnaam niet beschikbaar of niet te parsen.
 */
function checkFilenameVsContent(filename, records) {
  if (!filename || records.length === 0) return null;

  // Match "D-M-YYYY" of "DD-MM-YYYY" twice in de bestandsnaam
  const matches = filename.match(/(\d{1,2}-\d{1,2}-\d{4})/g);
  if (!matches || matches.length < 2) return null;

  function parseDMY(s) {
    const [d, m, y] = s.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const expectedStart = parseDMY(matches[0]);
  const expectedEnd   = parseDMY(matches[1]);
  const actualStart   = records[0].Date;
  const actualEnd     = records[records.length - 1].Date;

  if (actualStart !== expectedStart || actualEnd !== expectedEnd) {
    return `WAARSCHUWING: "${filename}" bevat data van ${actualStart} t/m ${actualEnd}, verwacht ${expectedStart} t/m ${expectedEnd}`;
  }
  return null;
}

// -------------------- Main Processing --------------------

const items = $input.all();
const rawResults = [];         // before deduplication
let totalRows = 0;
let nonDataRowsSkipped = 0;
let failedValidation = 0;
const failedRows = [];
let usedFallbackAny = false;
const aggMissing = [];
let hotelNameExtracted = null;
let isFirstDataRow = true;
let columnDetectionLog = [];
let detectedFormat = 'unknown';
let filename = null;

for (const item of items) {
  // Try to get filename from n8n item metadata
  if (!filename) {
    filename = item.json?.filename
      || item.json?.fileName
      || item.binary?.data?.fileName
      || null;
  }

  let rows;
  const inputData = item.json;
  if (Array.isArray(inputData)) rows = inputData;
  else if (inputData && typeof inputData === 'object') rows = [inputData];
  else rows = [];

  totalRows += rows.length;

  if (detectedFormat === 'unknown' && rows.length > 0) {
    detectedFormat = detectFormat(rows);
  }

  if (hotelNameExtracted === null && rows.length > 0) {
    hotelNameExtracted = extractHotelName(rows);
  }

  // Detect header for column mapping only (no longer used as startIndex)
  const headerInfo = findHeaderRow(rows, detectedFormat);
  let mapping = {};

  if (headerInfo) {
    mapping = createColumnMapping(headerInfo.row, detectedFormat);
    columnDetectionLog.push({
      format: detectedFormat,
      headerRowIndex: headerInfo.index,
      detectedMappings: { ...mapping },
      headerRowValues: Object.entries(headerInfo.row)
        .filter(([, v]) => v && isString(v) && v.trim())
        .map(([k, v]) => ({ key: k, value: v }))
    });
  }

  const preFallbackMissing = computeMissingColumns(mapping);
  if (preFallbackMissing.length) {
    mapping = withFallback(mapping, detectedFormat);
    usedFallbackAny = true;
  }

  const missingColumnsAfter = computeMissingColumns(mapping);
  for (const k of missingColumnsAfter) if (!aggMissing.includes(k)) aggMissing.push(k);

  if (rows.length === 0) {
    return [{ json: { success: false, message: 'Geen data gevonden in input.' } }];
  }
  if (missingColumnsAfter.includes('date') && !mapping.splitDate) {
    return [{ json: { success: false, message: 'KRITIEKE FOUT: Datumkolom niet gevonden.' } }];
  }

  // Fix 2.1: Itereer ALLE rijen vanaf index 0 — geen vaste startIndex meer.
  // processRowObject() herkent datarijen op basis van inhoud en slaat de rest over.
  for (let i = 0; i < rows.length; i++) {
    const res = processRowObject(rows[i], mapping, detectedFormat);

    if (res.kind === 'ok') {
      if (isFirstDataRow) {
        res.value.hotelName = hotelNameExtracted;
        isFirstDataRow = false;
      }
      rawResults.push(res.value);
    } else if (res.kind === 'error') {
      failedValidation++;
      failedRows.push({ error: true, row_index: i, validation_errors: [res.error], raw_data: rows[i] });
    } else {
      nonDataRowsSkipped++;
    }
  }
}

// Fix 2.3: Deduplicatie op datum vóór output
const seen = new Set();
const duplicateDates = [];
const allResults = [];

const deduplicated = rawResults.filter(record => {
  if (seen.has(record.Date)) {
    duplicateDates.push(record.Date);
    return false;
  }
  seen.add(record.Date);
  return true;
});

// Sort chronologically
deduplicated.sort((a, b) => a.Date.localeCompare(b.Date));

// Wrap in n8n format
for (const record of deduplicated) {
  allResults.push({ json: record });
}

const successfullyProcessed = deduplicated.length;

if (successfullyProcessed === 0 && failedValidation > 0) {
  return [{ json: { success: false, message: `Geen geldige rijen verwerkt. ${failedValidation} rijen gefaald.` } }];
}

// Check B: Datumcontinuïteit
const missingDates = checkDateContinuity(deduplicated);

// Check D: Bestandsnaam vs. inhoud
const filenameWarning = checkFilenameVsContent(filename, deduplicated);

// Column warnings
const columnWarnings = [];
if (aggMissing.includes('fbRevenue')) {
  columnWarnings.push('WAARSCHUWING: F&B Revenue kolom niet gevonden. Fallback gebruikt.');
}
if (aggMissing.includes('otherRevenue')) {
  columnWarnings.push('WAARSCHUWING: OtherRevenue kolom niet gevonden. Fallback gebruikt.');
}

// Revenue-som warnings count (Check A)
const revenueMismatchCount = deduplicated.filter(
  r => r._warnings && r._warnings.some(w => w.includes('Revenue-som mismatch'))
).length;

// Negatieve waarden count (Check E)
const negativeValueCount = deduplicated.filter(
  r => r._warnings && r._warnings.some(w => w.includes('Negatieve'))
).length;

// Summary
allResults.push({
  json: {
    _summary: true,
    detected_format: detectedFormat,
    hotel_name: hotelNameExtracted,
    filename: filename,
    non_data_rows_skipped: nonDataRowsSkipped,
    missing_columns: aggMissing,
    missing_column_warnings: columnWarnings,
    used_fallback: usedFallbackAny,
    successfully_processed: successfullyProcessed,
    failed_validation: failedValidation,
    errors_count: failedValidation > 0 ? 1 : 0,
    // Check B
    missing_dates_count: missingDates.length,
    missing_dates: missingDates,
    // Check C
    duplicate_dates_removed: duplicateDates.length,
    duplicate_dates: duplicateDates,
    // Check D
    filename_vs_content_warning: filenameWarning,
    // Check A
    revenue_mismatch_count: revenueMismatchCount,
    // Check E
    negative_value_records: negativeValueCount,
    column_detection_log: columnDetectionLog,
  },
});

if (failedRows.length > 0) {
  allResults.push({ json: { _errors: true, failed_rows: failedRows } });
}

return allResults;
