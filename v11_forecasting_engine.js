/**
 * Hotel Revenue Forecasting System - Module 3: Forecasting Engine (V11)
 *
 * Changes from V10:
 * - REMOVED: daily traditional forecast (forecastSingleDay, all daily-level calculation)
 * - REMOVED: buildWeeklyAiInput() that relied on the daily forecast
 * - ADDED:   generateWeeklyForecast() — algorithm produces 12 weekly room night totals directly
 * - ADDED:   variance per week using SVB from Historical Analysis (no lead-time correction)
 * - ADDED:   weekly revenue estimation via OTB ADR (fallback: historical weekday ADR)
 * - ADDED:   LY fallback estimation when same-week data is missing for the prior year
 * - CHANGED: AI prompt now requests annotations only — no forecast numbers from AI
 *
 * Algorithm per week:
 *   baseline = weightedAvg(LY, 2YA, 3YA+) × recentTrendFactor
 *   forecast = clamp(baseline, otbRoomNights, weekCapacity)
 *   variance = max(5, min(35, SVB × (1 − otbFillRate)))
 *
 * Output: { success, weeklyForecast, recentTrend, monthlyTrend, aiPrompt, warnings, hotelInfo }
 */

class ForecastingEngine {
  constructor(parsedData, historicalAnalysis) {
    this.data     = parsedData;
    this.analysis = historicalAnalysis;
    this.hotelInfo = parsedData.hotelInfo;
    this.warnings  = [];
  }

  /**
   * Main entry point — builds 12-week forecast and AI annotation prompt
   */
  generateWeeklyForecast() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const otbByWeek  = this.buildOtbByWeek();
      const weeks12    = this.get12UpcomingWeeks(today);
      const avgADR     = this.getAvgHistoricalADR();

      const weeklyForecast = weeks12.map(week =>
        this.forecastSingleWeek(week, otbByWeek, avgADR, today)
      );

      const aiPrompt = this.buildAiPrompt(weeklyForecast);

      return {
        success: true,
        weeklyForecast,
        recentTrend:  this.analysis.recentTrend,
        monthlyTrend: this.analysis.monthlyTrend,
        aiPrompt,
        warnings: this.warnings,
        hotelInfo: this.hotelInfo
      };

    } catch (error) {
      return { success: false, error: error.message, warnings: this.warnings };
    }
  }

  // ─── Core weekly forecast ────────────────────────────────────────────────────

  /**
   * Forecast a single ISO week.
   */
  forecastSingleWeek(week, otbByWeek, fallbackADR, today) {
    const { weekKey, weekStart, weekEnd, numDays, forecastableDays, daysUntilWeekStart } = week;

    // ── OTB for this week ──────────────────────────────────────────────────────
    const otb = otbByWeek.get(weekKey) || { roomNights: 0, roomRevenue: 0, totalRevenue: 0 };

    // ── Historical data ────────────────────────────────────────────────────────
    const { historicalByYear, historicalAvg, historicalLY, lyEstimated } =
      this.getHistoricalForWeek(weekKey);

    // ── Capacity ───────────────────────────────────────────────────────────────
    const weekCapacity = numDays * this.hotelInfo.maxRooms;

    // ── Algorithm forecast ─────────────────────────────────────────────────────
    // Apply the recent 4-week YoY trend as a forward-looking growth factor
    const trendFactor   = 1 + ((this.analysis.recentTrend.yoyChangePercent || 0) / 100);
    let   roomNightsFinal = Math.round((historicalAvg || 0) * trendFactor);

    // Clamp: must be at least what is already booked; cannot exceed capacity
    roomNightsFinal = Math.max(otb.roomNights, Math.min(weekCapacity, roomNightsFinal));

    // ── Revenue ────────────────────────────────────────────────────────────────
    const pickup = Math.max(0, roomNightsFinal - otb.roomNights);

    // Use OTB ADR when enough bookings exist; fall back to weekday average otherwise
    const weekADR       = otb.roomNights >= 10
      ? otb.roomRevenue / otb.roomNights
      : fallbackADR;

    const estRoomRevenue  = otb.roomRevenue + pickup * weekADR;
    const fbRatio         = this.analysis.revenueRatios.overallFBRatio    || 0;
    const otherRatio      = this.analysis.revenueRatios.overallOtherRatio || 0;
    const estFBRevenue    = estRoomRevenue * fbRatio;
    const estOtherRevenue = estRoomRevenue * otherRatio;
    const estTotalRevenue = estRoomRevenue + estFBRevenue + estOtherRevenue;

    // ── Variance ───────────────────────────────────────────────────────────────
    // SVB: Seasonal Volatility Baseline for this week number (±2 neighbors, normalized)
    const wnKey       = `W${weekKey.split('-W')[1]}`;
    const svb         = (this.analysis.svbByWeek || {})[wnKey] || 15;
    const otbFillRate = roomNightsFinal > 0 ? otb.roomNights / roomNightsFinal : 0;
    const variancePct = Math.max(5, Math.min(35, svb * (1 - otbFillRate)));

    // ── YoY vs last year ───────────────────────────────────────────────────────
    let yoyVsLYPct = null;
    if (historicalLY > 0) {
      yoyVsLYPct = parseFloat(((roomNightsFinal - historicalLY) / historicalLY * 100).toFixed(1));
    }

    // ── Events ────────────────────────────────────────────────────────────────
    const events = this.getEventsForDateRange(weekStart, weekEnd);

    return {
      weekKey,
      weekStart:  weekStart.toISOString().split('T')[0],
      weekEnd:    weekEnd.toISOString().split('T')[0],
      numDays,
      daysUntilWeekStart,

      roomNightsFinal,
      otbRoomNights: otb.roomNights,
      pickup,
      capacity:     weekCapacity,
      occupancyPct: parseFloat((roomNightsFinal / weekCapacity * 100).toFixed(1)),

      otbADR:        otb.roomNights >= 10 ? parseFloat(weekADR.toFixed(2)) : null,
      estRoomRevenue:  Math.round(estRoomRevenue),
      estFBRevenue:    Math.round(estFBRevenue),
      estOtherRevenue: Math.round(estOtherRevenue),
      estTotalRevenue: Math.round(estTotalRevenue),

      historicalByYear,
      historicalAvg:   Math.round(historicalAvg || 0),
      historicalLY:    historicalLY ? Math.round(historicalLY) : null,
      lyEstimated,
      yoyVsLYPct,

      variancePct:       Math.round(variancePct),
      forecastRangeLow:  Math.round(roomNightsFinal * (1 - variancePct / 100)),
      forecastRangeHigh: Math.min(weekCapacity, Math.round(roomNightsFinal * (1 + variancePct / 100))),

      // Partial week metadata (current week only)
      isPartialWeek: forecastableDays < 7,
      daysElapsed:   7 - forecastableDays,

      events
    };
  }

  // ─── Historical lookup with LY fallback ─────────────────────────────────────

  /**
   * For a given forecast week key (e.g. "2026-W14"), look up actual room nights
   * from the same ISO week in previous years.
   *
   * If last year's data is missing, estimate it using:
   *   1. The year-over-year growth rate between 2YA and 3YA (same week)
   *   2. Fallback: monthly trend YoY% applied to 2YA value
   *
   * Returns weighted average biased towards more recent years.
   */
  getHistoricalForWeek(weekKey) {
    const weekly = this.analysis.weeklyHistoricalData || {};
    const [yearStr, wnStr] = weekKey.split('-W');
    const currentYear = parseInt(yearStr);

    const historicalByYear = {};
    const lyYear   = currentYear - 1;
    const twoYA    = currentYear - 2;
    const threeYA  = currentYear - 3;
    const fourYA   = currentYear - 4;

    // Collect all available historical years for this week
    [lyYear, twoYA, threeYA, fourYA].forEach(yr => {
      const key = `${yr}-W${wnStr}`;
      if (weekly[key]) historicalByYear[yr] = weekly[key].roomNights;
    });

    // ── Estimate LY if missing ─────────────────────────────────────────────────
    let lyEstimated = false;
    let historicalLY = historicalByYear[lyYear] || null;

    if (!historicalLY && historicalByYear[twoYA]) {
      const twoYAval   = historicalByYear[twoYA];
      const threeYAval = historicalByYear[threeYA];

      let growthRate;
      if (threeYAval && threeYAval > 0) {
        // Use observed growth from 3YA → 2YA as proxy for 2YA → LY
        growthRate = (twoYAval - threeYAval) / threeYAval;
      } else {
        // No 3YA data — fall back to monthly trend as growth proxy
        growthRate = (this.analysis.monthlyTrend.yoyChangePercent || 0) / 100;
      }

      historicalLY = Math.round(twoYAval * (1 + growthRate));
      historicalByYear[lyYear] = historicalLY;
      lyEstimated = true;

      this.warnings.push(
        `INFO: ${weekKey} — LY (${lyYear}) data missing. Estimated as ${historicalLY} RN ` +
        `using ${threeYAval ? 'year-over-year growth' : 'monthly trend'} from ${twoYA}.`
      );
    }

    // ── Weighted average (most recent year = highest weight) ───────────────────
    const sortedYears = Object.entries(historicalByYear)
      .map(([yr, rn]) => ({ yr: parseInt(yr), rn }))
      .sort((a, b) => b.yr - a.yr); // newest first

    let weightedSum = 0, totalWeight = 0;
    sortedYears.forEach(({ rn }, i) => {
      const weight = sortedYears.length - i; // LY gets weight N, oldest gets weight 1
      weightedSum  += rn * weight;
      totalWeight  += weight;
    });

    const historicalAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;

    if (sortedYears.length === 0) {
      this.warnings.push(`WARNING: No historical data found for ${weekKey}. Forecast will rely on OTB only.`);
    }

    return { historicalByYear, historicalAvg, historicalLY, lyEstimated };
  }

  // ─── Week building helpers ───────────────────────────────────────────────────

  /**
   * Returns the 12 upcoming ISO weeks starting from the current week (inclusive).
   * numDays reflects how many days are still in the current week (from today).
   */
  get12UpcomingWeeks(today) {
    // Monday of the current ISO week
    const dow = today.getDay() || 7; // 1=Mon … 7=Sun
    const currentWeekMonday = new Date(today);
    currentWeekMonday.setDate(today.getDate() - dow + 1);

    const weeks = [];
    for (let i = 0; i < 12; i++) {
      const weekStart = new Date(currentWeekMonday);
      weekStart.setDate(weekStart.getDate() + i * 7);

      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6); // Sunday

      // numDays is always 7 — capacity and occupancy are on full-week basis so
      // that OTB (which covers the full week) and historical LY are comparable.
      // forecastableDays tracks remaining days for internal pickup logic only.
      const numDays = 7;
      const forecastableDays = (i === 0)
        ? Math.max(1, 7 - dow + 1)  // remaining days incl. today
        : 7;

      const daysUntilWeekStart = Math.round((weekStart - today) / (1000 * 60 * 60 * 24));

      weeks.push({
        weekKey: this.getIsoWeekKey(weekStart),
        weekStart,
        weekEnd,
        numDays,
        forecastableDays,
        daysUntilWeekStart
      });
    }
    return weeks;
  }

  /**
   * Group current housestate (OTB) by ISO week.
   */
  buildOtbByWeek() {
    const map = new Map();
    (this.data.currentHousestate || []).forEach(day => {
      const wk = this.getIsoWeekKey(new Date(day.date));
      if (!map.has(wk)) map.set(wk, { roomNights: 0, roomRevenue: 0, totalRevenue: 0 });
      const w = map.get(wk);
      w.roomNights   += (day.roomNights   || 0);
      w.roomRevenue  += (day.roomRevenue  || 0);
      w.totalRevenue += (day.totalRevenue || 0);
    });
    return map;
  }

  /**
   * Average historical ADR across all weekdays — used as fallback when OTB is thin.
   */
  getAvgHistoricalADR() {
    const baselines = this.analysis.weekdayBaselines || {};
    const adrs = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
      .map(wd => baselines[wd]?.historicalADR || 0)
      .filter(v => v > 0);
    return adrs.length > 0 ? adrs.reduce((s, v) => s + v, 0) / adrs.length : 0;
  }

  // ─── AI prompt (annotations only) ───────────────────────────────────────────

  /**
   * Build the prompt sent to the AI node.
   * The AI's job is to annotate the forecast — not to produce or change the numbers.
   */
  buildAiPrompt(weeklyForecast) {
    const hotel   = this.hotelInfo;
    const recent  = this.analysis.recentTrend  || {};
    const monthly = this.analysis.monthlyTrend || {};

    const fmt = (pct) => (pct >= 0 ? `+${pct}%` : `${pct}%`);

    const weekLines = weeklyForecast.map(w => {
      const paceStr  = w.daysUntilWeekStart <= 0
        ? '[current week]'
        : `${w.daysUntilWeekStart} days out`;

      const histStr  = Object.entries(w.historicalByYear)
        .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
        .map(([yr, rn]) => `${yr}: ${rn}${w.lyEstimated && parseInt(yr) === parseInt(w.weekKey.split('-')[0]) - 1 ? ' (est)' : ''}`)
        .join(' | ');

      const lyStr   = w.historicalLY
        ? `${w.historicalLY}${w.lyEstimated ? ' (est)' : ''}`
        : 'n/a';

      const yoyStr  = w.yoyVsLYPct != null ? ` | YoY vs LY: ${fmt(w.yoyVsLYPct)}` : '';

      const eventStr = w.events.length > 0
        ? `Events: ${w.events.map(e => `${e.name} (+${e.pickupImpact} RN)`).join(', ')}`
        : 'No events';

      return (
        `Week ${w.weekKey} (${w.weekStart}–${w.weekEnd}, ${paceStr})\n` +
        `  Forecast: ${w.roomNightsFinal} RN | OTB: ${w.otbRoomNights} | Capacity: ${w.capacity} | Occ: ${w.occupancyPct}%\n` +
        `  History: ${histStr || 'no data'} | Avg: ${w.historicalAvg} RN | LY: ${lyStr}${yoyStr}\n` +
        `  Variance: ±${w.variancePct}% (${w.forecastRangeLow}–${w.forecastRangeHigh} RN) | ${eventStr}`
      );
    }).join('\n\n');

    return (
      `You are a hotel revenue forecasting analyst. An algorithm has already produced the weekly forecast below.\n` +
      `Your role is to annotate this forecast with context and analysis — do NOT suggest changes to any numbers.\n\n` +
      `Hotel: ${hotel.hotelName || 'Hotel'} (${hotel.hotelType || 'hotel'}, max ${hotel.maxRooms} rooms/night)\n\n` +
      `RECENT BOOKING TREND:\n` +
      `- Last 4 weeks vs same period last year: ${fmt(recent.yoyChangePercent || 0)} ` +
        `(${recent.last4WeeksActual || 0} RN vs ${recent.last4WeeksSameLastYear || 0} RN LY)\n` +
      `- ${monthly.monthName || 'Previous month'} vs same month last year: ${fmt(monthly.yoyChangePercent || 0)} ` +
        `(${monthly.previousMonthActual || 0} RN vs ${monthly.previousMonthLastYear || 0} RN LY)\n\n` +
      `WEEKLY FORECAST (algorithm output — do not adjust):\n${weekLines}\n\n` +
      `Respond with ONLY valid JSON:\n` +
      `{\n` +
      `  "weekNotes": [\n` +
      `    { "weekKey": "YYYY-WNN", "notes": ["observation 1", "observation 2"] }\n` +
      `  ],\n` +
      `  "deviationSignals": ["signal 1", "signal 2"],\n` +
      `  "conclusions": ["conclusion 1", "conclusion 2"]\n` +
      `}\n\n` +
      `Guidelines:\n` +
      `- weekNotes: only include weeks with noteworthy observations (1–3 notes each). Flag unusual OTB ` +
        `momentum relative to LY, event impact, high variance (>20%), or significant YoY deviation.\n` +
      `- deviationSignals: identify cross-week patterns suggesting the forecast may systematically ` +
        `over- or underperform actual results.\n` +
      `- conclusions: 2–4 strategic observations about the overall 12-week outlook. Be specific and concise.`
    );
  }

  // ─── Utility helpers ─────────────────────────────────────────────────────────

  getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dow);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wn = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;
  }

  getEventsForDateRange(startDate, endDate) {
    const events = this.data.events || [];
    return events
      .filter(event => {
        const s = event.startDate ? new Date(event.startDate) : null;
        const e = event.endDate   ? new Date(event.endDate)   : null;
        return s && e && s <= endDate && e >= startDate;
      })
      .map(event => ({ name: event.eventName || 'Event', pickupImpact: event.pickupImpact || 0 }));
  }
}

// ============ N8N EXECUTION CODE ============
const input      = $input.first().json;
const forecaster = new ForecastingEngine(input.parseResult.data, input.analysisResult.analysis);
const result     = forecaster.generateWeeklyForecast();

if (!result.success) {
  console.error('❌ FORECAST FAILED:', result.error);
  throw new Error('Forecast generation failed: ' + result.error);
}

const totalRN  = result.weeklyForecast.reduce((s, w) => s + w.roomNightsFinal, 0);
const totalRev = result.weeklyForecast.reduce((s, w) => s + w.estTotalRevenue, 0);
console.log(`✅ Forecast V11: ${result.weeklyForecast.length} weeks | ${totalRN} RN total | €${totalRev.toFixed(0)} est. revenue`);

return [{ json: result }];
