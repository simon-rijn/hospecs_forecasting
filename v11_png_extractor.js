/**
 * Hotel Revenue Forecasting System - Module 4e: PNG Binary Extractor (V11)
 *
 * Placed immediately after the QuickChart HTTP Request node.
 * Converts the binary PNG response to a plain JSON item so the base64
 * string survives the Merge node (n8n Merge strips binary data).
 *
 * N8N wiring:
 *   QuickChart HTTP Request → this node → Merge → Chart Merger → Docx Generator
 *
 * Output JSON: { Row_Type: "chart_binary", chart_png_base64: "<base64 string>" }
 */

// ============ N8N EXECUTION CODE ============

const item = $input.first();

// n8n stores the HTTP response binary under the outputPropertyName
// configured in the HTTP Request node (should be "data").
const b64 = item.binary?.data?.data ?? null;

if (!b64) {
  console.warn('⚠️ PNG Extractor V11: no binary data found on input item. ' +
    `Binary keys present: ${JSON.stringify(Object.keys(item.binary || {}))}`);
}

console.log(`✅ PNG Extractor V11: extracted ${b64 ? b64.length : 0} base64 chars`);

return [{
  json: {
    Row_Type:         'chart_binary',
    chart_png_base64: b64
  }
}];
