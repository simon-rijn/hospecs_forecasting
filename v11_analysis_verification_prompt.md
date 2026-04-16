# Historical Analysis Verification Prompt

**How to use:**
Attach two JSON files to this prompt:
- `INPUT` — output of `v11_export_analysis_inputs.js`
- `ANALYSIS` — output of `v11_historical_analysis.js` (`analysisResult.analysis`)

Then send the prompt below to the AI model.

---

## Prompt

You are verifying the output of a hotel revenue forecasting historical analysis engine. You have been given two JSON objects:

- **INPUT**: the exact data fields consumed by the analysis (housestate rows, reservation rows)
- **ANALYSIS**: the computed analysis output

Your task is to independently recompute each metric from INPUT and compare it to ANALYSIS. Work through each check below in order. For every check report one of:
- ✓ PASS — your computed value matches ANALYSIS within rounding (±1 unit or ±0.1%)
- ✗ FAIL — values differ; show your computed value vs the ANALYSIS value
- ⚠ SKIP — explain why the check cannot be completed (e.g. dataset too large to sum reliably)

Do not skip a check unless you have a concrete reason. Be precise.

---

### Business logic rules (apply these throughout)

**isGroup(reservation):**
A reservation is a group booking when `groupName` is non-null AND does not start with `"IDS"`.
All others (null groupName, or groupName starting with "IDS") are individuals.

**isCancelled(reservation):**
A reservation is cancelled when `status === "CO"` OR `cancelledAt` is non-null.
Cancelled reservations are EXCLUDED from segmentation, channel, leadtime, and average-price analyses.
They are INCLUDED in cancellation-rate analysis.

**isOutlier (housestate):**
Rows where `isOutlier === true` are excluded from all housestate-based calculations.

**Calendar window filter (housestate only):**
The analysis filters historical housestate to a seasonal window around the OTB period.
The window is: day-of-year of the first OTB date − 28 through day-of-year of the last OTB date + 28.
`currentHousestate` in INPUT gives you the OTB date range.
Rows outside this window are excluded from weekdayBaselines and revenueRatios, but NOT from weeklyHistoricalData or monthlyTrend.

**Week key format:** ISO 8601 — `"YYYY-Www"` (e.g. `"2025-W14"`).
**Month key format:** `"YYYY-MM"` (e.g. `"2025-04"`).

---

### CHECK 1 — Weekday baselines

Pick any TWO weekdays from `ANALYSIS.weekdayBaselines` (e.g. Monday and Friday).

For each chosen weekday:
1. Filter `INPUT.historicalHousestate` to rows where `weekday === <chosen>` AND `isOutlier !== true` AND the row falls within the calendar window.
2. Compute: `avg_roomNights = sum(roomNights) / count`, `avg_roomRevenue = sum(roomRevenue) / count`, `ADR = avg_roomRevenue / avg_roomNights`.
3. Compare with `ANALYSIS.weekdayBaselines.<weekday>.historicalAvgRoomNights`, `.historicalAvgRoomRevenue`, `.historicalADR`, `.sampleSize`.

Report: weekday, your sampleSize, your avg RN, ANALYSIS avg RN, your ADR, ANALYSIS ADR.

---

### CHECK 2 — Revenue ratios

Using all non-outlier housestate rows within the calendar window where `roomRevenue > 0` AND `totalRevenue > 0`:

1. Compute `overallOtherRatio = (sum(totalRevenue) - sum(roomRevenue)) / sum(roomRevenue)`.
   If `fbRevenue` is present on any row: also compute `overallFBRatio = sum(fbRevenue) / sum(roomRevenue)`.
2. Compare with `ANALYSIS.revenueRatios.overallOtherRatio` and `.overallFBRatio`.

Report: your row count, your overallOtherRatio, ANALYSIS value, and (if applicable) your overallFBRatio vs ANALYSIS.

---

### CHECK 3 — Weekly historical data (spot-check 3 weeks)

Pick THREE week keys from `ANALYSIS.weeklyHistoricalData` — one early in the dataset, one in the middle, one recent.

For each:
1. Filter `INPUT.historicalHousestate` to rows whose `date` falls within that ISO week (Monday–Sunday) AND `isOutlier !== true`.
2. Sum `roomNights`, `roomRevenue`, `totalRevenue`. Count the days.
3. Compare with `ANALYSIS.weeklyHistoricalData[weekKey].roomNights`, `.roomRevenue`, `.totalRevenue`, `.days`.

Note: weeks with fewer than 5 days in the data are dropped by the analysis (should not appear in ANALYSIS). If you find fewer than 5 matching rows for a week that IS in ANALYSIS, flag it as a discrepancy.

Report: weekKey, your day count, your RN sum, ANALYSIS RN.

---

### CHECK 4 — Recent trend

`ANALYSIS.recentTrend` covers the 4 completed ISO weeks immediately before the current week.

1. Determine today's date. Find the Monday of the current ISO week. The 4 completed weeks are the 4 ISO weeks ending before that Monday.
2. For each of those 4 week keys (CY): look up `roomNights` in `ANALYSIS.weeklyHistoricalData`. Sum → `last4WeeksActual`.
3. For each of those 4 week keys (LY, same week number one year back): look up `roomNights`. Sum → `last4WeeksSameLastYear`.
4. Compute `yoyChangePercent = (last4Actual - last4LY) / last4LY × 100`, rounded to 1 decimal.
5. Compare all three values with `ANALYSIS.recentTrend`.

Report: the 4 week keys used, your CY sum, LY sum, your YoY%, ANALYSIS YoY%.

---

### CHECK 5 — Monthly trend

`ANALYSIS.monthlyTrend` covers the previous complete calendar month vs the same month last year.

1. Identify the previous complete calendar month (e.g. if today is April, the month is March).
2. Filter `INPUT.historicalHousestate` to rows where `date` falls in that month AND `isOutlier !== true`. Sum `roomNights` → `previousMonthActual`.
3. Filter to the same month one year earlier. Sum → `previousMonthLastYear`.
4. Compute `yoyChangePercent = (actual - ly) / ly × 100`, rounded to 1 decimal.
5. Compare with `ANALYSIS.monthlyTrend.previousMonthActual`, `.previousMonthLastYear`, `.yoyChangePercent`, `.monthName`.

Report: the month, your actual RN, your LY RN, your YoY%, ANALYSIS values.

---

### CHECK 6 — SVB sanity check (no full recomputation)

The SVB is too complex to fully recompute here. Do a structural sanity check instead:

1. Confirm all 53 week keys (`W01`–`W53`) are present in `ANALYSIS.svbByWeek`.
2. Confirm all values are numbers in the range 5–40 (the analysis defaults to 15.0 for sparse weeks).
3. Cross-check directional plausibility: identify the 3 weeks with the HIGHEST SVB and the 3 with the LOWEST. Check whether the high-SVB weeks correspond to periods you would expect to be volatile for a hotel (e.g. summer peak, holiday transitions) and low-SVB weeks to stable periods. Use the weekly historical data to see which weeks have the most year-to-year variation.

Report: count of keys present, any out-of-range values, top-3 and bottom-3 SVB weeks with their values.

---

### CHECK 7 — Segmentation (spot-check 1 month)

Pick ONE month key that appears in `ANALYSIS.segmentation.past_8w_cy.by_month`.

1. Filter `INPUT.historicalReservations` to rows where `arrivalDate` falls in that month AND `isCancelled` is false.
2. Partition into groups vs individuals using `isGroup()`.
3. Sum `nights` for each partition → `groups_rn`, `individuals_rn`.
4. Compute percentages: `groups_pct = groups_rn / (groups_rn + individuals_rn) × 100`.
5. Compare with `ANALYSIS.segmentation.past_8w_cy.by_month[monthKey].groups.rn`, `.groups.pct`, `.individuals.rn`, `.individuals.pct`.

Report: month key, your groups RN, your individuals RN, your groups%, ANALYSIS values.

---

### CHECK 8 — Channel breakdown (spot-check 1 month)

Use the same month as CHECK 7.

1. Filter `INPUT.historicalReservations` to same month, non-cancelled.
2. Group by `channel`, then by group/individual. Sum `nights` per channel per segment.
3. Compare with `ANALYSIS.channelBreakdown.past_8w_cy.by_month[monthKey]`.

Report: your top 3 channels by total RN with group/individual split vs ANALYSIS values.

---

### CHECK 9 — Leadtime profile (spot-check 1 month)

Use the same month as CHECK 7. Only use reservations where `leadtime` is non-null and ≥ 0, and `isCancelled` is false.

1. Separate into groups and individuals.
2. For each: sort `leadtime` values, compute median, p25 (25th percentile), p75 (75th percentile).
   For n values sorted ascending: median = value at index round(0.5 × (n−1)), p25 at round(0.25 × (n−1)), p75 at round(0.75 × (n−1)).
3. Compare with `ANALYSIS.leadtimeProfile.past_8w_cy.by_month[monthKey].groups` and `.individuals`.

Report: n for each segment, your median/p25/p75, ANALYSIS values.

---

### CHECK 10 — Cancellation profile (spot-check 1 month)

Pick ONE month key from `ANALYSIS.cancellationProfile.by_month`.

1. Filter `INPUT.historicalReservations` to rows where `arrivalDate` falls in that month (include cancelled).
2. Count total reservations. Count those where `isCancelled` is true → `cancelled`.
3. Compute `rate = cancelled / total × 100`, rounded to 1 decimal.
4. Also compute separately for groups and individuals.
5. Compare with `ANALYSIS.cancellationProfile.by_month[monthKey].cy`.

Report: month, your total, your cancelled count, your overall rate%, your group rate%, your individual rate%, ANALYSIS values and YoY delta.

---

### CHECK 11 — Average price by segment (spot-check 1 month)

Use the same month as CHECK 7. Only non-cancelled reservations where `averagePrice` is non-null and > 0.

1. Separate into groups and individuals.
2. For each: compute weighted average price = `sum(averagePrice × nights) / sum(nights)`.
3. Compare with `ANALYSIS.avgPriceBySegment.past_8w_cy.by_month[monthKey].groups.avg_price` and `.individuals.avg_price`.

Report: your group avg price (and RN count), your individual avg price (and RN count), ANALYSIS values.

---

### Final summary

After completing all checks, produce a summary table:

| Check | Metric | Result | Notes |
|-------|--------|--------|-------|
| 1 | Weekday baselines (2 days) | ✓/✗/⚠ | |
| 2 | Revenue ratios | ✓/✗/⚠ | |
| 3 | Weekly data (3 weeks) | ✓/✗/⚠ | |
| 4 | Recent trend | ✓/✗/⚠ | |
| 5 | Monthly trend | ✓/✗/⚠ | |
| 6 | SVB sanity | ✓/✗/⚠ | |
| 7 | Segmentation | ✓/✗/⚠ | |
| 8 | Channel breakdown | ✓/✗/⚠ | |
| 9 | Leadtime profile | ✓/✗/⚠ | |
| 10 | Cancellation profile | ✓/✗/⚠ | |
| 11 | Average price | ✓/✗/⚠ | |

If any check FAILs, describe the discrepancy precisely and identify the most likely cause (wrong filter, wrong date range, outlier handling, rounding, or logic error in the analysis).
