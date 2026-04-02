/**
 * Hotel Revenue Forecasting System - Module 4b: Layer 2 Prompt Builder (V11)
 *
 * Runs AFTER the AI Forecast Processor (Layer 1).
 * Input: 12 "week" rows + 1 "summary" row from v11_ai_processor.js
 *
 * Responsibilities:
 *   1. Extract Layer 1 analysis from the summary row (metric_connections, anomalies, data_gaps)
 *   2. Compute a compact performance context from the week rows
 *   3. Insert everything into the Layer 2 prompt template as structured JSON
 *   4. Output 1 item (Row_Type = 'l2_prompt') ready for the Layer 2 OpenAI HTTP node
 *
 * To update the Layer 2 analysis prompt: edit LAYER2_PROMPT_TEMPLATE below.
 * To change what data is sent to Layer 2: edit buildLayer2InputJson() below.
 * Nothing else in the pipeline needs to change.
 *
 * N8N wiring:
 *   AI Processor → this node → AI Node 2 (HTTP) → Report Processor
 */

// ============ LAYER 2 PROMPT TEMPLATE ============
// Edit this to change the analysis style, language, structure, or rules.
// {LAYER1_ANALYSIS_JSON} is replaced at runtime with the structured JSON below.

const LAYER2_PROMPT_TEMPLATE = `
Je bent een hotel business analyst. Jouw enige taak is om te redeneren voorbij de data.

Je ontvangt een JSON-analyse van een 12-weeks hotelforecast.
Beschrijf NIET wat de data laat zien. Ga ervan uit dat de lezer de cijfers al heeft gezien.

Jouw taak is uitsluitend:
1. Conclusies trekken die niet direct zichtbaar zijn in de data
2. Verbanden leggen tussen metrics die een onderliggende dynamiek onthullen
3. Benoemen wat ontbreekt — en welke beslissingen daardoor niet genomen kunnen worden

---

REGELS:
- Herhaal geen enkel getal tenzij het direct een niet-voor-de-hand-liggende conclusie ondersteunt
- Vat geen trends samen die al zichtbaar zijn in de data
- Elke zin moet iets verborgens onthullen of een hiaat identificeren
- Schrijf in het Nederlands, in doorlopende tekst, geen opsommingen
- Maximaal 250 woorden
- Wees genadeloos beknopt — verwijder elke zin die geen inzicht toevoegt

---

STRUCTUUR:

**Wat de data impliceert**
Twee tot drie alinea's. Focus uitsluitend op conclusies die meerdere datapunten vereisen,
of die tegenspreken wat de oppervlaktecijfers suggereren.

**Wat ontbreekt om scherper te concluderen**
Één alinea. Benoem de specifieke data die de bovenstaande conclusies zou veranderen of
verscherpen. Formuleer elk hiaat als een vraag.

---

INVOERDATA:
{LAYER1_ANALYSIS_JSON}
`.trim();

// ============ N8N EXECUTION CODE ============

const allItems = $input.all().map(item => item.json);

const weekRows   = allItems.filter(r => r.Row_Type === 'week');
const summaryRow = allItems.find(r => r.Row_Type === 'summary');

if (weekRows.length === 0) {
  throw new Error('Layer 2 Prompt Builder V11: no week rows found in input.');
}
if (!summaryRow) {
  throw new Error('Layer 2 Prompt Builder V11: no summary row found in input.');
}

const layer1 = summaryRow.Layer1_Analysis;
if (!layer1) {
  throw new Error('Layer 2 Prompt Builder V11: summary row missing Layer1_Analysis field.');
}

// ── Compute aggregate context from week rows ──────────────────────────────────

const totalForecastRN = weekRows.reduce((s, w) => s + (w.Room_Nights_Final    ?? 0), 0);
const totalOTBRN      = weekRows.reduce((s, w) => s + (w.OTB_Room_Nights      ?? 0), 0);
const totalCapacity   = weekRows.reduce((s, w) => s + (w.Capacity_Room_Nights ?? 0), 0);
const totalRevenue    = weekRows.reduce((s, w) => s + (w.Est_Total_Revenue     ?? 0), 0);

const overallFillRate = totalForecastRN > 0
  ? parseFloat((totalOTBRN / totalForecastRN * 100).toFixed(1)) : 0;
const avgOccupancy = totalCapacity > 0
  ? parseFloat((totalForecastRN / totalCapacity * 100).toFixed(1)) : 0;

// YoY trend direction from week rows
const yoyValues = weekRows.map(w => {
  const v = w.YoY_Vs_LY_Pct;
  return v != null ? parseFloat(String(v).replace('+', '')) : null;
}).filter(v => v != null);

const earlyYoY = yoyValues.slice(0, 6);
const lateYoY  = yoyValues.slice(6);
const avgEarly = earlyYoY.length > 0
  ? parseFloat((earlyYoY.reduce((s, v) => s + v, 0) / earlyYoY.length).toFixed(1)) : null;
const avgLate  = lateYoY.length > 0
  ? parseFloat((lateYoY.reduce((s, v) => s + v, 0) / lateYoY.length).toFixed(1))  : null;
const yoyDirection = (avgEarly != null && avgLate != null)
  ? ((avgLate - avgEarly) > 1.5  ? 'VERBETEREND'
   : (avgLate - avgEarly) < -1.5 ? 'VERSLECHTEREND'
   : 'STABIEL')
  : 'onbekend';

// Monthly aggregates (Thursday-rule)
const MONTH_NL = ['Januari','Februari','Maart','April','Mei','Juni',
                  'Juli','Augustus','September','Oktober','November','December'];
const monthMap = new Map();
weekRows.forEach(w => {
  const mon = new Date(w.Week_Start);
  mon.setDate(mon.getDate() + 3); // Thursday
  const mk = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}`;
  if (!monthMap.has(mk)) {
    monthMap.set(mk, {
      maand: `${MONTH_NL[mon.getMonth()]} ${mon.getFullYear()}`,
      otb: 0, forecast: 0, capacity: 0, omzet: 0, weken: 0
    });
  }
  const m = monthMap.get(mk);
  m.weken    += 1;
  m.otb      += w.OTB_Room_Nights      ?? 0;
  m.forecast += w.Room_Nights_Final     ?? 0;
  m.capacity += w.Capacity_Room_Nights  ?? 0;
  m.omzet    += w.Est_Total_Revenue     ?? 0;
});

const maandtotalen = Array.from(monthMap.values()).map(m => ({
  maand:           m.maand,
  forecast_rn:     m.forecast,
  bezetting_pct:   m.capacity > 0 ? parseFloat((m.forecast / m.capacity * 100).toFixed(1)) : null,
  fill_rate_pct:   m.forecast > 0 ? parseFloat((m.otb / m.forecast * 100).toFixed(1)) : null,
  est_omzet_eur:   Math.round(m.omzet)
}));

// Risk flags
const risicoweken = weekRows
  .filter(w => w.Signal_Level === 'high' || w.Signal_Level === 'medium')
  .map(w => ({
    week:     w.Week_Key,
    niveau:   w.Signal_Level,
    signalen: w.Signals ? w.Signals.split(' | ') : []
  }));

// ── Build Layer 2 input JSON ──────────────────────────────────────────────────

const layer2InputJson = {
  context: {
    hotel:           weekRows[0].Hotel_Name || 'Onbekend',
    periode:         `${weekRows[0].Week_Key} t/m ${weekRows[weekRows.length - 1].Week_Key}`,
    aanmaakdatum:    weekRows[0].Forecast_Created_At
      ? weekRows[0].Forecast_Created_At.split('T')[0] : null,
    horizon_weken:   weekRows.length
  },
  prestatie_overzicht: {
    totaal_forecast_rn:    totalForecastRN,
    totaal_otb_rn:         totalOTBRN,
    overall_fill_rate_pct: overallFillRate,
    gemiddelde_bezetting_pct: avgOccupancy,
    totaal_est_omzet_eur:  Math.round(totalRevenue),
    yoy_richting:          yoyDirection,
    yoy_vroege_weken_pct:  avgEarly,
    yoy_late_weken_pct:    avgLate
  },
  maandtotalen,
  // Layer 1 AI analysis — the core reasoning input for Layer 2
  metric_verbanden:  layer1.metric_connections,
  anomalieen:        layer1.anomalies || [],
  risicoweken,
  data_hiaten:       layer1.data_gaps
};

// ── Insert into prompt template ───────────────────────────────────────────────

const layer2Prompt = LAYER2_PROMPT_TEMPLATE.replace(
  '{LAYER1_ANALYSIS_JSON}',
  JSON.stringify(layer2InputJson, null, 2)
);

console.log(
  `✅ Layer 2 Prompt Builder V11: prompt built for ${weekRows[0].Hotel_Name} | ` +
  `${weekRows.length} weeks | ${layer1.metric_connections.length} metric connections | ` +
  `${layer1.data_gaps.length} data gaps`
);

return [{
  json: {
    Row_Type:            'l2_prompt',
    L2_Prompt:           layer2Prompt,
    Hotel_Name:          weekRows[0].Hotel_Name,
    Forecast_Created_At: weekRows[0].Forecast_Created_At
  }
}];
