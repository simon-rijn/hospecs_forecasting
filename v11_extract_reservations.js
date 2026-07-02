// Extract Reservations v0.12 — 2026-05-18
// Reservation Data Processing Script for n8n (Smart Column Detection)
// Processes Dutch hotel reservation data and converts to clean JSON
// Automatically detects column positions based on header names
//
// V9 UPDATES:
// - Added reservation_id extraction from "Res. #" column
// - Added hotelName extraction from first 3 rows (same logic as housestate)
//
// V11 UPDATES:
// - Added status field extraction from "Res. status" column
// - Added deduplication by reservation_id (keep most recent created_at per id)
// - Added 'aanmaak' (lowercase) as fallback for createdAt header detection
//
// V11.1 UPDATES:
// - Hotel name no longer hardcoded — read dynamically from client metadata input
//   (item with Hotel_Name field, merged by N8N before this node runs)

// Hotel name is supplied at runtime via the client metadata item in the input.
// Falls back to 'de Hoeve van Nunspeet' when no metadata is present (legacy behaviour).
const metaItem   = $input.all().find(item => item.json?.Hotel_Name);
const HOTEL_NAMES = metaItem?.json?.Hotel_Name
  ? [metaItem.json.Hotel_Name]
  : ['de Hoeve van Nunspeet'];

// Dutch to English weekday mapping
const WEEKDAY_MAP = {
  'ma': 'Monday',
  'di': 'Tuesday',
  'wo': 'Wednesday',
  'do': 'Thursday',
  'vr': 'Friday',
  'za': 'Saturday',
  'zo': 'Sunday'
};

// -------------------- Hotel Name Extraction --------------------

/**
 * Helper: Check if value is a non-empty string
 */
function isString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Extracts hotel name from first 3 rows by searching in both keys and values
 * Uses contains logic (case-insensitive) to find hotel name
 * Returns the clean hotel name from HOTEL_NAMES array or null if not found
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

  return null; // Hotel name not found
}

// -------------------- Column Detection --------------------

/**
 * Detect column mappings from header row
 * @param {array} rows - Array of row objects from Excel
 * @returns {object} - Mapping of field names to column keys, plus metadata
 */
function detectColumnMapping(rows) {
  // Header keywords to look for (Dutch)
  // V9 UPDATE: Added reservationId for "Res. #" column
  const headerPatterns = {
    reservationId: ['Res. #', 'Res.#', 'Res #', 'Reserveringsnummer', 'Reserverings nr'],
    createdAt: ['Aanmaak', 'aanmaak'],
    arrival: ['Aankomst'],
    departure: ['Vertrek'],
    nights: ['Nachten'],
    rateCode: ['Prijscode'],
    channel: ['Kanaal'],
    status: ['Res. status', 'Status'],
    cancelledAt: ['Geannuleerd op', 'Geannuleerd'],
    averagePrice: ['Gem. prijs'],
    groupName: ['Groepsnaam', 'groepsnaam', 'Groeps naam', 'Group name', 'Groep'],
    // V0.12: full header coverage — all remaining columns from the current export
    guests:            ['Gast(en)', 'Gasten', 'Guest(s)', 'Guests'],
    room:              ['Kamer'],
    roomType:          ['Type'],
    persons:           ['Personen'],
    country:           ['Land'],
    commercialChannel: ['Comm. kanaal'],
    visitReason:       ['Bezoek reden'],
    marketCode:        ['Marktcode'],
    cancelledBy:       ['Geannuleerd door']
  };

  const mapping = {
    columns: {},
    missingColumns: [],
    usedFallback: false,
    detectionMethod: 'header'
  };

  // Search through first 10 rows to find the header row
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];

    // Check each column in this row
    for (const [key, value] of Object.entries(row)) {
      if (!value || typeof value !== 'string') continue;

      const cellValue = value.trim();

      // Check against each header pattern
      for (const [fieldName, patterns] of Object.entries(headerPatterns)) {
        for (const pattern of patterns) {
          if (cellValue === pattern) {
            mapping.columns[fieldName] = key;
            break;
          }
        }
      }
    }

    // If we found the required columns, we've found the header
    if (mapping.columns.arrival && mapping.columns.departure && mapping.columns.createdAt) {
      // Check for missing optional columns
      for (const fieldName of Object.keys(headerPatterns)) {
        if (!mapping.columns[fieldName]) {
          mapping.missingColumns.push(fieldName);
        }
      }
      return mapping;
    }
  }

  // Fallback to known column positions for the Protel PMS export format
  // Column positions verified against actual export (see JSON example in repo)
  console.log('Warning: Could not detect header row, using default column positions');
  mapping.usedFallback = true;
  mapping.detectionMethod = 'fallback';
  mapping.columns = {
    reservationId: '_12',
    createdAt:     '_15',
    arrival:       '_2',
    departure:     '_3',
    nights:        '_6',
    status:        '_11',
    averagePrice:  '_16',
    channel:       '_18',
    groupName:     '_19',
    rateCode:      '_20',
    cancelledAt:   '_26',
    guests:            '_1',
    room:              '_7',
    roomType:          '_8',
    persons:           '_10',
    country:           '_14',
    commercialChannel: '_23',
    visitReason:       '_24',
    marketCode:        '_25',
    cancelledBy:       '_27'
  };

  return mapping;
}

/**
 * Parse Dutch date format "DD-MM-YY" or "DD-MM-YYYY" and return ISO date "YYYY-MM-DD"
 * @param {string} dateStr - Date string like "07-10-24" or "07-10-2024"
 * @returns {string|null} - ISO formatted date "YYYY-MM-DD" or null
 */
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }

  // Remove any whitespace
  const cleaned = dateStr.trim();

  // Match DD-MM-YY or DD-MM-YYYY format
  const match = cleaned.match(/^(\d{2})-(\d{2})-(\d{2,4})$/);

  if (!match) {
    return null;
  }

  const day = match[1];
  const month = match[2];
  let year = match[3];

  // Convert 2-digit year to 4-digit year
  if (year.length === 2) {
    const yearNum = parseInt(year, 10);
    // Assume 20xx for years 00-50, 19xx for years 51-99
    year = yearNum <= 50 ? `20${year}` : `19${year}`;
  }

  // Return ISO format: YYYY-MM-DD
  return `${year}-${month}-${day}`;
}

/**
 * Parse datetime format "DD-MM-YYYY HH:MM:SS" and return ISO format with time "YYYY-MM-DDTHH:MM:SS"
 * @param {string} datetimeStr - DateTime string like "07-10-2024 07:21:33"
 * @returns {string|null} - ISO formatted datetime "YYYY-MM-DDTHH:MM:SS" or null
 */
function parseDatetime(datetimeStr) {
  if (!datetimeStr || typeof datetimeStr !== 'string') {
    return null;
  }

  // Match DD-MM-YYYY HH:MM:SS format
  const match = datetimeStr.trim().match(/^(\d{2})-(\d{2})-(\d{4})\s(\d{2}):(\d{2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const day = match[1];
  const month = match[2];
  const year = match[3];
  const hours = match[4];
  const minutes = match[5];
  const seconds = match[6];

  // Return ISO format without timezone: YYYY-MM-DDTHH:MM:SS
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * Parse price string and return numeric value
 * @param {string} priceStr - Price string like "82,65€" or "165,30€"
 * @returns {number|null} - Numeric price value or null
 */
function parsePrice(priceStr) {
  if (!priceStr || typeof priceStr !== 'string') {
    return null;
  }

  try {
    // Remove € symbol and whitespace
    const cleaned = priceStr.replace(/€/g, '').trim();

    // Replace comma with period for decimal
    const normalized = cleaned.replace(',', '.');

    // Parse to float
    const price = parseFloat(normalized);

    // Return null if invalid number
    return isNaN(price) ? null : price;
  } catch (error) {
    return null;
  }
}

/**
 * Calculate the weekday from an ISO date string "YYYY-MM-DD"
 * @param {string} dateStr - ISO date string "YYYY-MM-DD"
 * @returns {string} - English weekday name
 */
function getWeekday(dateStr) {
  if (!dateStr) {
    return null;
  }

  try {
    // Parse ISO format YYYY-MM-DD
    const date = new Date(dateStr + 'T00:00:00Z');

    if (isNaN(date.getTime())) {
      return null;
    }

    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return weekdays[date.getUTCDay()];
  } catch (error) {
    return null;
  }
}

/**
 * Calculate number of nights between arrival and departure
 * @param {string} arrivalDate - ISO arrival date "YYYY-MM-DD"
 * @param {string} departureDate - ISO departure date "YYYY-MM-DD"
 * @returns {number|null} - Number of nights
 */
function calculateNights(arrivalDate, departureDate) {
  if (!arrivalDate || !departureDate) {
    return null;
  }

  try {
    // Parse ISO format YYYY-MM-DD
    const arrival = new Date(arrivalDate + 'T00:00:00Z');
    const departure = new Date(departureDate + 'T00:00:00Z');

    if (isNaN(arrival.getTime()) || isNaN(departure.getTime())) {
      return null;
    }

    const diffTime = departure - arrival;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays >= 0 ? diffDays : null;
  } catch (error) {
    return null;
  }
}


/**
 * Normalize rate code to standard format
 * @param {string} rateCode - Raw rate code
 * @returns {string} - Normalized rate code
 */
function normalizeRateCode(rateCode) {
  if (!rateCode || typeof rateCode !== 'string') {
    return 'Unknown';
  }

  return rateCode.trim();
}

/**
 * Extract a raw string value from a mapped column.
 * Returns null when the column is unmapped, the cell is absent, or the value is
 * an empty string. Non-empty placeholders (e.g. '[anonym]') are preserved — the
 * deduplication merge handles those.
 * @param {object} row - Row object from Excel
 * @param {string} columnKey - Detected column key (e.g. '_7'), or undefined
 * @returns {string|null}
 */
function extractStringField(row, columnKey) {
  if (!columnKey) return null;
  const cell = row[columnKey];
  return (cell != null && String(cell) !== '') ? String(cell) : null;
}

/**
 * Check if a row is a valid data row and return validation details
 * @param {object} row - Row object
 * @param {object} mapping - Column mapping
 * @returns {object} - Validation result with isValid flag and reasons
 */
function validateDataRow(row, mapping) {
  const result = {
    isValid: true,
    errors: []
  };

  // A valid data row should have the required date fields
  const createdAt = row[mapping.columns.createdAt];
  const arrival = row[mapping.columns.arrival];
  const departure = row[mapping.columns.departure];

  if (!createdAt) {
    result.isValid = false;
    result.errors.push(`Missing creation date in column ${mapping.columns.createdAt}`);
  }

  if (!arrival) {
    result.isValid = false;
    result.errors.push(`Missing arrival date in column ${mapping.columns.arrival}`);
  }

  if (!departure) {
    result.isValid = false;
    result.errors.push(`Missing departure date in column ${mapping.columns.departure}`);
  }

  if (!result.isValid) {
    return result;
  }

  // Check if createdAt contains datetime pattern (DD-MM-YYYY HH:MM:SS)
  const datetimePattern = /^\d{2}-\d{2}-\d{4}\s\d{2}:\d{2}:\d{2}$/;
  const datePattern = /^\d{2}-\d{2}-\d{2,4}$/;

  if (!datetimePattern.test(createdAt)) {
    result.isValid = false;
    result.errors.push(`Invalid creation datetime format: "${createdAt}" (expected DD-MM-YYYY HH:MM:SS)`);
  }

  if (!datePattern.test(arrival)) {
    result.isValid = false;
    result.errors.push(`Invalid arrival date format: "${arrival}" (expected DD-MM-YY or DD-MM-YYYY)`);
  }

  if (!datePattern.test(departure)) {
    result.isValid = false;
    result.errors.push(`Invalid departure date format: "${departure}" (expected DD-MM-YY or DD-MM-YYYY)`);
  }

  return result;
}

/**
 * Process a single reservation row
 * @param {object} row - Row object from Excel
 * @param {object} mapping - Column mapping with metadata
 * @param {number} rowIndex - Row index for error reporting
 * @returns {object|null} - Processed reservation object with warnings or null
 */
function processReservation(row, mapping, rowIndex) {
  const warnings = [];
  const notes = [];

  // Add note if using fallback column detection
  if (mapping.usedFallback) {
    notes.push('Column detection used fallback positions (no header row found)');
  }

  // Add notes for missing columns
  if (mapping.missingColumns.length > 0) {
    notes.push(`Missing columns: ${mapping.missingColumns.join(', ')}`);
  }

  // Validate the row
  const validation = validateDataRow(row, mapping);

  if (!validation.isValid) {
    return null; // Skip invalid rows
  }

  // V9 UPDATE: Extract reservation ID
  const reservationId = mapping.columns.reservationId && row[mapping.columns.reservationId]
    ? String(row[mapping.columns.reservationId]).trim()
    : null;

  if (!reservationId && mapping.columns.reservationId) {
    warnings.push('Reservation ID column found but value is empty');
  }

  // Extract and parse dates using detected column positions
  const createdAt = parseDatetime(row[mapping.columns.createdAt]);
  const arrivalDate = parseDate(row[mapping.columns.arrival]);
  const departureDate = parseDate(row[mapping.columns.departure]);
  const cancelledAt = mapping.columns.cancelledAt && row[mapping.columns.cancelledAt] ?
    parseDatetime(row[mapping.columns.cancelledAt]) : null;

  // Check for date parsing failures
  if (!createdAt) {
    warnings.push(`Failed to parse creation date: "${row[mapping.columns.createdAt]}"`);
  }
  if (!arrivalDate) {
    warnings.push(`Failed to parse arrival date: "${row[mapping.columns.arrival]}"`);
  }
  if (!departureDate) {
    warnings.push(`Failed to parse departure date: "${row[mapping.columns.departure]}"`);
  }

  // Extract and parse prices
  const averagePrice = mapping.columns.averagePrice && row[mapping.columns.averagePrice] ?
    parsePrice(row[mapping.columns.averagePrice]) : null;

  // Add warnings for price parsing failures
  if (mapping.columns.averagePrice && row[mapping.columns.averagePrice] && averagePrice === null) {
    warnings.push(`Failed to parse average price: "${row[mapping.columns.averagePrice]}"`);
  }

  // Extract other fields
  const nightsFromData = mapping.columns.nights && row[mapping.columns.nights] ?
    parseInt(row[mapping.columns.nights], 10) : null;
  const channelCell = mapping.columns.channel ? row[mapping.columns.channel] : undefined;
  const channel = (channelCell != null && String(channelCell) !== '') ? String(channelCell) : null;
  const rateCode = mapping.columns.rateCode ?
    normalizeRateCode(row[mapping.columns.rateCode]) : 'Unknown';
  const status = mapping.columns.status && row[mapping.columns.status] ?
    row[mapping.columns.status].trim() : null;

  // Group name — exact value from source; null when cell is absent or empty string
  const groupNameCell = mapping.columns.groupName ? row[mapping.columns.groupName] : undefined;
  const groupName = (groupNameCell != null && String(groupNameCell) !== '')
    ? String(groupNameCell)
    : null;

  // V0.12: additional source columns (string fields)
  const guests            = extractStringField(row, mapping.columns.guests);
  const room              = extractStringField(row, mapping.columns.room);
  const roomType          = extractStringField(row, mapping.columns.roomType);
  const country           = extractStringField(row, mapping.columns.country);
  const commercialChannel = extractStringField(row, mapping.columns.commercialChannel);
  const visitReason       = extractStringField(row, mapping.columns.visitReason);
  const marketCode        = extractStringField(row, mapping.columns.marketCode);
  const cancelledBy       = extractStringField(row, mapping.columns.cancelledBy);

  // Persons — numeric count
  const personsRaw = mapping.columns.persons ? row[mapping.columns.persons] : undefined;
  let persons = null;
  if (personsRaw != null && String(personsRaw).trim() !== '') {
    const parsedPersons = parseInt(personsRaw, 10);
    if (Number.isNaN(parsedPersons)) {
      warnings.push(`Failed to parse persons: "${personsRaw}"`);
    } else {
      persons = parsedPersons;
    }
  }

  // Calculate nights as verification (should match nightsFromData)
  const calculatedNights = calculateNights(arrivalDate, departureDate);
  const nights = nightsFromData !== null ? nightsFromData : calculatedNights;

  // Verify calculated vs provided nights if both exist
  if (nightsFromData !== null && calculatedNights !== null && nightsFromData !== calculatedNights) {
    warnings.push(`Nights mismatch: data says ${nightsFromData}, calculated ${calculatedNights}`);
  }

  // Get weekday for arrival date
  const weekdayArrival = getWeekday(arrivalDate);

  if (!weekdayArrival && arrivalDate) {
    warnings.push('Could not calculate weekday from arrival date');
  }

  // Build result object
  // V9 UPDATE: Added reservation_id as first field for deduplication
  const result = {
    reservation_id: reservationId,  // V9 UPDATE: New field for deduplication
    arrival_date: arrivalDate,
    nights: nights,
    departure_date: departureDate,
    created_at: createdAt,
    weekday_arrival: weekdayArrival,
    guests: guests,
    room: room,
    room_type: roomType,
    persons: persons,
    country: country,
    status: status,
    group_name: groupName,
    channel: channel,
    commercial_channel: commercialChannel,
    visit_reason: visitReason,
    market_code: marketCode,
    rate_code: rateCode
  };

  // Add prices if they exist
  if (averagePrice !== null) {
    result.average_price = averagePrice;
  }

  // Only include cancelled_at / cancelled_by if they exist
  if (cancelledAt) {
    result.cancelled_at = cancelledAt;
  }
  if (cancelledBy) {
    result.cancelled_by = cancelledBy;
  }

  // Add warnings and notes if they exist
  if (warnings.length > 0) {
    result._warnings = warnings;
  }
  if (notes.length > 0) {
    result._notes = notes;
  }

  return result;
}

// -------------------- Deduplication --------------------

/**
 * Returns true when a value is considered "empty" for the field-filling merge.
 * Empty: null, undefined, empty string, or the literal placeholder '[anonym]'.
 */
function isMergeEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' || t === '[anonym]';
  }
  return false;
}

/**
 * Deduplicate reservations by reservation_id using field-filling merge.
 *
 * The PMS creates two rows per reservation with the same reservation_id and
 * created_at: one anonymous VO placeholder and one row with the real guest data.
 * Fields are distributed across both rows:
 *   - cancelled_at lives on the VO row
 *   - guest name / country live on the real row ([anonym] on the VO row)
 *
 * Strategy: for each group of rows sharing the same reservation_id, produce one
 * merged record by taking the first non-empty value per field across all rows.
 * "_warnings" and "_notes" arrays are concatenated.
 *
 * Reservations without a reservation_id pass through unchanged.
 *
 * @param {array} reservations
 * @returns {{ deduplicated: array, removedCount: number }}
 */
function deduplicateReservations(reservations) {
  const groups = new Map();
  const noIdReservations = [];

  for (const res of reservations) {
    if (!res.reservation_id) {
      noIdReservations.push(res);
      continue;
    }
    const id = res.reservation_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(res);
  }

  const deduplicated = [];

  for (const rows of groups.values()) {
    if (rows.length === 1) {
      deduplicated.push(rows[0]);
      continue;
    }

    const merged = {};
    const allFields = new Set(rows.flatMap(r => Object.keys(r)));

    for (const field of allFields) {
      if (field === '_warnings' || field === '_notes') {
        const combined = rows.flatMap(r => r[field] || []);
        if (combined.length > 0) merged[field] = combined;
        continue;
      }
      // First non-empty value wins
      for (const row of rows) {
        if (!isMergeEmpty(row[field])) {
          merged[field] = row[field];
          break;
        }
      }
    }

    deduplicated.push(merged);
  }

  deduplicated.push(...noIdReservations);

  const removedCount = reservations.length - deduplicated.length;
  return { deduplicated, removedCount };
}

// ========== N8N EXECUTION CODE ==========

// Get input data from n8n
const items = $input.all();
const rows = items.map(item => item.json);

// V9 UPDATE: Extract hotel name from first 3 rows
const hotelNameExtracted = extractHotelName(rows);
if (hotelNameExtracted) {
  console.log('✅ Hotel name detected:', hotelNameExtracted);
} else {
  console.log('⚠️ Hotel name not found in first 3 rows');
}

// Detect column mapping
const mapping = detectColumnMapping(rows);

// Log detection results
console.log('Column detection method:', mapping.detectionMethod);
console.log('Detected columns:', JSON.stringify(mapping.columns));
if (mapping.missingColumns.length > 0) {
  console.log('Missing columns:', mapping.missingColumns.join(', '));
}

// V9 UPDATE: Log reservation ID detection status
if (mapping.columns.reservationId) {
  console.log('✅ Reservation ID column detected:', mapping.columns.reservationId);
} else {
  console.log('⚠️ Reservation ID column ("Res. #") not found - will use created_at for deduplication');
}

// Process all rows
const processedReservations = [];
let isFirstDataRow = true;

for (let i = 0; i < rows.length; i++) {
  const processed = processReservation(rows[i], mapping, i);

  // Only add valid reservations (skip null/invalid rows)
  if (processed) {
    // V9 UPDATE: Add hotelName to first data row only
    if (isFirstDataRow) {
      processed.hotelName = hotelNameExtracted;
      isFirstDataRow = false;
    }
    processedReservations.push(processed);
  }
}

// Deduplicate by reservation_id (keep most recent created_at per id)
const { deduplicated: deduplicatedReservations, removedCount: deduplicatedCount } =
  deduplicateReservations(processedReservations);

// Summary stats (computed on deduplicated result)
const withResId = deduplicatedReservations.filter(r => r.reservation_id).length;
const withoutResId = deduplicatedReservations.filter(r => !r.reservation_id).length;
const withWarnings = deduplicatedReservations.filter(r => r._warnings && r._warnings.length > 0).length;
const skippedRows = rows.length - processedReservations.length;

console.log(`Processed ${processedReservations.length} reservations (before deduplication)`);
console.log(`  - After deduplication: ${deduplicatedReservations.length} (removed ${deduplicatedCount} duplicates)`);
console.log(`  - With reservation_id: ${withResId}`);
console.log(`  - Without reservation_id: ${withoutResId}`);
console.log(`  - Hotel name: ${hotelNameExtracted || 'NOT FOUND'}`);

// Build warnings list
const warnings = [];
if (!hotelNameExtracted) {
  warnings.push('Hotel name not found in first 3 rows');
}
if (!mapping.columns.reservationId) {
  warnings.push('Reservation ID column ("Res. #") not detected - using created_at for deduplication');
}
if (mapping.missingColumns.length > 0) {
  warnings.push(`Missing columns: ${mapping.missingColumns.join(', ')}`);
}
if (mapping.usedFallback) {
  warnings.push('Header row not found - used fallback column positions');
}
if (withoutResId > 0) {
  warnings.push(`${withoutResId} reservations have no reservation_id`);
}
if (withWarnings > 0) {
  warnings.push(`${withWarnings} reservations have parsing warnings`);
}

// Return in n8n format: array of objects with { json: data }
// Handle empty result case
if (deduplicatedReservations.length === 0) {
  return [{
    json: {
      _summary: true,
      status: 'Error',
      message: 'No valid reservations found',
      total_rows: rows.length,
      successfully_processed: 0,
      skipped_rows: skippedRows,
      detection_method: mapping.detectionMethod,
      missing_columns: mapping.missingColumns,
      warnings: warnings
    }
  }];
}

// Build output with summary at the end
const output = deduplicatedReservations.map(reservation => ({
  json: reservation
}));

// Add summary item at the end
output.push({
  json: {
    _summary: true,
    status: warnings.length === 0 ? 'Success' : 'Success with warnings',
    message: `Processed ${deduplicatedReservations.length} reservations from ${rows.length} rows (${deduplicatedCount} duplicates removed)`,
    total_rows: rows.length,
    parsed_rows: processedReservations.length,
    successfully_processed: deduplicatedReservations.length,
    deduplicated_count: deduplicatedCount,
    skipped_rows: skippedRows,
    with_reservation_id: withResId,
    without_reservation_id: withoutResId,
    with_warnings: withWarnings,
    hotel_name: hotelNameExtracted || 'NOT FOUND',
    detection_method: mapping.detectionMethod,
    missing_columns: mapping.missingColumns,
    warnings: warnings
  }
});

return output;
