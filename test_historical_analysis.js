const fs = require('fs');
const workflow = JSON.parse(fs.readFileSync('hospecs_forecasting_workflow_v8.json', 'utf8'));
const node = workflow.nodes.find(n => n.id === '486e9ed3-0ea3-42fb-a3bb-4a6699619a4d');

if (node) {
  const code = node.parameters.jsCode;

  console.log('=== Historical Analysis Verification ===\n');

  // Check weekday baselines window
  console.log('calculateWeekdayBaselines:');
  console.log('  - Window definition (30 before):', code.includes('windowStart.setDate(windowStart.getDate() - 30)') ? 'YES' : 'NO');
  console.log('  - Window definition (60 after):', code.includes('windowEnd.setDate(windowEnd.getDate() + 60)') ? 'YES' : 'NO');
  console.log('  - Window filtering:', code.includes('const filteredData = historicalData.filter') ? 'YES' : 'NO');
  console.log('  - Metadata included:', code.includes('baselines._metadata') ? 'YES' : 'NO');

  // Check booking pace curves window
  console.log('\ncalculateBookingPaceCurves:');
  console.log('  - Metadata object:', code.includes('bookingPaceCurvesMetadata') ? 'YES' : 'NO');
  console.log('  - Sample size per weekday:', code.includes('curvePoints._sampleSize') ? 'YES' : 'NO');
  console.log('  - Overall curve sample size:', code.includes('overallCurve._sampleSize') ? 'YES' : 'NO');

  // Check revenue ratios window
  console.log('\ncalculateRevenueRatios:');
  console.log('  - Window filtering:', code.includes('const filteredData = historicalData.filter') ? 'YES' : 'NO');
  console.log('  - Returns metadata:', code.includes('_metadata: {') ? 'YES' : 'NO');

  // Check helper function
  console.log('\nHelper functions:');
  console.log('  - getForecastStartDate():', code.includes('getForecastStartDate()') ? 'YES' : 'NO');

  // Check old window function removed
  const hasOldFunction = code.includes('getLookbackWindow()');
  console.log('\nOld code status:');
  console.log('  - getLookbackWindow() removed:', hasOldFunction ? 'NO (still present)' : 'YES (removed)');

  // Summary
  console.log('\n=== Summary ===');
  const checks = [
    code.includes('windowStart.setDate(windowStart.getDate() - 30)'),
    code.includes('windowEnd.setDate(windowEnd.getDate() + 60)'),
    code.includes('baselines._metadata'),
    code.includes('bookingPaceCurvesMetadata'),
    code.includes('_metadata: {'),
    code.includes('getForecastStartDate()'),
    !hasOldFunction
  ];

  const passed = checks.filter(c => c).length;
  console.log(`Checks passed: ${passed}/${checks.length}`);
  console.log(passed === checks.length ? 'ALL VERIFICATIONS PASSED' : 'SOME VERIFICATIONS FAILED');
}
