# N8N Workflow Documentatie — Hospecs Forecasting V11

## Overzicht

De V11 workflow genereert wekelijkse kamerprognoses voor hotels op basis van historische housestate data, actuele OTB-posities (On-The-Books) en een AI-annotatiestap. De workflow bestaat uit **vier Code nodes** en **één AI HTTP Request node**.

De belangrijkste architectuurwijziging ten opzichte van V10: het algoritme produceert nu zelf de getallen. De AI vult geen voorspellingen in, maar annoteert ze met contextuele observaties.

---

## Architectuur

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│   Trigger    │────▶│ Data Parser &        │────▶│ Historical Analysis  │
│ (manual /    │     │ Validator V11        │     │ Engine V11           │
│  webhook)    │     │                      │     │                      │
└──────────────┘     └──────────────────────┘     └──────────┬───────────┘
                                                              │
                                                              ▼
                                              ┌──────────────────────────┐
                                              │  Forecasting Engine V11  │
                                              │  (algorithm + AI prompt) │
                                              └──────────────┬───────────┘
                                                             │
                                              ┌──────────────▼───────────┐
                                              │  AI HTTP Request         │
                                              │  (OpenAI / Claude)       │
                                              └──────────────┬───────────┘
                                                             │
                                   ┌─────────────────────────▼──────────────┐
                                   │  AI Forecast Processor V11             │
                                   │  (merge + validate + format output)    │
                                   └─────────────────────────┬──────────────┘
                                                             │
                                                    13 output items
                                               (12 × week + 1 × summary)
```

De **AI Forecast Processor** ontvangt twee gekoppelde inputs: de output van de **AI HTTP Request** node én de output van de **Forecasting Engine** node. In N8N wordt dit gerealiseerd met een **Merge node** (mode: Combine/Wait All) vóór de Processor, of door de Forecasting Engine output rechtstreeks via `$('Forecasting engine').all()[0].json` te bereiken.

---

## Node 1 — Data Parser & Validator V11

**Bestand:** `v11_data_parser_validator.js`

### Doel
Laadt en valideert alle inputbronnen. Converteert ruwe data naar genormaliseerde structuren voor de downstream nodes.

### Input (via n8n item `.json`)
| Veld | Type | Beschrijving |
|------|------|--------------|
| `hotelInfo` | Object | Hotelmetadata: naam, type, maxRooms, etc. |
| `historicalHousestate` | Array | Dagelijkse historische actuals (≥ 730 dagen aanbevolen) |
| `currentHousestate` | Array | OTB-posities voor de komende ~90 dagen |
| `events` | Array | Evenementen met datum en geschat pickupImpact (optioneel) |

### Validaties
- `historicalHousestate.length < 730` → **WARNING** (eerder 365 — dit is de V11 wijziging)
- Verplichte velden per dag: `date`, `roomNights`, `roomRevenue`, `totalRevenue`, `weekday`
- Outlier-markering: dagen met afwijkende waarden worden geflagd met `isOutlier: true` en uitgesloten van analyses
- Ontbrekende `maxRooms` → **ERROR** (kritieke blokkering)

### Output
```json
{
  "success": true,
  "data": {
    "hotelInfo": { "hotelName": "...", "maxRooms": 120, ... },
    "historicalHousestate": [ { "date": "2024-03-25", "roomNights": 87, ... } ],
    "currentHousestate": [ { "date": "2026-03-24", "roomNights": 65, ... } ],
    "events": [ { "eventName": "Pasen", "startDate": "...", "endDate": "...", "pickupImpact": 30 } ]
  },
  "warnings": [ "..." ]
}
```

---

## Node 2 — Historical Analysis Engine V11

**Bestand:** `v11_historical_analysis.js`

### Doel
Berekent alle statistische bouwstenen die de Forecasting Engine nodig heeft. Vier nieuwe berekeningen t.o.v. V10.

### Input
De output van Node 1 (één item).

### Berekeningen

#### `calculateWeekdayBaselines()` *(bestaand)*
Gemiddelde kamersbezetting, kameromzet en ADR per weekdag (ma–zo), gefilterd op het kalendervenster van de OTB-horizon ±28 dagen. Wordt gebruikt als ADR-fallback in de Forecasting Engine.

#### `calculateRevenueRatios()` *(bestaand)*
Verhouding F&B- en overige omzet ten opzichte van kameromzet, zowel overall als per weekdag.

#### `calculateWeeklyHistoricalData()` *(nieuw V11)*
Aggregeert alle dagelijkse historische housestate naar ISO-weektotalen (roomNights, roomRevenue, totalRevenue). Weken met minder dan 5 beschikbare dagen (bijv. aan de randen van de dataset) worden uitgesloten om vertekening te voorkomen.

Resultaat: `{ "2025-W14": { roomNights: 498, roomRevenue: 54780, ... }, "2024-W14": { ... }, ... }`

#### `calculateSVBByWeek()` *(nieuw V11)*
**Seasonal Volatility Baseline** — maat voor hoeveel een weeknummer van nature schommelt in de historische data.

Methode per weeknummer W:
1. Verzamel historische kamernachten voor W-2, W-1, W, W+1, W+2 over alle beschikbare jaren
2. Normaliseer elke waarde: `(actual − weekGemiddelde) / weekGemiddelde`
3. SVB = standaarddeviatie van alle genormaliseerde afwijkingen × 100 (uitgedrukt in %)

Bij ≥ 2 jaar data en 5 naburige weken levert dit ~10–15 datapunten per weeknummer op. Standaard: 15% als er onvoldoende data is.

#### `calculateRecentTrend()` *(nieuw V11)*
Vergelijkt de 4 meest recent voltooide ISO-weken met dezelfde 4 weken van een jaar eerder. Geeft een YoY-trendpercentage dat als groeivoet in het algoritme wordt gebruikt.

#### `calculateMonthlyTrend()` *(nieuw V11)*
Vergelijkt de vorige volledige kalendermaand met dezelfde maand vorig jaar. Wordt gebruikt als proxy voor de groeivoet wanneer LY-weekdata ontbreekt.

### Output
```json
{
  "parseResult": { ... },
  "analysisResult": {
    "success": true,
    "analysis": {
      "weekdayBaselines": { "Monday": { "historicalAvgRoomNights": 72, "historicalADR": 112.50, ... }, ... },
      "revenueRatios": { "overallFBRatio": 0.18, "overallOtherRatio": 0.06, ... },
      "weeklyHistoricalData": { "2025-W14": { "roomNights": 498, ... }, ... },
      "svbByWeek": { "W14": 8.5, "W15": 11.2, ... },
      "recentTrend": { "last4WeeksActual": 1680, "last4WeeksSameLastYear": 1600, "yoyChangePercent": 5.0, "weeksAnalyzed": 4 },
      "monthlyTrend": { "previousMonthActual": 2100, "previousMonthLastYear": 1950, "yoyChangePercent": 7.7, "monthName": "February" }
    }
  }
}
```

---

## Node 3 — Forecasting Engine V11

**Bestand:** `v11_forecasting_engine.js`

### Doel
Genereert 12 wekelijkse kamernachtprognoses puur via een deterministisch algoritme. Bouwt ook de annotatieprompt voor de AI node.

### Input
De output van Node 2 (één item).

### Algoritme per week

**Stap 1: ISO-weken bepalen**
Startend van de huidige ISO-week (maandag t/m zondag), worden 12 opeenvolgende weken gebouwd. De lopende week krijgt `numDays = 7 − verlopen weekdagen`.

**Stap 2: OTB per week ophalen**
De actuele housestate (~90 dagen) wordt gegroepeerd per ISO-week. `otbRoomNights` en `otbRoomRevenue` zijn de som van alle dagwaarden in die week.

**Stap 3: Historische data opzoeken**
Voor elke voorspelweek wordt dezelfde week opgezocht in het jaar ervoor (LY), 2 jaar geleden (2YA), 3 jaar geleden (3YA) en eventueel 4YA.

**LY-fallback**: Als vorig jaar geen data heeft voor deze week, wordt LY geschat via:
- Jaar-op-jaar groei van 3YA→2YA als proxy voor 2YA→LY
- Als 3YA ook ontbreekt: monthly trend YoY% als groeivoet

**Stap 4: Gewogen gemiddelde**
```
historicalAvg = (LY × N + 2YA × (N-1) + 3YA × (N-2) + ...) / (N + (N-1) + ...)
```
Meest recente jaar krijgt het hoogste gewicht (recency bias).

**Stap 5: Trendcorrectie**
```
trendFactor   = 1 + (recentTrend.yoyChangePercent / 100)
baseline      = round(historicalAvg × trendFactor)
```

**Stap 6: Clamp op OTB en capaciteit**
```
roomNightsFinal = max(otbRoomNights, min(weekCapacity, baseline))
```
De forecast kan nooit lager zijn dan wat al geboekt staat, en nooit hoger dan de beschikbare capaciteit.

**Stap 7: Omzetberekening**
```
weekADR           = otbRoomNights ≥ 10 ? (otbRoomRevenue / otbRoomNights) : historicalAvgADR
pickup            = roomNightsFinal − otbRoomNights
estRoomRevenue    = otbRoomRevenue + pickup × weekADR
estFBRevenue      = estRoomRevenue × overallFBRatio
estOtherRevenue   = estRoomRevenue × overallOtherRatio
estTotalRevenue   = estRoomRevenue + estFBRevenue + estOtherRevenue
```

**Stap 8: Variatiebreedte (SVB)**
```
svb         = svbByWeek["W14"]          (of 15% default)
otbFillRate = otbRoomNights / roomNightsFinal
variancePct = clamp(svb × (1 − otbFillRate), 5%, 35%)
rangeLow    = round(roomNightsFinal × (1 − variancePct/100))
rangeHigh   = min(capacity, round(roomNightsFinal × (1 + variancePct/100)))
```

De redenering: een week die al voor 80% vol zit op OTB heeft weinig ruimte voor verrassing → kleinere variance. Een lege week ver in de toekomst heeft meer onzekerheid.

### Output
```json
{
  "success": true,
  "weeklyForecast": [
    {
      "weekKey": "2026-W14",
      "weekStart": "2026-03-30",
      "weekEnd": "2026-04-05",
      "numDays": 7,
      "daysUntilWeekStart": 6,
      "roomNightsFinal": 505,
      "otbRoomNights": 380,
      "pickup": 125,
      "capacity": 840,
      "occupancyPct": 60.1,
      "otbADR": 110.25,
      "estRoomRevenue": 55578,
      "estFBRevenue": 10004,
      "estOtherRevenue": 3335,
      "estTotalRevenue": 68917,
      "historicalByYear": { "2025": 498, "2024": 475, "2023": 462 },
      "historicalAvg": 484,
      "historicalLY": 498,
      "lyEstimated": false,
      "yoyVsLYPct": 1.4,
      "variancePct": 11,
      "forecastRangeLow": 449,
      "forecastRangeHigh": 561,
      "events": [ { "name": "Pasen", "pickupImpact": 30 } ]
    }
  ],
  "recentTrend": { ... },
  "monthlyTrend": { ... },
  "aiPrompt": "You are a hotel revenue forecasting analyst ...",
  "warnings": [],
  "hotelInfo": { ... }
}
```

---

## Node 4 — AI HTTP Request (OpenAI / Claude)

### Doel
Ontvangt de annotatieprompt en retourneert contextuele observaties in JSON-formaat. De AI produceert **geen getallen** — die staan al vast vanuit het algoritme.

### Configuratie in N8N
- **Method:** POST
- **URL:** `https://api.openai.com/v1/responses` (of equivalent)
- **Body:** Gebruik `{{ $json.aiPrompt }}` als promptinhoud
- **JSON mode:** aan (response_format: `json_object`)
- **Model:** `gpt-4o` of `claude-opus-4-6` aanbevolen
- **Temperature:** 0.3 (lage temperatuur voor consistente structuur)

### Verwachte AI output (JSON)
```json
{
  "weekNotes": [
    {
      "weekKey": "2026-W14",
      "notes": [
        "OTB loopt 8% voor op LY; Pasen-effect zichtbaar in historische piek 2024.",
        "Variance 11% — betrouwbaar door hoge OTB-fill rate van 75%."
      ]
    }
  ],
  "deviationSignals": [
    "Weken 15–17 tonen consistent lager OTB dan LY; possible zachte vraagperiode post-Pasen.",
    "Weekenden in mei historisch sterk — huidig OTB-tempo duidt op vergelijkbaar patroon."
  ],
  "conclusions": [
    "Totale 12-weeksprognose ligt 4% boven LY, gedreven door sterk eerste kwartaal.",
    "Variatie is laag in weken 13–15 (hoge fill rate); neemt toe vanaf week 18.",
    "F&B-omzet blijft stabiel; geen bijzondere opwaartse of neerwaartse druk verwacht."
  ]
}
```

---

## Node 5 — AI Forecast Processor V11

**Bestand:** `v11_ai_processor.js`

### Doel
Combineert de algoritmische forecast (Node 3) met de AI-annotaties (Node 4) tot database-klare output. Vervangt in V11 zowel de oude AI Processor als de aparte Hotel Forecasting Output node.

### Input
Twee gekoppelde items (via Merge node of directe referentie):
1. Output van **AI HTTP Request** node
2. Output van **Forecasting Engine** node

De processor detecteert automatisch welk item welke data bevat op basis van de aanwezigheid van `weeklyForecast` (engine) en `output[]` (AI).

### Validaties
- Structuurcheck AI-response: vereist `weekNotes`, `deviationSignals`, `conclusions` als arrays
- Waarschuwing als `roomNightsFinal > 130% van historicalLY` voor een week
- Waarschuwing bij ontbrekend AI-tekst (node failed of leeg response)

### Output — 13 items

**12 × weekrij** (`Row_Type: "week"`):

| Veld | Type | Beschrijving |
|------|------|--------------|
| `Row_Type` | string | `"week"` |
| `Week_Key` | string | ISO-weeksleutel, bv. `"2026-W14"` |
| `Week_Start` | string | Datum maandag van die week |
| `Week_End` | string | Datum zondag van die week |
| `Room_Nights_Final` | integer | Algoritmische forecast |
| `OTB_Room_Nights` | integer | Huidig geboekte kamernachten |
| `Pickup` | integer | Verwachte nieuwe boekingen |
| `Capacity_Room_Nights` | integer | Maximale capaciteit voor die week |
| `Occupancy_Pct` | float | Verwachte bezettingsgraad (%) |
| `OTB_ADR` | float\|null | Gemiddelde kamerprijs op OTB (null als < 10 RN) |
| `Est_Room_Revenue` | integer | Geschatte kameromzet (€) |
| `Est_FB_Revenue` | integer | Geschatte F&B-omzet (€) |
| `Est_Other_Revenue` | integer | Geschatte overige omzet (€) |
| `Est_Total_Revenue` | integer | Totale geschatte omzet (€) |
| `Historical_LY` | integer\|null | Kamernachten zelfde week vorig jaar |
| `Historical_Avg` | integer | Gewogen historisch gemiddelde |
| `YoY_Vs_LY_Pct` | string\|null | YoY vs LY als string, bv. `"+1.4"` |
| `LY_Estimated` | boolean | True als LY was berekend (niet gemeten) |
| `Variance_Pct` | integer | Variatiebreedte in % |
| `Forecast_Range_Low` | integer | Ondergrens van de prognose |
| `Forecast_Range_High` | integer | Bovengrens van de prognose |
| `Forecast_Notes` | string\|null | AI-annotaties voor deze week (`" | "` gescheiden) |
| `Hotel_Name` | string | Hotelnaam |
| `Forecast_Created_At` | string | ISO 8601 timestamp, identiek voor alle 13 rijen |

**1 × samenvattingsrij** (`Row_Type: "summary"`):

| Veld | Beschrijving |
|------|--------------|
| `Deviation_Signals` | Kruisweekse patronen van de AI (`" | "` gescheiden) |
| `Conclusions` | Strategische observaties van de AI (`" | "` gescheiden) |
| `Recent_Trend_*` | Bookingtrend laatste 4 weken en YoY% |
| `Monthly_Trend_*` | Maandtrend vorige maand en YoY% |
| `Hotel_Name` | Hotelnaam |
| `Forecast_Created_At` | Zelfde timestamp als de weekrijen |

---

## Wijzigingen ten opzichte van V10

| Aspect | V10 | V11 |
|--------|-----|-----|
| Forecast-eenheid | Dagelijks (per dag) | Wekelijks (per ISO-week) |
| Wie produceert de getallen | AI (via prompt) | Algoritme (deterministisch) |
| Rol van AI | Genereert forecast | Annoteert forecast |
| Historische data minimum | 365 dagen (1 jaar) | 730 dagen (2 jaar), meer = beter |
| Variantie | Niet aanwezig | SVB × (1 − OTB fill rate) |
| Hotel Forecasting Output node | Aparte node nodig | Ingebouwd in AI Processor |
| Trenddata in output | Nee | Ja (recentTrend, monthlyTrend in summary) |
| LY-fallback | Nee | Ja (via jaar-op-jaar groei of monthly trend) |

---

## Minimale datarichtlijnen

| Datahorizon | Effect |
|-------------|--------|
| < 1 jaar historisch | Baselines onbetrouwbaar; SVB valt terug op 15% default voor alle weken |
| 1–2 jaar historisch | Trend en SVB berekend, maar LY-fallback niet beschikbaar voor ontbrekende weken |
| 2–3 jaar historisch | **Aanbevolen minimum** — LY-fallback actief, SVB statistisch verantwoord |
| 3–4 jaar historisch | SVB stabieler; gewogen gemiddelde profiteert van extra datapunten |
| > 4 jaar historisch | Maximaal 4 jaar wordt meegenomen in de gewogen berekening |
