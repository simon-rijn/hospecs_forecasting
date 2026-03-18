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
Historical Analysis → Forecasting engine → AI Forecast (Claude) → AI Forecast Processor → hotel forecasting output
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
- New output: the node now also aggregates OTB data to ISO weeks and builds a ready-to-send Claude prompt string (`aiPrompt`)

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

## Step 3: Add "AI Forecast (Claude)" HTTP Request node

Add a new **HTTP Request** node to the canvas, positioned between Forecasting engine and the (currently disconnected) hotel forecasting output node.

### Node settings

| Setting | Value |
|---|---|
| Name | `AI Forecast (Claude)` |
| Method | `POST` |
| URL | `https://api.anthropic.com/v1/messages` |
| Authentication | `Predefined Credential Type` |
| Credential Type | `Anthropic` |

### Headers (add both)

| Name | Value |
|---|---|
| `anthropic-version` | `2023-06-01` |
| `content-type` | `application/json` |

### Body

Set body content type to **JSON** and enter:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 1024,
  "temperature": 0,
  "messages": [
    {
      "role": "user",
      "content": "={{ $json.aiPrompt }}"
    }
  ]
}
```

> The `{{ $json.aiPrompt }}` expression reads the ready-built prompt string from the Forecasting engine output. No manual prompt construction needed.

### Timeout

Under **Options**, set **Timeout** to `30000` (30 seconds).

### Credential setup (one-time)

If you haven't already:
1. Go to **Settings → Credentials → Add Credential**
2. Choose **Anthropic**
3. Enter your Anthropic API key
4. Save, then select it in this node's Authentication dropdown

---

## Step 4: Add "AI Forecast Processor" Code node

Add a new **Code** node after the AI Forecast (Claude) node.

| Setting | Value |
|---|---|
| Name | `AI Forecast Processor` |
| Mode | `Run Once for All Items` |
| Language | `JavaScript` |

Paste the entire contents of `v10_ai_processor.js` into the code editor.

**What this node does:**
1. Reads the Claude API response from `$input.first().json` (the AI HTTP node output)
2. Reads the traditional daily forecast from `$('Forecasting engine').all()[0].json` (referenced by name)
3. Parses Claude's JSON response — weekly room night estimates per ISO week
4. Validates each AI estimate:
   - Cannot be below current OTB (guests already booked can't un-book)
   - Cannot exceed hotel capacity
   - Flags (warning, doesn't reject) estimates >30% above or below historical average
5. Distributes the weekly AI estimate proportionally back to daily room nights
6. Recalculates all revenue metrics for each day
7. Falls back to traditional forecast for any week where the AI response is missing or invalid
8. Outputs `{ success, forecast, warnings, hotelInfo }` — identical shape to what the hotel forecasting output node already expects

---

## Step 5: Rewire connections

### Remove
- Connection from **Forecasting engine** → **hotel forecasting output**

### Add (in order)
- **Forecasting engine** → **AI Forecast (Claude)** (main output → input 0)
- **AI Forecast (Claude)** → **AI Forecast Processor** (main output → input 0)
- **AI Forecast Processor** → **hotel forecasting output** (main output → input 0)

### Final chain
```
Data Parser Validator
  → Historical Analysis
      → Forecasting engine
          → AI Forecast (Claude)           [NEW]
              → AI Forecast Processor      [NEW]
                  → hotel forecasting output
      → Code in JavaScript                 [unchanged — accuracy tracking]
```

---

## Step 6: Verify

Run the workflow once manually (use the **Test Workflow** button or trigger with a real email).

Check each node's output panel:

| Node | What to look for |
|---|---|
| Historical Analysis | Log line: `✅ Historical analysis completed (V10) — Mon: 14 samples, ...`. Sample counts should be 10+ per weekday. |
| Forecasting engine | Log line: `✅ Forecast (V10): 90 days, NNN RN, €NNN`. No "CRITICAL" errors. |
| AI Forecast (Claude) | Status 200. Response contains `content[0].text` with a JSON object including a `"weeks"` array. |
| AI Forecast Processor | Log line: `✅ AI Processor: NNN RN, €NNN | AI weeks: N, Traditional fallback: N`. Zero or low fallback count is good. |
| hotel forecasting output | Same output format as before — `Stay_Date`, `Room_Nights_Final`, etc. |

### Common issues

**AI node returns 401**
→ Anthropic API key is missing or invalid. Check the credential in Settings → Credentials.

**AI Forecast Processor: "No text content in AI response"**
→ Check the AI node output panel. If the model returned an error (e.g. 529 overload), the processor falls back to traditional forecast automatically and logs a warning. No action needed unless it happens consistently.

**Historical Analysis: "Only N days of historical data"**
→ Expected for the first few months of operation while historical data accumulates. Forecast will still run but baselines are less reliable. Improve naturally over time.

**Forecasting engine: "CRITICAL: Missing historical data for weekdays: Saturday"**
→ The calendar-period window found zero Saturday records. Check that the `historicalHousestate` data is flowing correctly into the Data Parser Validator. Usually means the housestate table query returned no rows.

---

## What does NOT change

- The 40+ node data flow — email trigger, attachment extraction, database queries, aggregation, accuracy tracking — stays exactly as-is
- The **hotel forecasting output** node — accepts the same `{ success, forecast, hotelInfo }` shape
- The **Code in JavaScript** node (accuracy tracking / WMAPE) — receives Historical Analysis output, unchanged
- All database tables and column names
- All n8n credentials except the new Anthropic credential

---

## File reference

| File | Node | LOC |
|---|---|---|
| `v10_historical_analysis.js` | Historical Analysis | ~215 |
| `v10_forecasting_engine.js` | Forecasting engine | ~270 |
| `v10_ai_processor.js` | AI Forecast Processor | ~220 |
| `v9_accuracy_integration.js` | Code in JavaScript | unchanged |

The updated `hospecs_forecasting_workflow_v8.json` already has all these changes applied. You can import it directly to skip steps 1–5 — just add the Anthropic credential after import (credentials are never stored in the JSON export).
