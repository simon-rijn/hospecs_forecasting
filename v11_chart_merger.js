/**
 * Hotel Revenue Forecasting System - Module 4d: Chart PNG Merger (V11)
 *
 * Receives merged inputs from:
 *   1. Report Processor output  — contains the Row_Type = "report" item
 *   2. QuickChart HTTP Request  — returns binary PNG (outputPropertyName = "data")
 *
 * Injects the chart PNG (base64) into the report row's chart_png_base64 field,
 * then passes the completed report row to v11_docx_generator.js.
 *
 * N8N wiring:
 *   Report Processor ──┐
 *                      ├─→ [Merge / Append] → this node → Docx Generator
 *   QuickChart HTTP  ──┘
 *
 * Notes:
 *   - Only the Row_Type = "report" item is forwarded (week/summary rows are
 *     not needed by the docx generator).
 *   - If no chart PNG is found the report row is forwarded with
 *     chart_png_base64 = null; the docx generator shows a placeholder.
 *   - Binary property name from the HTTP Request node must be "data"
 *     (set outputPropertyName = "data" in the HTTP Request node options).
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

// ── Find report row ───────────────────────────────────────────────────────────
const reportItem = allInputs.find(item => item.json?.Row_Type === 'report');
if (!reportItem) {
  throw new Error(
    'Chart PNG Merger V11: no report row found in inputs. ' +
    `Row types present: ${allInputs.map(i => i.json?.Row_Type || '(no type)').join(', ')}`
  );
}

// ── Find chart PNG ────────────────────────────────────────────────────────────
// The PNG Extractor node (v11_png_extractor.js) runs after the QuickChart
// HTTP Request and converts the binary to a JSON field so it survives the
// Merge node (n8n Merge strips binary data).
const chartItem = allInputs.find(item =>
  item.json?.Row_Type === 'chart_binary' && item.json?.chart_png_base64
);

let chartBase64 = null;
if (chartItem) {
  chartBase64 = chartItem.json.chart_png_base64;
  console.log(`✅ Chart PNG Merger V11: chart PNG found (${chartBase64.length} base64 chars)`);
} else {
  // Fallback: also accept direct binary (in case merger is wired without extractor)
  const binaryItem = allInputs.find(item => item.binary?.data?.data);
  if (binaryItem) {
    chartBase64 = binaryItem.binary.data.data;
    console.log(`✅ Chart PNG Merger V11: chart PNG found via binary (${chartBase64.length} chars)`);
  } else {
    console.warn('⚠️ Chart PNG Merger V11: no chart PNG found — chart_png_base64 will be null');
  }
}

// ── Merge and return ──────────────────────────────────────────────────────────
return [{
  json: {
    ...reportItem.json,
    chart_png_base64: chartBase64
  }
}];
