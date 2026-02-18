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

// Detect format type based on column keys
function detectFormat(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const keys = Object.keys(rows[i] || {});
    if (keys.some(k => k.startsWith('__EMPTY_'))) return 'new';
    if (keys.some(k => k === 'Periode:' || k.match(/^_\d+$/))) return 'old';
  }
  return 'unknown';
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

// Check if row is a date row (either format)
function isDateRow(row, format, dateColumnKey) {
  if (format === 'new') {
    return isDateRowNew(row);
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
function findHeaderRow(rows, format) {
  // Strategy 1: strict anchored detection
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const row = rows[i] || {};

    // Check for "Datum" in the appropriate column based on format
    let normDatum = '';
    if (format === 'new') {
      // NEW FORMAT: check __EMPTY_3 for "Datum"
      normDatum = normalizeHeaderLabel(row['__EMPTY_3']);
    } else {
      // OLD FORMAT: check "Periode:" for "Datum"
      normDatum = normalizeHeaderLabel(row['Periode:']);
    }

    if (normDatum === 'datum') {
      const values = Object.values(row).map(normalizeHeaderLabel);
      let scoreTokens = 0;
      if (values.some(v => v === 'bezet')) scoreTokens++;
      if (values.some(v => v === 'totaal')) scoreTokens++;
      if (values.some(v => v === 'accom' || v.startsWith('accom'))) scoreTokens++;
      if (scoreTokens >= 2) {
        return { row, index: i, format };
      }
    }
  }

  // Strategy 2: heuristic (legacy) if the anchored search fails
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    const entries = Object.entries(row);
    let score = 0;
    for (const [, v] of entries) {
      const s = normalizeHeaderLabel(v);
      if (!s) continue;
      if (s.includes('datum')) score += 2;
      if (s.includes('bezet')) score += 2;
      if (s.includes('accom')) score += 2;
      if (s.includes('totaal')) score += 2;
    }
    if (score >= 4) { // at least two signals
      best = { row, index: i, format };
      break;
    }
  }
  return best;
}

function createColumnMapping(headerRow, format) {
  const mapping = { format };

  for (const [key, value] of Object.entries(headerRow)) {
    const s = normalizeHeaderLabel(value);
    if (!s) continue;

    // Prefer exact tokens
    if (s === 'datum') {
      mapping.date = key;
      continue;
    }
    if (s === 'bezet') {
      mapping.roomNights = key;
      continue;
    }
    if (s === 'totaal') {
      mapping.totalRevenue = key;
      continue;
    }
    // Accept common variant for accom
    if (s === 'accom' || s.startsWith('accom')) {
      mapping.roomRevenue = key;
      continue;
    }
    // F&B Revenue detection
    if (s === 'f&b' || s === 'fb' || s === 'f & b') {
      mapping.fbRevenue = key;
      continue;
    }
    // Other/Extras Revenue detection
    if (s === 'extras' || s === 'other' || s === 'overig') {
      mapping.otherRevenue = key;
      continue;
    }
  }

  // NEW FORMAT: mark that date is split across two columns
  if (format === 'new') {
    mapping.splitDate = true;
    mapping.weekdayCol = '__EMPTY_4';
    mapping.dateCol = '__EMPTY_5';

    // NEW FORMAT FIX: Header columns for some fields are offset from data columns
    // "Bezet" header is at __EMPTY_14 but data is at __EMPTY_15
    // Apply +1 offset for roomNights if detected from header
    if (mapping.roomNights && mapping.roomNights.startsWith('__EMPTY_')) {
      const colNum = parseInt(mapping.roomNights.replace('__EMPTY_', ''), 10);
      if (!isNaN(colNum) && colNum === 14) {
        mapping.roomNights = '__EMPTY_15';
      }
    }
  }

  return mapping;
}

// Provide fallback mapping if headers missing
function withFallback(mapping, format) {
  const m = { ...mapping };

  if (format === 'new') {
    // NEW FORMAT fallback columns (observed in new sample)
    if (!m.date) m.date = '__EMPTY_3';
    if (!m.roomNights) m.roomNights = '__EMPTY_15';  // "Bezet" value column (note: may be string)
    if (!m.roomRevenue) m.roomRevenue = '__EMPTY_54';
    if (!m.fbRevenue) m.fbRevenue = '__EMPTY_57';
    if (!m.otherRevenue) m.otherRevenue = '__EMPTY_61';
    if (!m.totalRevenue) m.totalRevenue = '__EMPTY_63';
    m.splitDate = true;
    m.weekdayCol = '__EMPTY_4';
    m.dateCol = '__EMPTY_5';
  } else {
    // OLD FORMAT fallback columns
    if (!m.date) m.date = 'Periode:';       // dataset uses this as the date column key
    if (!m.roomNights) m.roomNights = '_4'; // observed in sample
    if (!m.roomRevenue) m.roomRevenue = '_34';
    if (!m.fbRevenue) m.fbRevenue = '_35';           // F&B column
    if (!m.otherRevenue) m.otherRevenue = '_38';     // Extras/Other column
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

function processRowObject(rowObj, mapping, format) {
  // NEW FORMAT: Skip page break and repeated header rows
  if (format === 'new') {
    if (isPageBreakRow(rowObj)) return { kind: 'skip' };
    if (isRepeatedHeaderRow(rowObj)) return { kind: 'skip' };
  }

  // Handle date extraction based on format
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
  } else {
    // OLD FORMAT: date in single column
    rawDateCell = rowObj[mapping.date];
    if (!rawDateCell || !isString(rawDateCell)) return { kind: 'skip' };
    rawDateCell = rawDateCell.trim();

    // Common non-data lines to skip (do not treat as errors)
    const NON_DATA_MARKERS = new Set([
      'summary', 'type', 'revenue', 'ooo rooms', 'pseudorooms',
      'state', 'soort tarief', 'totaal', 'systeemdatum:'
    ]);
    if (NON_DATA_MARKERS.has(normalizeHeaderLabel(rawDateCell))) return { kind: 'skip' };

    // Must be a date row
    if (!isDateRowOld(rawDateCell)) {
      // Heuristic: contains dd-mm-yyyy somewhere but weekday missing/malformed -> error
      const hasDate = /\b\d{2}-\d{2}-\d{4}\b/.test(rawDateCell);
      if (hasDate) {
        return {
          kind: 'error',
          error: `Invalid date pattern: "${rawDateCell}" (expected "ma|di|wo|do|vr|za|zo, DD-MM-YYYY")`,
        };
      }
      return { kind: 'skip' };
    }
  }

  const isoDate = parseDateToISO(rawDateCell);
  if (!isoDate) {
    return {
      kind: 'error',
      error: `Failed to parse date from "${rawDateCell}" (expected DD-MM-YYYY)`,
    };
  }

  const englishWeekday = extractWeekday(rawDateCell);

  // Parse numeric fields (warnings kept minimal; non-numeric => null)
  // Note: NEW FORMAT may have string numbers like "33" - toNumber handles this
  const rn = toNumber(rowObj[mapping.roomNights]);
  const accom = toNumber(rowObj[mapping.roomRevenue]);
  const fb = toNumber(rowObj[mapping.fbRevenue]);
  const other = toNumber(rowObj[mapping.otherRevenue]);
  const total = toNumber(rowObj[mapping.totalRevenue]);

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

  // Check: Sum validation (RoomRevenue + FB_Revenue + OtherRevenue should equal TotalRevenue)
  if (accom != null && fb != null && other != null && total != null) {
    const calculatedSum = accom + fb + other;
    const tolerance = 0.01; // Allow 1 cent tolerance for floating point
    const difference = Math.abs(calculatedSum - total);
    if (difference > tolerance) {
      warnings.push(`Revenue sum mismatch: RoomRevenue (${accom.toFixed(2)}) + FB_Revenue (${fb.toFixed(2)}) + OtherRevenue (${other.toFixed(2)}) = ${calculatedSum.toFixed(2)}, but TotalRevenue = ${total.toFixed(2)} (diff: ${difference.toFixed(2)})`);
    }
  }

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

const failedRows = []; // collected row-level errors
let usedFallbackAny = false;
const aggMissing = [];
let hotelNameExtracted = null; // track extracted hotel name
let isFirstDataRow = true; // flag to add hotelName to first data row only

// Track column detection results for testing/debugging
let columnDetectionLog = [];
let detectedFormat = 'unknown';

for (const item of items) {
  let rows;
  const inputData = item.json;
  if (Array.isArray(inputData)) rows = inputData;
  else if (inputData && typeof inputData === 'object') rows = [inputData];
  else rows = [];

  totalRows += rows.length;

  // Detect format (OLD vs NEW)
  if (detectedFormat === 'unknown' && rows.length > 0) {
    detectedFormat = detectFormat(rows);
  }

  // Extract hotel name from first rows (only once)
  if (hotelNameExtracted === null && rows.length > 0) {
    hotelNameExtracted = extractHotelName(rows);
  }

  // Header detection (improved) - pass format
  const headerInfo = findHeaderRow(rows, detectedFormat);
  let mapping = {};
  let usedFallback = false;

  if (headerInfo) {
    mapping = createColumnMapping(headerInfo.row, detectedFormat);
    headerRowsSkipped += (headerInfo.index + 1); // start after header

    // Log detected columns for debugging
    columnDetectionLog.push({
      format: detectedFormat,
      headerRowIndex: headerInfo.index,
      detectedMappings: { ...mapping },
      headerRowValues: Object.entries(headerInfo.row)
        .filter(([k, v]) => v && isString(v) && v.trim())
        .map(([k, v]) => ({ key: k, value: v }))
    });
  }

  // If some are missing, apply fallback
  const preFallbackMissing = computeMissingColumns(mapping);
  if (preFallbackMissing.length) {
    mapping = withFallback(mapping, detectedFormat);
    usedFallback = true;
  }

  const missingColumnsAfter = computeMissingColumns(mapping);
  for (const k of missingColumnsAfter) if (!aggMissing.includes(k)) aggMissing.push(k);
  if (usedFallback) usedFallbackAny = true;

  // Critical error: no data or still no date column
  if (rows.length === 0) {
    return [
      {
        json: {
          success: false,
          message: 'No occupancy data found. Please provide an array of row objects.',
        },
      },
    ];
  }
  if (missingColumnsAfter.includes('date') && !mapping.splitDate) {
    return [
      {
        json: {
          success: false,
          message:
            'CRITICAL ERROR: Cannot process data - missing required columns.\n' +
            'Required column: Datum (date column with weekday + DD-MM-YYYY).',
        },
      },
    ];
  }

  // Start processing after header row if present
  const startIndex = headerInfo ? headerInfo.index + 1 : 0;

  for (let i = startIndex; i < rows.length; i++) {
    const rowObj = rows[i];
    const res = processRowObject(rowObj, mapping, detectedFormat);

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

// Generate warnings for missing columns (F&B and OtherRevenue)
const columnWarnings = [];
if (aggMissing.includes('fbRevenue')) {
  columnWarnings.push('WARNING: F&B Revenue column not detected. Using fallback column _35 or null values.');
}
if (aggMissing.includes('otherRevenue')) {
  columnWarnings.push('WARNING: Other/Extras Revenue column not detected. Using fallback column _38 or null values.');
}

// Push summary (ONLY requested observability fields)
allResults.push({
  json: {
    _summary: true,
    detected_format: detectedFormat,      // 'old' or 'new'
    hotel_name: hotelNameExtracted,
    header_rows_skipped: headerRowsSkipped,
    non_data_rows_skipped: nonDataRowsSkipped,
    missing_columns: aggMissing,          // after fallback
    missing_column_warnings: columnWarnings,
    used_fallback: usedFallbackAny,       // should be false for your sample now
    successfully_processed: successfullyProcessed,
    failed_validation: failedValidation,
    errors_count: failedValidation > 0 ? 1 : 0,
    column_detection_log: columnDetectionLog,  // For testing column detection
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
