// Test column detection with sample data

// Normalize header labels function (same as in the code)
function normalizeHeaderLabel(val) {
  if (typeof val !== 'string') return '';
  return val
    .replace(/\u00A0/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[.,:;]+/g, '')
    .replace(/\s+/g, ' ');
}

function createColumnMapping(headerRow) {
  const mapping = {};
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
  return mapping;
}

// Sample header row from user's data
const headerRow = {
  'Periode:': 'Datum',
  '': '',
  '03-02-2025': 'Vrij',
  '_1': '',
  '_2': '',
  '_3': '%',
  '_4': 'Bezet',
  '_5': '',
  '03-02-2027': '',
  '_6': '%',
  '_34': 'Accom.',
  '_35': 'F&B',
  '_38': 'extras',
  '_40': 'Totaal',
};

const mapping = createColumnMapping(headerRow);

console.log('=== Column Detection Test Results ===\n');
console.log('Header Row Values:');
for (const [key, value] of Object.entries(headerRow)) {
  if (value && value.trim()) {
    console.log('  ' + key + ': "' + value + '" -> normalized: "' + normalizeHeaderLabel(value) + '"');
  }
}

console.log('\n--- Detected Mappings ---');
console.log('date:', mapping.date || 'NOT FOUND');
console.log('roomNights:', mapping.roomNights || 'NOT FOUND');
console.log('roomRevenue:', mapping.roomRevenue || 'NOT FOUND');
console.log('fbRevenue:', mapping.fbRevenue || 'NOT FOUND');
console.log('otherRevenue:', mapping.otherRevenue || 'NOT FOUND');
console.log('totalRevenue:', mapping.totalRevenue || 'NOT FOUND');

// Verify all expected columns detected
const expected = {
  date: 'Periode:',
  roomNights: '_4',
  roomRevenue: '_34',
  fbRevenue: '_35',
  otherRevenue: '_38',
  totalRevenue: '_40'
};

console.log('\n--- Verification ---');
let allPassed = true;
for (const [field, expectedKey] of Object.entries(expected)) {
  const actual = mapping[field];
  const passed = actual === expectedKey;
  console.log(field + ': ' + (passed ? 'PASS' : 'FAIL') + ' (expected: ' + expectedKey + ', got: ' + (actual || 'undefined') + ')');
  if (!passed) allPassed = false;
}

console.log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));

// Test data row processing
console.log('\n=== Data Row Processing Test ===\n');

const dataRow = {
  'Periode:': 'ma, 03-02-2025',
  '_4': 30,
  '_34': 2151.064220178,
  '_35': 1335.00106149,
  '_38': 265.31238531,
  '_40': 3751.377666978,
};

console.log('Sample data row:');
console.log('  RoomNights (_4):', dataRow['_4']);
console.log('  RoomRevenue (_34):', dataRow['_34']);
console.log('  FB_Revenue (_35):', dataRow['_35']);
console.log('  OtherRevenue (_38):', dataRow['_38']);
console.log('  TotalRevenue (_40):', dataRow['_40']);

const calculatedSum = dataRow['_34'] + dataRow['_35'] + dataRow['_38'];
const difference = Math.abs(calculatedSum - dataRow['_40']);

console.log('\n--- Sum Validation ---');
console.log('Calculated sum:', calculatedSum.toFixed(2));
console.log('Total revenue:', dataRow['_40'].toFixed(2));
console.log('Difference:', difference.toFixed(4));
console.log('Validation:', difference < 0.01 ? 'PASS (within tolerance)' : 'FAIL (exceeds tolerance)');
