// Extract Housestate v0.12 — 2026-05-18
// Hotel Data Processing Script for n8n
// Processes Dutch hotel occupancy data and converts to clean JSON
// Error handling & observability aligned with README style (pared down):
// summary fields: header_rows_skipped, non_data_rows_skipped, missing_columns,
// used_fallback, successfully_processed, failed_validation, errors_count.
//
// V2.1 UPDATE (Feb 2026): Support for new Excel export format where:
// - Column keys changed from "_N" and "Periode:" to "__EMPTY_N"
// - Date is now SPLIT across two columns (weekday + date separately)
// - Hotel name now appears in cell values instead of column keys
// - Page break rows are inserted in the data
// - Backwards compatible with old format
//
// V2.2 UPDATE (Apr 2026): Support for Cloudmersive XLSX-to-JSON conversion format where:
// - Column keys are generic "ColumnN" (e.g., Column0, Column4, Column53)
// - Date split: Column4=weekday (e.g., "ma,"), Column5=date (e.g., "07-04-2025")
// - RoomNights (Bezet): Column14
// - RoomRevenue (Accom.): Column53
// - FB_Revenue (F&B): Column56
// - OtherRevenue (extras): Column60
// - TotalRevenue (Totaal): Column62
// - Numbers use US format: comma=thousands, period=decimal (e.g., "5,696.67" → 5696.67)
//
// V11 FIXES:
// - 1.1 (KRITIEK): parseNLNumber() voor revenue-velden — punt=duizend, komma=decimaal
// - 1.2: Negatieve correctieboekingen correct verwerkt (-390,19 → -390.19)
// - 2.1 (KRITIEK): Iteratie vanaf rij 0; datarijen herkend op inhoud, niet op offset
// - 2.3: Deduplicatie op datum vóór output
// - Check B: Datumcontinuïteit (ontbrekende dagen gerapporteerd in summary)
// - Check C: Duplicaten geteld in summary
// - Check D: Bestandsnaam vs. inhoud check
// - Check E: Negatieve revenue-waarden als waarschuwing per record

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
  // Placeholder for 19 other hotel names - to be added later
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

// tolerant: optional comma, flexible spaces, strict DD-MM-YYYY (OLD FORMAT - combined)
const DATE_PATTERN = /^(ma|di|wo|do|vr|za|zo),?\s+\d{2}-\d{2}-\d{4}$/i;

// NEW FORMAT: weekday only pattern (e.g., "wo," or "ma,")
const WEEKDAY_ONLY_PATTERN = /^(ma|di|wo|do|vr|za|zo),?$/i;

// NEW FORMAT: date only pattern (e.g., "01-01-2025")
const DATE_ONLY_PATTERN = /^\d{2}-\d{2}-\d{4}$/;

function isString(v) { return typeof v === 'string'; }

// -------------------- Column Detection --------------------

// Scan all cells in first 10 rows to build column mapping.
// Applies Cloudmersive-specific offset correction after scan:
//   "Bezet" label at Column14 → data at Column15 (merged-cell offset)
//   "extras" and "Totaal" labels share their column with the data — no offset.
function buildColumnMapping(rows) {
  const mapping = {
    splitDate:    true,
    weekdayCol:   'Column4',
    dateCol:      'Column5',
    numberFormat: 'us',
  };
  const detectionLog = {};

  const searchRows = rows.slice(0, Math.min(rows.length, 10));

  for (let rowIdx = 0; rowIdx < searchRows.length; rowIdx++) {
    const row = searchRows[rowIdx] || {};
    for (const [key, value] of Object.entries(row)) {
      const s = normalizeHeaderLabel(value);
      if (!s) continue;

      if (s === 'datum' && !mapping.date) {
        mapping.date = key;
        detectionLog.date = { column: key, method: 'scan', row: rowIdx };
      }
      if (s === 'bezet' && !mapping.roomNights) {
        mapping.roomNights = key;
        detectionLog.roomNights = { column: key, method: 'scan', row: rowIdx };
      }
      if (s === 'totaal' && !mapping.totalRevenue) {
        mapping.totalRevenue = key;
        detectionLog.totalRevenue = { column: key, method: 'scan', row: rowIdx };
      }
      if ((s === 'accom' || s.startsWith('accom')) && !mapping.roomRevenue) {
        mapping.roomRevenue = key;
        detectionLog.roomRevenue = { column: key, method: 'scan', row: rowIdx };
      }
      if ((s === 'f&b' || s === 'fb' || s === 'f & b') && !mapping.fbRevenue) {
        mapping.fbRevenue = key;
        detectionLog.fbRevenue = { column: key, method: 'scan', row: rowIdx };
      }
      if ((s === 'extras' || s === 'other' || s === 'overig') && !mapping.otherRevenue) {
        mapping.otherRevenue = key;
        detectionLog.otherRevenue = { column: key, method: 'scan', row: rowIdx };
      }
    }
  }

  // Offset correction: header label sits one column left of the actual data column
  const applyOffset = (field) => {
    if (!mapping[field] || !mapping[field].startsWith('Column')) return;
    const n = parseInt(mapping[field].replace('Column', ''), 10);
    if (isNaN(n)) return;
    const corrected = `Column${n + 1}`;
    if (detectionLog[field]) detectionLog[field].offsetApplied = `Column${n} → ${corrected}`;
    mapping[field] = corrected;
  };
  applyOffset('roomNights');

  return { mapping, detectionLog };
}

// OLD FORMAT: date combined in one cell like "ma, 01-09-2025"
function isDateRowOld(cellValue) {
  if (!cellValue || !isString(cellValue)) return false;
  return DATE_PATTERN.test(cellValue.trim());
}

// NEW FORMAT: check if row has weekday in one column and date in another
function isDateRowNew(row) {
  // Look for weekday pattern in __EMPTY_4 and date pattern in __EMPTY_5
  const weekdayCell = row['__EMPTY_4'];
  const dateCell = row['__EMPTY_5'];

  if (!weekdayCell || !dateCell) return false;
  if (!isString(weekdayCell) || !isString(dateCell)) return false;

  return WEEKDAY_ONLY_PATTERN.test(weekdayCell.trim()) && DATE_ONLY_PATTERN.test(dateCell.trim());
}

// CLOUDMERSIVE FORMAT: check if row has weekday in Column4 and date in Column5
function isDateRowCloudmersive(row) {
  const weekdayCell = row['Column4'];
  const dateCell = row['Column5'];

  if (!weekdayCell || !dateCell) return false;
  if (!isString(weekdayCell) || !isString(dateCell)) return false;

  return WEEKDAY_ONLY_PATTERN.test(weekdayCell.trim()) && DATE_ONLY_PATTERN.test(dateCell.trim());
}

// Check if row is a date row (either format)
function isDateRow(row, format, dateColumnKey) {
  if (format === 'new') {
    return isDateRowNew(row);
  } else if (format === 'cloudmersive') {
    return isDateRowCloudmersive(row);
  } else {
    const cellValue = row[dateColumnKey];
    return isDateRowOld(cellValue);
  }
}

function extractWeekday(datumStr) {
  if (!datumStr || !isString(datumStr)) return 'Unknown';
  const head = datumStr.split(',')[0].trim().toLowerCase(); // supports "ma, ..." and "ma  ..." and "ma,"
  const abbr = head.split(/\s+/)[0];
  return WEEKDAY_MAP[abbr] || 'Unknown';
}

function parseDateToISO(datumStr) {
  if (!datumStr || !isString(datumStr)) return null;
  const m = datumStr.match(/\b(\d{2})-(\d{2})-(\d{4})\b/);
  if (!m) return null;
  const [_, dd, MM, yyyy] = m;
  // Require 4-digit year within plausible range — never match 2-digit years or garbage
  const year = parseInt(yyyy, 10);
  if (year < 2000 || year > 2100) return null;
  return `${yyyy}-${MM}-${dd}`;
}

// Check if row is a page break / metadata row (NEW FORMAT)
function isPageBreakRow(row) {
  const keys = Object.keys(row);
  // Page break rows have patterns like "User:", "Print date:", "Page"
  for (const key of keys) {
    const val = row[key];
    if (isString(val)) {
      const lower = val.toLowerCase();
      if (lower.includes('user:') || lower.includes('print date') || lower.match(/page\s+\d+/i)) {
        return true;
      }
    }
  }
  return false;
}

// Check if row is a repeated header/title row mid-document (NEW FORMAT)
function isRepeatedHeaderRow(row) {
  const values = Object.values(row).filter(v => isString(v) && v.trim());
  // Repeated header rows typically have "Hotelstatus" or hotel name only
  if (values.length <= 2) {
    const joined = values.join(' ').toLowerCase();
    if (joined.includes('hotelstatus') || joined.includes('hotel de hoeve')) {
      return true;
    }
  }
  return false;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value
      .replace(/\s|\u00A0/g, '')
      .replace(/[€$]/g, '')
      .replace(/%/g, '')
      .replace(/,/g, '.') // treat comma as decimal
      .replace(/[^\d.\-]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Fix 1.1 + 1.2 — Nederlandse getalnotatie voor revenue-velden.
 * Punt = duizendscheidingsteken, komma = decimaalteken.
 *
 * String-input (ideaal geval):
 *   "2.797,78"  → 2797.78
 *   "283,08"    → 283.08
 *   "-390,19"   → -390.19
 *   "-2.089,19" → -2089.19
 *
 * Number-input (n8n pre-parst CSV-waarden vóór de Code node ze ziet):
 *   n8n strippt de komma uit de bronstring, waardoor twee patronen ontstaan:
 *
 *   Patroon A — bronwaarde had een punt (duizendteken):
 *     "2.131,61" → komma weggegooid → "2.13161" → getal 2.13161 (≥3 decimalen)
 *     Fix: × 1000 → 2131.61
 *
 *   Patroon B — bronwaarde had geen punt (bedrag < €1.000):
 *     "310,30" → komma weggegooid → "31030" → geheel getal 31030
 *     Fix: ÷ 100 → 310.30
 *
 *   Uitzondering: ronde bedragen zoals "5.000,00" → "5.00000" → 5.0 (1 decimaal)
 *   zijn niet betrouwbaar te herstellen; worden teruggegeven als-is en
 *   veroorzaken een Revenue-som mismatch waarschuwing.
 */
function parseNLNumber(value) {
  if (value === null || value === undefined || value === '') return null;

  // --- String-input: directe NL-notatie parsing ---
  if (typeof value === 'string') {
    const s = value.replace(/\s|\u00A0/g, '').replace(/[€$%]/g, '').trim();
    if (s === '') return null;
    const negative = s.startsWith('-');
    const abs = negative ? s.slice(1) : s;
    // Verwijder punten (duizendteken), vervang komma door punt (decimaalteken)
    const normalized = abs.replace(/\./g, '').replace(',', '.');
    const result = parseFloat(normalized);
    if (isNaN(result)) return null;
    return negative ? -result : result;
  }

  if (typeof value !== 'number' || !isFinite(value)) return null;

  // --- Number-input: herstel n8n pre-parsing ---
  const absVal = Math.abs(value);
  const sign = value < 0 ? -1 : 1;
  const str = absVal.toString();
  const decimalPlaces = str.includes('.') ? str.split('.')[1].length : 0;

  if (decimalPlaces >= 3) {
    // Patroon A: "X.XXX,YY" → komma weggegooid → X.XXXYY (≥3 decimalen)
    // Fix: × 1000, afgerond op 2 decimalen
    return sign * (Math.round(absVal * 100000) / 100);
  }

  if (decimalPlaces === 0 && absVal > 0) {
    // Patroon B: "XXX,YY" → komma weggegooid → XXXYY (geheel getal)
    // Fix: ÷ 100
    return sign * (Math.round(absVal) / 100);
  }

  // 1-2 decimalen: waarschijnlijk al correct of ronde bedragen (niet herstelbaar)
  return value;
}

/**
 * US/English number format for Cloudmersive output.
 * Comma = thousands separator, period = decimal.
 *
 * "5,696.67"  → 5696.67
 * "544.69"    → 544.69
 * "10,292.41" → 10292.41
 * "-1,234.56" → -1234.56
 */
function parseUSNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.replace(/\s|\u00A0/g, '').replace(/[€$%]/g, '').trim();
    if (s === '') return null;
    const negative = s.startsWith('-');
    const abs = negative ? s.slice(1) : s;
    // Remove commas (thousands separator), period is decimal
    const normalized = abs.replace(/,/g, '');
    const result = parseFloat(normalized);
    if (isNaN(result)) return null;
    return negative ? -result : result;
  }
  return null;
}

// -------------------- Hotel Name Extraction --------------------

/**
 * Extracts hotel name from first 3 rows by searching in both keys and values
 * Uses contains logic (case-insensitive) to find hotel name
 * Returns the clean hotel name from HOTEL_NAMES array or "error" if not found
 */
function extractHotelName(rows) {
  const searchRows = rows.slice(0, Math.min(3, rows.length));

  // Loop through each hotel name in the array
  for (const hotelName of HOTEL_NAMES) {
    const normalizedHotelName = hotelName.toLowerCase();

    // Search in all rows
    for (const row of searchRows) {
      // Search in column keys (property names)
      for (const key of Object.keys(row)) {
        if (!isString(key)) continue;
        const normalizedKey = key.trim().toLowerCase();

        if (normalizedKey.includes(normalizedHotelName)) {
          return hotelName; // return clean name from array
        }
      }

      // Search in values
      for (const value of Object.values(row)) {
        if (!isString(value)) continue;
        const normalizedValue = value.trim().toLowerCase();

        if (normalizedValue.includes(normalizedHotelName)) {
          return hotelName; // return clean name from array
        }
      }
    }
  }

  return 'error'; // no match found
}

// -------------------- Header Detection (improved) --------------------

// Normalize header labels: lowercase, trim, collapse spaces, remove punctuation & NBSP
function normalizeHeaderLabel(val) {
  if (!isString(val)) return '';
  return val
    .replace(/\u00A0/g, ' ')           // NBSP -> space
    .toLowerCase()
    .trim()
    .replace(/[.,:;]+/g, '')           // strip common punctuation
    .replace(/\s+/g, ' ');             // collapse spaces
}

/**
 * Improved header detection (supports both OLD and NEW formats):
 *
 * OLD FORMAT: row["Periode:"] == "Datum" with "bezet", "accom", "totaal" in values
 * NEW FORMAT: row["__EMPTY_3"] == "Datum" with "bezet", "accom", "totaal" in values
 *
 * Fallback to heuristic scoring if strict check fails.
 */
// Provide fallback mapping using confirmed data column positions from actual dagstaat.
// Note: label columns (Column14, Column59, Column61) are offset-corrected by
// buildColumnMapping, so fallbacks point directly to the data columns.
function withFallback(mapping) {
  const m = { ...mapping };
  const fallbacksUsed = [];

  const applyFallback = (field, column, label) => {
    if (!m[field]) {
      m[field] = column;
      fallbacksUsed.push({ field, column, label });
    }
  };

  applyFallback('date',         'Column3',  'Datum');
  applyFallback('roomNights',   'Column15', 'Bezet');
  applyFallback('roomRevenue',  'Column53', 'Accom.');
  applyFallback('fbRevenue',    'Column56', 'F&B');
  applyFallback('otherRevenue', 'Column59', 'extras');
  applyFallback('totalRevenue', 'Column61', 'Totaal');

  return { mapping: m, fallbacksUsed };
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

function processRowObject(rowObj, mapping) {
  // Skip page break and repeated header rows (Cloudmersive format)
  if (isPageBreakRow(rowObj)) return { kind: 'skip' };
  if (isRepeatedHeaderRow(rowObj)) return { kind: 'skip' };

  // Handle date extraction
  let rawDateCell, weekdayStr, dateStr;

  if (mapping.splitDate) {
    // NEW FORMAT: date split across two columns
    weekdayStr = rowObj[mapping.weekdayCol];
    dateStr = rowObj[mapping.dateCol];

    if (!weekdayStr && !dateStr) return { kind: 'skip' };

    // Check if this is a valid data row
    if (!isString(weekdayStr) || !isString(dateStr)) return { kind: 'skip' };

    weekdayStr = weekdayStr.trim();
    dateStr = dateStr.trim();

    // Skip non-data markers
    const NON_DATA_MARKERS = new Set([
      'datum', 'summary', 'type', 'revenue', 'ooo rooms', 'pseudorooms',
      'state', 'soort tarief', 'totaal', 'systeemdatum:', 'kamers', 'bedden',
      'aankomsten', 'vertrekkers', 'inhuis', 'januari', 'februari', 'maart',
      'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober',
      'november', 'december', 'hotelstatus'
    ]);

    const normalizedWeekday = normalizeHeaderLabel(weekdayStr);
    const normalizedDate = normalizeHeaderLabel(dateStr);
    if (NON_DATA_MARKERS.has(normalizedWeekday) || NON_DATA_MARKERS.has(normalizedDate)) {
      return { kind: 'skip' };
    }

    // Check for valid weekday + date pattern
    if (!WEEKDAY_ONLY_PATTERN.test(weekdayStr) || !DATE_ONLY_PATTERN.test(dateStr)) {
      // If it has a date-like pattern but invalid, it's an error
      if (/\d{2}-\d{2}-\d{4}/.test(dateStr)) {
        return {
          kind: 'error',
          error: `Invalid date pattern in new format: weekday="${weekdayStr}", date="${dateStr}"`,
        };
      }
      return { kind: 'skip' };
    }

    // Combine for compatibility with existing parsing
    rawDateCell = `${weekdayStr} ${dateStr}`;
  }

  const isoDate = parseDateToISO(rawDateCell);
  if (!isoDate) {
    return {
      kind: 'error',
      error: `Failed to parse date from "${rawDateCell}" (expected DD-MM-YYYY)`,
    };
  }

  const englishWeekday = extractWeekday(rawDateCell);

  // Parse numeric fields
  // RoomNights = integer, geen valuta-notatie → toNumber volstaat
  const rn = toNumber(rowObj[mapping.roomNights]);
  // Revenue-velden: Fix 1.1 — Nederlandse getalnotatie (parseNLNumber)
  // Cloudmersive format: US notation (comma=thousands, period=decimal) → parseUSNumber
  const parseRevenue = mapping.numberFormat === 'us' ? parseUSNumber : parseNLNumber;
  const accom = parseRevenue(rowObj[mapping.roomRevenue]);
  const fb    = parseRevenue(rowObj[mapping.fbRevenue]);
  const other = parseRevenue(rowObj[mapping.otherRevenue]);
  const total = parseRevenue(rowObj[mapping.totalRevenue]);

  const out = {
    Date: isoDate,
    Weekday: englishWeekday,
    RoomNights: rn,
    RoomRevenue: accom,
    FB_Revenue: fb,
    OtherRevenue: other,
    TotalRevenue: total,
  };

  // Validation warnings
  const warnings = [];

  // Check: TotalRevenue < RoomRevenue (legacy check)
  if (total != null && accom != null && total < accom) {
    warnings.push(`Mismatch: TotalRevenue (${total}) < RoomRevenue (${accom})`);
  }

  // Check A — Revenue-som per rij (tolerantie €0,02 — €0,01 is floating-point afrondingsartefact)
  if (accom != null && fb != null && other != null && total != null) {
    const calculatedSum = accom + fb + other;
    const tolerance = 0.02;
    const difference = Math.abs(calculatedSum - total);
    if (difference > tolerance) {
      warnings.push(`Revenue-som mismatch: ${accom.toFixed(2)} + ${fb.toFixed(2)} + ${other.toFixed(2)} = ${calculatedSum.toFixed(2)}, maar TotalRevenue = ${total.toFixed(2)} (verschil: ${difference.toFixed(2)})`);
    }
  }

  // Check E — Negatieve revenue-waarden (waarschuwing, inhoudelijk valid)
  if (accom != null && accom < 0) warnings.push(`Negatieve RoomRevenue: ${accom}`);
  if (fb != null && fb < 0)       warnings.push(`Negatieve FB_Revenue: ${fb}`);
  if (other != null && other < 0) warnings.push(`Negatieve OtherRevenue: ${other}`);
  if (total != null && total < 0) warnings.push(`Negatieve TotalRevenue: ${total}`);

  if (warnings.length) out._warnings = warnings;

  return { kind: 'ok', value: out };
}

// -------------------- Main Processing --------------------

const items = $input.all();
const allResults = [];
let totalRows = 0;
let headerRowsSkipped = 0;
let nonDataRowsSkipped = 0;
let successfullyProcessed = 0;
let failedValidation = 0;

const failedRows = [];
let hotelNameExtracted = null;
let isFirstDataRow = true;

// Pre-scan: collect the first 10 rows across all items before any processing.
// Works whether n8n feeds the whole file as one item (Array) or one row per item.
// Header labels are typically at row index 7-9 in the Cloudmersive dagstaat export.
const preScanRows = [];
for (const item of items) {
  const d = item.json;
  const itemRows = Array.isArray(d) ? d : (d ? [d] : []);
  for (const row of itemRows) {
    preScanRows.push(row);
    if (preScanRows.length >= 10) break;
  }
  if (preScanRows.length >= 10) break;
}

if (preScanRows.length === 0) {
  return [{ json: { success: false, message: 'No occupancy data found. Please provide an array of row objects.' } }];
}

hotelNameExtracted = extractHotelName(preScanRows);

// Column mapping built once from the pre-scan window — not repeated per item.
const { mapping: rawMapping, detectionLog } = buildColumnMapping(preScanRows);
const { mapping, fallbacksUsed } = withFallback(rawMapping);
const usedFallbackAny = fallbacksUsed.length > 0;

const REQUIRED_FIELDS = ['date', 'roomNights', 'roomRevenue', 'fbRevenue', 'otherRevenue', 'totalRevenue'];
const columnStatus = REQUIRED_FIELDS.map(field => {
  const log = detectionLog[field];
  const fb  = fallbacksUsed.find(f => f.field === field);
  if (log && !fb) {
    return { field, status: 'ok', method: 'scan', column: mapping[field],
             row: log.row, offsetApplied: log.offsetApplied || null };
  } else if (fb) {
    return { field, status: 'fallback', column: fb.column,
             warning: `"${field}" not found in header scan. Using fallback column ${fb.column} (${fb.label}).` };
  } else {
    return { field, status: 'missing', column: null,
             error: `"${field}" not found in header scan and no fallback available. This field will be null.` };
  }
});

const columnDetectionLog = [{ detectionLog, fallbacksUsed, columnStatus }];
const aggMissing = columnStatus.filter(s => s.status === 'missing').map(s => s.field);

for (const item of items) {
  let rows;
  const inputData = item.json;
  if (Array.isArray(inputData)) rows = inputData;
  else if (inputData && typeof inputData === 'object') rows = [inputData];
  else rows = [];

  totalRows += rows.length;

  // Fix 2.1: Itereer ALLE rijen vanaf 0 — geen vaste offset meer.
  // processRowObject() herkent datarijen op inhoud en slaat de rest over.
  for (let i = 0; i < rows.length; i++) {
    const rowObj = rows[i];
    const res = processRowObject(rowObj, mapping);

    if (res.kind === 'ok') {
      // Add hotelName to first data row only
      if (isFirstDataRow) {
        res.value.hotelName = hotelNameExtracted;
        isFirstDataRow = false;
      }

      allResults.push({ json: res.value });
      successfullyProcessed += 1;
    } else if (res.kind === 'error') {
      failedValidation += 1;
      failedRows.push({
        error: true,
        row_index: i,
        validation_errors: [res.error],
        raw_data: rowObj,
      });
    } else {
      nonDataRowsSkipped += 1; // kind === 'skip'
    }
  }
}

// If everything failed (no successes) and we had row-level errors -> Critical style
if (successfullyProcessed === 0 && failedValidation > 0) {
  return [
    {
      json: {
        success: false,
        message: `Failed to process any valid rows. ${failedValidation} rows failed validation.\nPlease check the error details in the output.`,
      },
    },
  ];
}

// Fix 2.3 — Deduplicatie op datum vóór output
const seenDates = new Set();
const duplicateDates = [];
const uniqueResults = allResults.filter(item => {
  const d = item.json.Date;
  if (!d) return true; // niet-data items (worden later overschreven)
  if (seenDates.has(d)) {
    duplicateDates.push(d);
    return false;
  }
  seenDates.add(d);
  return true;
});
// Vervang allResults met gededupliceerde versie
allResults.length = 0;
for (const item of uniqueResults) allResults.push(item);
successfullyProcessed = allResults.length;

// Check B — Datumcontinuïteit
const dateSorted = allResults
  .map(r => r.json.Date)
  .filter(Boolean)
  .sort();
const missingDates = [];
for (let i = 1; i < dateSorted.length; i++) {
  const prev = new Date(dateSorted[i - 1]);
  const curr = new Date(dateSorted[i]);
  const diffDays = Math.round((curr - prev) / 86400000);
  for (let d = 1; d < diffDays; d++) {
    const m = new Date(prev);
    m.setDate(m.getDate() + d);
    missingDates.push(m.toISOString().split('T')[0]);
  }
}

// Check D — Bestandsnaam vs. inhoud
let filenameWarning = null;
const filename = items[0]?.json?.filename || items[0]?.json?.fileName || null;
if (filename && dateSorted.length > 0) {
  const matches = filename.match(/(\d{1,2}-\d{1,2}-\d{4})/g);
  if (matches && matches.length >= 2) {
    const parseDMY = s => { const [d, m, y] = s.split('-'); return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; };
    const expectedStart = parseDMY(matches[0]);
    const expectedEnd   = parseDMY(matches[1]);
    if (dateSorted[0] !== expectedStart || dateSorted[dateSorted.length - 1] !== expectedEnd) {
      filenameWarning = `"${filename}" bevat data van ${dateSorted[0]} t/m ${dateSorted[dateSorted.length - 1]}, verwacht ${expectedStart} t/m ${expectedEnd}`;
    }
  }
}

// Revenue-mismatch count (Check A) en negatieve waarden (Check E)
const revenueMismatchCount = allResults.filter(r => r.json._warnings && r.json._warnings.some(w => w.includes('Revenue-som mismatch'))).length;
const negativeValueCount   = allResults.filter(r => r.json._warnings && r.json._warnings.some(w => w.includes('Negatieve'))).length;

// Column status computed once in pre-scan phase above
const columnWarnings    = columnStatus.filter(s => s.status === 'fallback').map(s => s.warning);
const columnErrors      = columnStatus.filter(s => s.status === 'missing').map(s => s.error);
const columnStatusFinal = columnStatus;

// Push summary (ONLY requested observability fields)
allResults.push({
  json: {
    _summary: true,
    detected_format: 'cloudmersive',
    hotel_name: hotelNameExtracted,
    header_rows_skipped: headerRowsSkipped,
    non_data_rows_skipped: nonDataRowsSkipped,
    missing_columns: aggMissing,
    column_status: columnStatusFinal,
    column_warnings: columnWarnings,
    column_errors: columnErrors,
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

// Push errors item if any
if (failedRows.length > 0) {
  allResults.push({
    json: {
      _errors: true,
      failed_rows: failedRows,
    },
  });
}

return allResults;
