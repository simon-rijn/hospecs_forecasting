# V10 Workflow Migration Guide

How to update the n8n workflow to use the new V10 forecasting nodes. All changes are inside the n8n canvas — no structural data flow changes, no new data sources.

---

## What changes and why

### Before (V9)
```
Historical Analysis → Forecasting engine → hotel forecasting output
```

### After (V10)
```
Historical Analysis → Forecasting engine → AI Forecast (OpenAI) → AI Forecast Processor → hotel forecasting output
```

Two new nodes are inserted between **Forecasting engine** and **hotel forecasting output**. Two existing nodes get new code. Everything else stays exactly as-is.

---

## Step 1: Update "Historical Analysis" node

Open the **Historical Analysis** Code node and replace its entire contents with the code from `v10_historical_analysis.js`.

**What changed:**
- The 90-day seasonal window (centered on 1 year ago) is replaced with a calendar-period window — all available historical data from the same seasonal period ±4 weeks, across all available years
- Booking pace curves removed entirely (reservation data only captures 30–60% of actual occupancy, making all curve percentages systematically wrong)
- Channel mix and leadtime distribution removed (not needed for AI-assisted forecast)
- Result: ~150 LOC instead of 756. Only weekday baselines and revenue ratios remain.

**Settings to verify:**
- Mode: `Run Once for All Items`
- Language: `JavaScript`

---

## Step 2: Update "Forecasting engine" node

Open the **Forecasting engine** Code node and replace its entire contents with the code from `v10_forecasting_engine.js`.

**What changed:**
- **Critical bug fix**: `daysUntilArrival` now calculated from `new Date()` (today), not from `otbData[0].date` (first date in the OTB export). If the OTB export started a week before the forecast was created, every date was previously 7 positions off on the booking curve.
- Booking pace curve lookup removed — no more Traditional vs. Curve split, no 30-day switching threshold
- Single forecast path: historical weekday baseline × growth trend + event pickup
- New output: the node now also aggregates OTB data to ISO weeks and builds a ready-to-send prompt string (`aiPrompt`)

**Output shape** (what the next node receives):
```json
{
  "success": true,
  "forecast": [ /* daily array, same shape as before */ ],
  "weeklyAiInput": {
    "hotel": { "name": "...", "maxRooms": 120, "growthTrend": 1.05 },
    "weeks": [
      {
        "weekKey": "2026-W13",
        "weekStart": "2026-03-23",
        "weekEnd": "2026-03-29",
        "numDays": 7,
        "currentOtbRoomNights": 245,
        "traditionalForecastRoomNights": 432,
        "historicalAvgRoomNights": 412,
        "expectedRoomNights": 433,
        "capacity": 840,
        "daysUntilWeekStart": 5,
        "events": []
      }
    ]
  },
  "aiPrompt": "You are a hotel revenue forecasting assistant...",
  "warnings": [],
  "hotelInfo": { ... }
}
```

**Settings to verify:**
- Mode: `Run Once for All Items`
- Language: `JavaScript`

---

## Step 3: Add "AI Forecast (OpenAI)" node

Add a new **OpenAI** node to the canvas, positioned between Forecasting engine and the (currently disconnected) hotel forecasting output node.

In the n8n node panel, search for **OpenAI** and select the one listed under the main integrations (not under AI/LangChain).

### Node settings

| Setting | Value |
|---|---|
| Name | `AI Forecast (OpenAI)` |
| Resource | `Chat` |
| Operation | `Complete` (Message a Model) |
| Model | `gpt-4o-mini` |

### Messages

Add one message entry:

| Field | Value |
|---|---|
| Role | `user` |
| Content | `={{ $json.aiPrompt }}` |

> The `{{ $json.aiPrompt }}` expression reads the ready-built prompt string from the Forecasting engine output. No manual prompt construction needed.

### Options

| Setting | Value |
|---|---|
| Temperature | `0` |
| Max Tokens | `1024` |
| Response Format | `JSON Object` |

**Response Format is the critical setting here.** Setting it to `JSON Object` enables OpenAI's JSON mode, which guarantees the model always returns valid, parseable JSON. Without it, the model might add markdown fences, preamble text, or malformed output that breaks the downstream processor. Temperature 0 makes the forecast deterministic — the same inputs always produce the same output.

### Credential setup (one-time)

If you haven't added an OpenAI credential yet:
1. Go to **Settings → Credentials → Add Credential**
2. Search for **OpenAI**
3. Enter your OpenAI API key
4. Save, then select it in this node's credential dropdown

---

## Step 4: Add "AI Forecast Processor" Code node

Add a new **Code** node after the AI Forecast (OpenAI) node.

| Setting | Value |
|---|---|
| Name | `AI Forecast Processor` |
| Mode | `Run Once for All Items` |
| Language | `JavaScript` |

Paste the entire contents of `v10_ai_processor.js` into the code editor.

**What this node does:**
1. Reads the OpenAI response from `$input.first().json` — specifically `message.content` (the n8n OpenAI node output format)
2. Reads the traditional daily forecast from `$('Forecasting engine').all()[0].json` (referenced by node name — no wiring needed)
3. Parses the JSON inside the AI text response — weekly room night estimates per ISO week
4. Validates each AI estimate:
   - Cannot be below current OTB (guests already booked can't un-book)
   - Cannot exceed hotel capacity
   - Flags (warning, doesn't reject) estimates >30% above or below historical average
5. Distributes the weekly AI estimate proportionally back to daily room nights
6. Recalculates all revenue metrics for each day
7. Falls back to traditional forecast for any week where the AI response is missing or invalid
8. Outputs `{ success, forecast, warnings, hotelInfo }` — identical shape to what the hotel forecasting output node already expects

**Response format handled:**
The n8n OpenAI node returns `{ message: { content: "..." } }`. With JSON mode enabled on the OpenAI node, `message.content` is guaranteed to be valid JSON — the processor calls `JSON.parse()` directly, no regex parsing. If the schema is wrong (missing `weeks` array, missing `weekKey` or `forecastedRoomNights` fields), the processor throws a descriptive error rather than silently falling back. Per-week fallback to traditional forecast still applies when the AI omits a specific week from its response.

---

## Step 5: Rewire connections

### Remove
- Connection from **Forecasting engine** → **hotel forecasting output**

### Add (in order)
- **Forecasting engine** → **AI Forecast (OpenAI)** (main output → input 0)
- **AI Forecast (OpenAI)** → **AI Forecast Processor** (main output → input 0)
- **AI Forecast Processor** → **hotel forecasting output** (main output → input 0)

### Final chain
```
Data Parser Validator
  → Historical Analysis
      → Forecasting engine
          → AI Forecast (OpenAI)       [NEW — n8n native OpenAI node]
              → AI Forecast Processor  [NEW — Code node]
                  → hotel forecasting output
      → Code in JavaScript             [unchanged — accuracy tracking]
```

---

## Step 6: Verify

Run the workflow once manually (use the **Test Workflow** button or trigger with a real email).

Check each node's output panel:

| Node | What to look for |
|---|---|
| Historical Analysis | Log: `✅ Historical analysis completed (V10) — Mon: 14 samples, ...`. Sample counts should be 10+ per weekday. |
| Forecasting engine | Log: `✅ Forecast (V10): 90 days, NNN RN, €NNN`. No "CRITICAL" errors. |
| AI Forecast (OpenAI) | Output panel shows `message.content` containing a JSON object with a `"weeks"` array. |
| AI Forecast Processor | Log: `✅ AI Processor: NNN RN, €NNN \| AI weeks: N, Traditional fallback: N`. |
| hotel forecasting output | Same output format as before — `Stay_Date`, `Room_Nights_Final`, etc. |

### Common issues

**AI Forecast (OpenAI) returns 401**
→ OpenAI API key is missing or invalid. Check the credential in Settings → Credentials.

**AI Forecast (OpenAI) returns 429**
→ OpenAI rate limit or quota exceeded. Check your OpenAI usage dashboard. The workflow will error and stop — retry manually or wait until quota resets.

**AI Forecast Processor: "no content in OpenAI response"**
→ The OpenAI node succeeded but returned an empty message. Most likely cause: Response Format is not set to `JSON Object` in the OpenAI node options. Check Step 3.

**AI Forecast Processor: "response missing weeks array"**
→ The model returned valid JSON but with a different structure than expected. Open the AI Forecast (OpenAI) output panel, read `message.content`, and compare it to the expected schema. If the prompt changed, verify the `aiPrompt` field in the Forecasting engine output panel still ends with the schema definition.

**AI Forecast Processor: "N week(s) missing weekKey or forecastedRoomNights"**
→ The model returned the `weeks` array but omitted required fields on some entries. Check the raw response in the OpenAI node output. This should not happen with JSON mode + the current prompt — if it does, it usually means the model hit `max_tokens` before finishing. Increase Max Tokens from 1024 to 2048 in the OpenAI node options if you have many forecast weeks (>12).

**Historical Analysis: "Only N days of historical data"**
→ Expected for the first months of operation while data accumulates. The forecast still runs. Baselines improve naturally as more historical data is collected.

**Forecasting engine: "CRITICAL: Missing historical data for weekdays: Saturday"**
→ The calendar-period window found zero records for that weekday. Check that the `historicalHousestate` data is flowing into the Data Parser Validator. Usually means the housestate table query returned no rows.

---

## What does NOT change

- The 40+ node data flow — email trigger, attachment extraction, database queries, aggregation, accuracy tracking — stays exactly as-is
- The **hotel forecasting output** node — accepts the same `{ success, forecast, hotelInfo }` shape
- The **Code in JavaScript** node (accuracy tracking / WMAPE) — receives Historical Analysis output, unchanged
- All database tables and column names

---

## Model choice

The workflow is configured with `gpt-4o-mini` — fast, cheap (~$0.002 per forecast run), and accurate enough for weekly room night estimation. If you want higher accuracy at higher cost, change the model to `gpt-4o` in the node settings.

---

## File reference

| File | Node | LOC |
|---|---|---|
| `v10_historical_analysis.js` | Historical Analysis | ~215 |
| `v10_forecasting_engine.js` | Forecasting engine | ~270 |
| `v10_ai_processor.js` | AI Forecast Processor | ~220 |
| `v9_accuracy_integration.js` | Code in JavaScript | unchanged |

The updated `hospecs_forecasting_workflow_v8.json` already has all these changes applied, including the OpenAI node. You can import it directly to skip steps 1–5 — just connect your OpenAI credential after import (credentials are never stored in the JSON export).
