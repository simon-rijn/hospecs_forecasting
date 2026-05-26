// Historical Analysis v0.12 — 2026-05-18
/**
 * Hotel Revenue Forecasting System - Module 2: Historical Analysis Engine (V11)
 *
 * Changes from V10:
 * - ADDED: calculateWeeklyHistoricalData() — aggregates daily housestate into weekly totals per ISO week
 * - ADDED: calculateSVBByWeek() — Seasonal Volatility Baseline using ±2 neighboring weeks, normalized
 * - ADDED: calculateRecentTrend() — last 4 completed weeks vs same 4 weeks last year (YoY%)
 * - ADDED: calculateMonthlyTrend() — previous complete calendar month vs same month last year (YoY%)
 * - KEPT:  calculateWeekdayBaselines() — weekday averages used for ADR fallback in forecasting engine
 * - KEPT:  calculateRevenueRatios() — F&B and Other ratios used for weekly revenue estimation
 *
 * Output adds to analysis object:
 *   weeklyHistoricalData  — { "2025-W14": { roomNights, roomRevenue, totalRevenue, days }, ... }
 *   svbByWeek             — { "W14": 8.5, ... }  (% seasonal volatility per ISO week number)
 *   recentTrend           — { last4WeeksActual, last4WeeksSameLastYear, yoyChangePercent, weeksAnalyzed }
 *   monthlyTrend          — { previousMonthActual, previousMonthLastYear, yoyChangePercent, monthName }
 */

class HistoricalAnalysisEngine {
  constructor(parsedData) {
    this.data = parsedData;
    this.analysis = {};
    this.warnings = [];
  }

  /**
   * Main analysis orchestrator
   */
  runAllAnalysis() {
    try {
      // Housestate-based baselines (used for ADR fallback and revenue ratios)
      this.analysis.weekdayBaselines     = this.calculateWeekdayBaselines();
      this.analysis.revenueRatios        = this.calculateRevenueRatios();
      this.analysis.weeklyHistoricalData = this.calculateWeeklyHistoricalData();
      this.analysis.svbByWeek            = this.calculateSVBByWeek(this.analysis.weeklyHistoricalData);
      this.analysis.recentTrend          = this.calculateRecentTrend(this.analysis.weeklyHistoricalData);
      this.analysis.monthlyTrend         = this.calculateMonthlyTrend();

      // Reservation-based analyses (gracefully returns null when data is absent)
      this.analysis.segmentation        = this.computeSegmentation();
      this.analysis.channelBreakdown    = this.computeChannelBreakdown();
      this.analysis.leadtimeProfile     = this.computeLeadtimeProfile();
      this.analysis.cancellationProfile = this.computeCancellationProfile();
      this.analysis.avgPriceBySegment   = this.computeAvgPriceBySegment();

      return {
        success: true,
        analysis: this.analysis,
        reservationsDataFreshness: this.data.reservationsDataFreshness || 'current',
        warnings: this.warnings
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        warnings: this.warnings
      };
    }
  }

  // ─── ISO week helper ────────────────────────────────────────────────────────

  getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dow);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wn = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;
  }

  // ─── Reservation analysis helpers ───────────────────────────────────────────

  /** Returns "YYYY-MM" for a given Date */
  getMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Returns "YYYY-MM" for the month that contains the Thursday of a given ISO week key.
   * Consistent with the Thursday-rule used in Layer 2 Prompt Builder.
   */
  getMonthKeyFromWeekKey(weekKey) {
    const [yearStr, wnStr] = weekKey.split('-W');
    const year = parseInt(yearStr);
    const wn   = parseInt(wnStr);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dow  = jan4.getUTCDay() || 7;
    const w1Monday = new Date(jan4);
    w1Monday.setUTCDate(jan4.getUTCDate() - dow + 1);
    const weekMonday = new Date(w1Monday);
    weekMonday.setUTCDate(w1Monday.getUTCDate() + (wn - 1) * 7);
    const thursday = new Date(weekMonday);
    thursday.setUTCDate(weekMonday.getUTCDate() + 3);
    return `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Returns the Date of Monday for the current ISO week */
  getCurrentWeekMonday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay() || 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() - dow + 1);
    return monday;
  }

  /**
   * Returns an array of n ISO week keys ending just before referenceMonday (oldest → newest).
   * These are the n completed weeks immediately preceding the current week.
   */
  getPastWeekKeys(n, referenceMonday) {
    const keys = [];
    for (let i = n; i >= 1; i--) {
      const monday = new Date(referenceMonday);
      monday.setDate(monday.getDate() - i * 7);
      keys.push(this.getIsoWeekKey(monday));
    }
    return keys;
  }

  /**
   * Returns an array of n ISO week keys starting from referenceMonday (oldest → newest).
   * Used for the OTB / future window.
   */
  getFutureWeekKeys(n, referenceMonday) {
    const keys = [];
    for (let i = 0; i < n; i++) {
      const monday = new Date(referenceMonday);
      monday.setDate(monday.getDate() + i * 7);
      keys.push(this.getIsoWeekKey(monday));
    }
    return keys;
  }

  /** Shifts an array of ISO week keys one year back ("2025-W14" → "2024-W14") */
  toLYWeekKeys(weekKeys) {
    return weekKeys.map(key => {
      const [yearStr, wnStr] = key.split('-W');
      return `${parseInt(yearStr) - 1}-W${wnStr}`;
    });
  }

  /**
   * A reservation is a group booking when group_name is set AND does not start with "IDS".
   * IDS-prefixed names are individual bookings routed via an IDS channel.
   */
  isGroup(res) {
    return res.groupName != null && !String(res.groupName).startsWith('IDS');
  }

  /** A reservation is cancelled when cancelledAt is non-null */
  isCancelled(res) {
    return res.cancelledAt != null;
  }

  // ─── Existing methods (kept from V10) ───────────────────────────────────────

  getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / (1000 * 60 * 60 * 24));
  }

  getForecastCalendarWindow() {
    const otbData = this.data.currentHousestate;
    if (!otbData || otbData.length === 0) {
      throw new Error('CRITICAL: No current housestate data. Cannot determine forecast window.');
    }
    const firstDate = new Date(otbData[0].date);
    const lastDate  = new Date(otbData[otbData.length - 1].date);
    return {
      minDoy: this.getDayOfYear(firstDate) - 28,
      maxDoy: this.getDayOfYear(lastDate)  + 28
    };
  }

  filterToCalendarPeriod(historicalData) {
    const { minDoy, maxDoy } = this.getForecastCalendarWindow();
    return historicalData.filter(day => {
      if (day.isOutlier) return false;
      const doy = this.getDayOfYear(new Date(day.date));
      if (minDoy <= 0)    return doy >= (minDoy + 365) || doy <= maxDoy;
      if (maxDoy > 365)   return doy >= minDoy || doy <= (maxDoy - 365);
      return doy >= minDoy && doy <= maxDoy;
    });
  }

  calculateWeekdayBaselines() {
    const historicalData = this.data.historicalHousestate;
    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data. Cannot calculate baselines.');
    }
    const filteredData = this.filterToCalendarPeriod(historicalData);
    if (filteredData.length === 0) {
      throw new Error('CRITICAL: No historical data found in calendar window.');
    }
    if (filteredData.length < 30) {
      this.warnings.push(`WARNING: Only ${filteredData.length} days in calendar window (recommended 30+).`);
    }

    const groups = {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [],
      Friday: [], Saturday: [], Sunday: []
    };
    filteredData.forEach(day => {
      if (groups[day.weekday]) {
        groups[day.weekday].push({
          roomNights: day.roomNights,
          roomRevenue: day.roomRevenue,
          totalRevenue: day.totalRevenue
        });
      }
    });

    const baselines = {};
    const missing = [];
    Object.keys(groups).forEach(wd => {
      const days = groups[wd];
      if (days.length === 0) { missing.push(wd); return; }
      const avgRN  = days.reduce((s, d) => s + d.roomNights, 0)    / days.length;
      const avgRR  = days.reduce((s, d) => s + d.roomRevenue, 0)   / days.length;
      const avgTR  = days.reduce((s, d) => s + d.totalRevenue, 0)  / days.length;
      baselines[wd] = {
        historicalAvgRoomNights: avgRN,
        historicalAvgRoomRevenue: avgRR,
        historicalAvgTotalRevenue: avgTR,
        historicalADR: avgRN > 0 ? avgRR / avgRN : 0,
        sampleSize: days.length
      };
      if (days.length < 6) {
        this.warnings.push(`WARNING: ${wd} baseline has only ${days.length} samples (recommended 6+).`);
      }
    });

    if (missing.length > 0) {
      throw new Error(`CRITICAL: Missing historical data for weekdays: ${missing.join(', ')}.`);
    }
    baselines._metadata = { daysIncluded: filteredData.length };
    return baselines;
  }

  calculateRevenueRatios() {
    const historicalData = this.data.historicalHousestate;
    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data. Cannot calculate revenue ratios.');
    }
    const filteredData = this.filterToCalendarPeriod(historicalData);
    const validDays    = filteredData.filter(d => d.roomRevenue > 0 && d.totalRevenue > 0);
    if (validDays.length === 0) {
      throw new Error('CRITICAL: No valid revenue data in calendar window.');
    }

    const hasFBData    = validDays.some(d => d.fbRevenue != null);
    const hasOtherData = validDays.some(d => d.otherRevenue != null);

    const totalRoomRev  = validDays.reduce((s, d) => s + d.roomRevenue, 0);
    const totalTotalRev = validDays.reduce((s, d) => s + d.totalRevenue, 0);
    const overallTotalRatio = totalTotalRev / totalRoomRev;

    let overallFBRatio, overallOtherRatio;
    if (hasFBData && hasOtherData) {
      overallFBRatio    = validDays.reduce((s, d) => s + (d.fbRevenue || 0), 0) / totalRoomRev;
      overallOtherRatio = validDays.reduce((s, d) => s + (d.otherRevenue || 0), 0) / totalRoomRev;
    } else {
      overallFBRatio    = 0;
      overallOtherRatio = overallTotalRatio - 1;
      this.warnings.push('WARNING: No F&B data found. All non-room revenue treated as Other Revenue.');
    }

    const weekdayRatios = {};
    ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].forEach(wd => {
      const wkDays = validDays.filter(d => d.weekday === wd);
      if (wkDays.length === 0) {
        weekdayRatios[wd] = { totalRatio: overallTotalRatio, fbRatio: overallFBRatio, otherRatio: overallOtherRatio };
        this.warnings.push(`WARNING: No revenue data for ${wd}. Using overall ratios.`);
        return;
      }
      const wkRoomRev  = wkDays.reduce((s, d) => s + d.roomRevenue, 0);
      const wkTotalRev = wkDays.reduce((s, d) => s + d.totalRevenue, 0);
      if (hasFBData && hasOtherData) {
        weekdayRatios[wd] = {
          totalRatio: wkTotalRev / wkRoomRev,
          fbRatio:    wkDays.reduce((s, d) => s + (d.fbRevenue || 0), 0) / wkRoomRev,
          otherRatio: wkDays.reduce((s, d) => s + (d.otherRevenue || 0), 0) / wkRoomRev
        };
      } else {
        const r = wkTotalRev / wkRoomRev;
        weekdayRatios[wd] = { totalRatio: r, fbRatio: 0, otherRatio: r - 1 };
      }
    });

    return { overallTotalRatio, overallFBRatio, overallOtherRatio, weekdayRatios, hasFBData };
  }

  // ─── New V11 methods ─────────────────────────────────────────────────────────

  /**
   * Aggregate daily historical housestate into weekly totals.
   * Only includes weeks with 5+ days of data (avoids partial-week bias at dataset edges).
   * Returns: { "2025-W14": { roomNights, roomRevenue, totalRevenue, days }, ... }
   */
  calculateWeeklyHistoricalData() {
    const historicalData = this.data.historicalHousestate;
    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data for weekly aggregation.');
    }

    const weekly = {};

    historicalData.forEach(day => {
      if (!day.date || day.isOutlier) return;
      const weekKey = this.getIsoWeekKey(new Date(day.date));
      if (!weekly[weekKey]) {
        weekly[weekKey] = { roomNights: 0, roomRevenue: 0, totalRevenue: 0, days: 0 };
      }
      weekly[weekKey].roomNights   += (day.roomNights   || 0);
      weekly[weekKey].roomRevenue  += (day.roomRevenue  || 0);
      weekly[weekKey].totalRevenue += (day.totalRevenue || 0);
      weekly[weekKey].days++;
    });

    // Drop partial weeks (< 5 days) at the boundaries of the dataset
    let dropped = 0;
    Object.keys(weekly).forEach(key => {
      if (weekly[key].days < 5) { delete weekly[key]; dropped++; }
    });
    if (dropped > 0) {
      this.warnings.push(`INFO: ${dropped} partial week(s) excluded from weekly historical data.`);
    }

    const weekCount = Object.keys(weekly).length;
    if (weekCount < 52) {
      this.warnings.push(`WARNING: Only ${weekCount} complete historical weeks available (recommended 104+).`);
    }

    return weekly;
  }

  /**
   * Seasonal Volatility Baseline (SVB) per ISO week number.
   *
   * For each week number W (1–53):
   *   1. Gather historical room nights for W-2, W-1, W, W+1, W+2 across all available years
   *   2. Normalize each value: (actual - weekAvg) / weekAvg  → removes scale differences between weeks
   *   3. SVB = stddev of all normalized deviations × 100  (expressed as %)
   *
   * With ±2 neighbors and 2-3 years of data this gives ~10-15 data points per week number —
   * enough for a statistically meaningful variance estimate.
   *
   * Returns: { "W01": 12.3, "W14": 8.5, ... }  (default 15% if < 3 data points)
   */
  calculateSVBByWeek(weeklyHistoricalData) {
    // Build weekNumber → [roomNights values] map (across all years)
    const wnToValues = {};
    Object.entries(weeklyHistoricalData).forEach(([key, data]) => {
      const wn = parseInt(key.split('-W')[1]);
      if (!wnToValues[wn]) wnToValues[wn] = [];
      wnToValues[wn].push(data.roomNights);
    });

    const svb = {};

    for (let wn = 1; wn <= 53; wn++) {
      const normalized = [];

      // Gather ±2 neighbors
      for (let offset = -2; offset <= 2; offset++) {
        let neighbor = wn + offset;
        if (neighbor < 1)  neighbor += 52;
        if (neighbor > 52) neighbor -= 52;

        const values = wnToValues[neighbor] || [];
        if (values.length < 2) continue; // need at least 2 points to normalize

        const avg = values.reduce((s, v) => s + v, 0) / values.length;
        if (avg <= 0) continue;

        values.forEach(v => normalized.push((v - avg) / avg));
      }

      const key = `W${String(wn).padStart(2, '0')}`;

      if (normalized.length >= 3) {
        const mean     = normalized.reduce((s, v) => s + v, 0) / normalized.length;
        const variance = normalized.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / normalized.length;
        svb[key] = parseFloat((Math.sqrt(variance) * 100).toFixed(1));
      } else {
        svb[key] = 15.0; // conservative default when data is sparse
      }
    }

    return svb;
  }

  /**
   * Recent booking trend: last 4 completed ISO weeks vs same 4 weeks last year.
   * "Last 4 completed" = the 4 ISO weeks immediately before the current (in-progress) week.
   *
   * Returns: { last4WeeksActual, last4WeeksSameLastYear, yoyChangePercent, weeksAnalyzed }
   */
  calculateRecentTrend(weeklyHistoricalData) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Monday of the current ISO week
    const dow = today.getDay() || 7; // 1=Mon … 7=Sun
    const currentWeekMonday = new Date(today);
    currentWeekMonday.setDate(today.getDate() - dow + 1);

    // Collect the 4 completed weeks before the current week
    const recentWeekKeys = [];
    for (let i = 1; i <= 4; i++) {
      const monday = new Date(currentWeekMonday);
      monday.setDate(monday.getDate() - i * 7);
      recentWeekKeys.push(this.getIsoWeekKey(monday));
    }

    let last4Actual = 0;
    let last4LY     = 0;
    let weeksAnalyzed = 0;

    recentWeekKeys.forEach(weekKey => {
      const actual = weeklyHistoricalData[weekKey];
      if (actual) {
        last4Actual += actual.roomNights;
        weeksAnalyzed++;
      }

      // Same week last year
      const [yearStr, wnStr] = weekKey.split('-W');
      const lyKey = `${parseInt(yearStr) - 1}-W${wnStr}`;
      const ly = weeklyHistoricalData[lyKey];
      if (ly) last4LY += ly.roomNights;
    });

    if (weeksAnalyzed < 2) {
      this.warnings.push('WARNING: Less than 2 completed weeks found for recent trend calculation. Trend may be unreliable.');
    }

    const yoyChangePercent = last4LY > 0
      ? parseFloat(((last4Actual - last4LY) / last4LY * 100).toFixed(1))
      : 0;

    return { last4WeeksActual: last4Actual, last4WeeksSameLastYear: last4LY, yoyChangePercent, weeksAnalyzed };
  }

  /**
   * Monthly trend: previous complete calendar month vs same month last year.
   *
   * Returns: { previousMonthActual, previousMonthLastYear, yoyChangePercent, monthName }
   */
  calculateMonthlyTrend() {
    const historicalData = this.data.historicalHousestate;
    const today = new Date();

    // Previous complete month boundaries
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0);    // last day

    // Same month last year
    const lyMonthStart = new Date(today.getFullYear() - 1, today.getMonth() - 1, 1);
    const lyMonthEnd   = new Date(today.getFullYear() - 1, today.getMonth(), 0);

    let prevMonthActual = 0;
    let prevMonthLY     = 0;

    historicalData.forEach(day => {
      if (!day.date || day.isOutlier) return;
      const d = new Date(day.date);

      if (d >= prevMonthStart && d <= prevMonthEnd) {
        prevMonthActual += (day.roomNights || 0);
      }
      if (d >= lyMonthStart && d <= lyMonthEnd) {
        prevMonthLY += (day.roomNights || 0);
      }
    });

    const monthNames = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];

    const yoyChangePercent = prevMonthLY > 0
      ? parseFloat(((prevMonthActual - prevMonthLY) / prevMonthLY * 100).toFixed(1))
      : 0;

    if (prevMonthActual === 0) {
      this.warnings.push(`WARNING: No historical data found for previous month (${monthNames[prevMonthStart.getMonth()]}). Monthly trend unavailable.`);
    }

    return {
      previousMonthActual: prevMonthActual,
      previousMonthLastYear: prevMonthLY,
      yoyChangePercent,
      monthName: monthNames[prevMonthStart.getMonth()]
    };
  }
  // ─── Reservation-based analyses (new V11) ───────────────────────────────────

  /**
   * Segmentation: group vs individual room nights.
   *
   * Four windows — past 8 completed weeks CY, same weeks LY,
   * next 12 OTB weeks CY, same weeks LY — each on week + month granularity.
   * Cancelled reservations are excluded from all windows.
   */
  computeSegmentation() {
    const reservations = this.data.historicalReservations;
    if (!reservations || reservations.length === 0) {
      this.warnings.push('WARNING: No reservation data for segmentation analysis.');
      return null;
    }

    const currentMonday = this.getCurrentWeekMonday();
    const past8CY  = this.getPastWeekKeys(8, currentMonday);
    const past8LY  = this.toLYWeekKeys(past8CY);
    const otb12CY  = this.getFutureWeekKeys(12, currentMonday);
    const otb12LY  = this.toLYWeekKeys(otb12CY);

    const windows = {
      past_8w_cy: new Set(past8CY),
      past_8w_ly: new Set(past8LY),
      otb_12w_cy: new Set(otb12CY),
      otb_12w_ly: new Set(otb12LY)
    };

    // Initialise per-week accumulators
    const accum = {};
    for (const [win, keySet] of Object.entries(windows)) {
      accum[win] = { by_week: {}, by_month: {} };
      for (const k of keySet) {
        accum[win].by_week[k] = { groups: { rn: 0 }, individuals: { rn: 0 } };
      }
    }

    for (const res of reservations) {
      if (!res.arrivalDate || this.isCancelled(res)) continue;
      const arrDate  = new Date(res.arrivalDate);
      const weekKey  = this.getIsoWeekKey(arrDate);
      const monthKey = this.getMonthKey(arrDate);
      const nights   = res.nights || 0;
      const seg      = this.isGroup(res) ? 'groups' : 'individuals';

      for (const [win, keySet] of Object.entries(windows)) {
        if (!keySet.has(weekKey)) continue;
        accum[win].by_week[weekKey][seg].rn += nights;
        if (!accum[win].by_month[monthKey]) {
          accum[win].by_month[monthKey] = { groups: { rn: 0 }, individuals: { rn: 0 } };
        }
        accum[win].by_month[monthKey][seg].rn += nights;
      }
    }

    // Add percentages
    for (const winData of Object.values(accum)) {
      for (const cells of [winData.by_week, winData.by_month]) {
        for (const cell of Object.values(cells)) {
          const total = cell.groups.rn + cell.individuals.rn;
          cell.groups.pct      = total > 0 ? parseFloat((cell.groups.rn / total * 100).toFixed(1)) : 0;
          cell.individuals.pct = total > 0 ? parseFloat((cell.individuals.rn / total * 100).toFixed(1)) : 0;
        }
      }
    }

    return accum;
  }

  /**
   * Channel breakdown: room nights per channel, split by group / individual.
   *
   * Same four windows as computeSegmentation().
   * Channel value taken as-is from source data (no normalisation).
   */
  computeChannelBreakdown() {
    const reservations = this.data.historicalReservations;
    if (!reservations || reservations.length === 0) {
      this.warnings.push('WARNING: No reservation data for channel breakdown.');
      return null;
    }

    const currentMonday = this.getCurrentWeekMonday();
    const windows = {
      past_8w_cy: new Set(this.getPastWeekKeys(8, currentMonday)),
      past_8w_ly: new Set(this.toLYWeekKeys(this.getPastWeekKeys(8, currentMonday))),
      otb_12w_cy: new Set(this.getFutureWeekKeys(12, currentMonday)),
      otb_12w_ly: new Set(this.toLYWeekKeys(this.getFutureWeekKeys(12, currentMonday)))
    };

    const accum = {};
    for (const [win, keySet] of Object.entries(windows)) {
      accum[win] = { by_week: {}, by_month: {} };
      for (const k of keySet) {
        accum[win].by_week[k] = { groups: {}, individuals: {} };
      }
    }

    for (const res of reservations) {
      if (!res.arrivalDate || this.isCancelled(res)) continue;
      const arrDate  = new Date(res.arrivalDate);
      const weekKey  = this.getIsoWeekKey(arrDate);
      const monthKey = this.getMonthKey(arrDate);
      const nights   = res.nights || 0;
      const channel  = res.channel || 'onbekend';
      const seg      = this.isGroup(res) ? 'groups' : 'individuals';

      for (const [win, keySet] of Object.entries(windows)) {
        if (!keySet.has(weekKey)) continue;
        accum[win].by_week[weekKey][seg][channel] = (accum[win].by_week[weekKey][seg][channel] || 0) + nights;
        if (!accum[win].by_month[monthKey]) {
          accum[win].by_month[monthKey] = { groups: {}, individuals: {} };
        }
        accum[win].by_month[monthKey][seg][channel] = (accum[win].by_month[monthKey][seg][channel] || 0) + nights;
      }
    }

    return accum;
  }

  /**
   * Leadtime profile: how many days in advance bookings are made.
   *
   * Past 8 completed weeks CY + LY only (OTB leadtime is not meaningful).
   * Outputs median / p25 / p75 per cell, split by group / individual.
   * Uses the pre-calculated `leadtime` field (days between created_at and arrival_date).
   */
  computeLeadtimeProfile() {
    const reservations = this.data.historicalReservations;
    if (!reservations || reservations.length === 0) {
      this.warnings.push('WARNING: No reservation data for leadtime analysis.');
      return null;
    }

    const currentMonday = this.getCurrentWeekMonday();
    const past8CY = this.getPastWeekKeys(8, currentMonday);
    const past8LY = this.toLYWeekKeys(past8CY);

    const windows = {
      past_8w_cy: new Set(past8CY),
      past_8w_ly: new Set(past8LY)
    };

    // Accumulators hold arrays of leadtime values
    const accum = {};
    for (const [win, keySet] of Object.entries(windows)) {
      accum[win] = { by_week: {}, by_month: {} };
      for (const k of keySet) {
        accum[win].by_week[k] = { groups: [], individuals: [] };
      }
    }

    for (const res of reservations) {
      if (!res.arrivalDate || this.isCancelled(res)) continue;
      const lt = res.leadtime ?? null;
      if (lt == null || lt < 0) continue;

      const arrDate  = new Date(res.arrivalDate);
      const weekKey  = this.getIsoWeekKey(arrDate);
      const monthKey = this.getMonthKey(arrDate);
      const seg      = this.isGroup(res) ? 'groups' : 'individuals';

      for (const [win, keySet] of Object.entries(windows)) {
        if (!keySet.has(weekKey)) continue;
        accum[win].by_week[weekKey][seg].push(lt);
        if (!accum[win].by_month[monthKey]) {
          accum[win].by_month[monthKey] = { groups: [], individuals: [] };
        }
        accum[win].by_month[monthKey][seg].push(lt);
      }
    }

    const toStats = (values) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const n = sorted.length;
      const p = (pct) => sorted[Math.round(pct * (n - 1))];
      return { median_days: p(0.5), p25_days: p(0.25), p75_days: p(0.75), n };
    };

    const result = {};
    for (const [win, data] of Object.entries(accum)) {
      result[win] = { by_week: {}, by_month: {} };
      for (const [k, cell] of Object.entries(data.by_week)) {
        result[win].by_week[k] = { groups: toStats(cell.groups), individuals: toStats(cell.individuals) };
      }
      for (const [k, cell] of Object.entries(data.by_month)) {
        result[win].by_month[k] = { groups: toStats(cell.groups), individuals: toStats(cell.individuals) };
      }
    }

    return result;
  }

  /**
   * Cancellation profile: cancellation rates with YoY comparison.
   *
   * Scope: months that cover the past 8 completed weeks (Thursday rule), CY + same months LY.
   * Both month and week granularity; by_week cells with < 5 reservations are set to null.
   * Includes cancelled reservations (unlike the other methods).
   */
  computeCancellationProfile() {
    const reservations = this.data.historicalReservations;
    if (!reservations || reservations.length === 0) {
      this.warnings.push('WARNING: No reservation data for cancellation analysis.');
      return null;
    }

    const currentMonday = this.getCurrentWeekMonday();
    const past8CY = this.getPastWeekKeys(8, currentMonday);
    const past8LY = this.toLYWeekKeys(past8CY);

    const cyWeekSet = new Set(past8CY);
    const lyWeekSet = new Set(past8LY);

    // Month scope via Thursday rule
    const cyMonthSet = new Set(past8CY.map(wk => this.getMonthKeyFromWeekKey(wk)));
    const lyMonthSet = new Set(past8LY.map(wk => this.getMonthKeyFromWeekKey(wk)));

    const makeCell = () => ({
      total: 0, cancelled: 0,
      groups:      { total: 0, cancelled: 0 },
      individuals: { total: 0, cancelled: 0 }
    });

    const cyWeekAccum  = Object.fromEntries(past8CY.map(k => [k, makeCell()]));
    const lyWeekAccum  = Object.fromEntries(past8LY.map(k => [k, makeCell()]));
    const cyMonthAccum = Object.fromEntries([...cyMonthSet].map(k => [k, makeCell()]));
    const lyMonthAccum = Object.fromEntries([...lyMonthSet].map(k => [k, makeCell()]));

    const bump = (acc, key, seg, cancelled) => {
      if (!acc[key]) return;
      acc[key].total++;
      acc[key][seg].total++;
      if (cancelled) { acc[key].cancelled++; acc[key][seg].cancelled++; }
    };

    for (const res of reservations) {
      if (!res.arrivalDate) continue;
      const arrDate   = new Date(res.arrivalDate);
      const weekKey   = this.getIsoWeekKey(arrDate);
      const monthKey  = this.getMonthKey(arrDate);
      const cancelled = this.isCancelled(res);
      const seg       = this.isGroup(res) ? 'groups' : 'individuals';

      if (cyWeekSet.has(weekKey))  bump(cyWeekAccum,  weekKey,  seg, cancelled);
      if (lyWeekSet.has(weekKey))  bump(lyWeekAccum,  weekKey,  seg, cancelled);
      if (cyMonthSet.has(monthKey)) bump(cyMonthAccum, monthKey, seg, cancelled);
      if (lyMonthSet.has(monthKey)) bump(lyMonthAccum, monthKey, seg, cancelled);
    }

    const toRates = (cell) => ({
      total_reservations: cell.total,
      cancelled: cell.cancelled,
      cancellation_rate_pct: cell.total > 0
        ? parseFloat((cell.cancelled / cell.total * 100).toFixed(1)) : null,
      groups: {
        total: cell.groups.total, cancelled: cell.groups.cancelled,
        rate_pct: cell.groups.total > 0
          ? parseFloat((cell.groups.cancelled / cell.groups.total * 100).toFixed(1)) : null
      },
      individuals: {
        total: cell.individuals.total, cancelled: cell.individuals.cancelled,
        rate_pct: cell.individuals.total > 0
          ? parseFloat((cell.individuals.cancelled / cell.individuals.total * 100).toFixed(1)) : null
      }
    });

    const yoyDelta = (cyStat, lyStat) =>
      (cyStat.cancellation_rate_pct != null && lyStat.cancellation_rate_pct != null)
        ? parseFloat((cyStat.cancellation_rate_pct - lyStat.cancellation_rate_pct).toFixed(1))
        : null;

    // Build by_month (pair CY and LY by month number)
    const byMonth = {};
    for (const cyMk of cyMonthSet) {
      const [y, m] = cyMk.split('-');
      const lyMk   = `${parseInt(y) - 1}-${m}`;
      const cy = toRates(cyMonthAccum[cyMk] || makeCell());
      const ly = toRates(lyMonthAccum[lyMk] || makeCell());
      byMonth[cyMk] = { cy, ly, yoy_rate_delta_pct: yoyDelta(cy, ly) };
    }

    // Build by_week (null when < 5 reservations in either cell)
    const byWeek = {};
    for (let i = 0; i < past8CY.length; i++) {
      const cyWk = past8CY[i];
      const lyWk = past8LY[i];
      const cyCell = cyWeekAccum[cyWk] || makeCell();
      const lyCell = lyWeekAccum[lyWk] || makeCell();
      const cy = cyCell.total >= 5 ? toRates(cyCell) : null;
      const ly = lyCell.total >= 5 ? toRates(lyCell) : null;
      byWeek[cyWk] = { cy, ly, yoy_rate_delta_pct: (cy && ly) ? yoyDelta(cy, ly) : null };
    }

    return { by_month: byMonth, by_week: byWeek };
  }

  /**
   * Average price by segment: weighted average of reservation `average_price` field.
   *
   * Weighted by nights: sum(average_price × nights) / sum(nights).
   * Uses reservation data only — no connection to housestate ADR.
   * Same four windows as computeSegmentation().
   */
  computeAvgPriceBySegment() {
    const reservations = this.data.historicalReservations;
    if (!reservations || reservations.length === 0) {
      this.warnings.push('WARNING: No reservation data for average price analysis.');
      return null;
    }

    const currentMonday = this.getCurrentWeekMonday();
    const past8CY = this.getPastWeekKeys(8, currentMonday);
    const windows = {
      past_8w_cy: new Set(past8CY),
      past_8w_ly: new Set(this.toLYWeekKeys(past8CY)),
      otb_12w_cy: new Set(this.getFutureWeekKeys(12, currentMonday)),
      otb_12w_ly: new Set(this.toLYWeekKeys(this.getFutureWeekKeys(12, currentMonday)))
    };

    const makeAcc = () => ({ sumPriceNights: 0, sumNights: 0 });

    const accum = {};
    for (const [win, keySet] of Object.entries(windows)) {
      accum[win] = { by_week: {}, by_month: {} };
      for (const k of keySet) {
        accum[win].by_week[k] = { groups: makeAcc(), individuals: makeAcc() };
      }
    }

    for (const res of reservations) {
      if (!res.arrivalDate || this.isCancelled(res)) continue;
      if (res.averagePrice == null) continue;
      const arrDate  = new Date(res.arrivalDate);
      const weekKey  = this.getIsoWeekKey(arrDate);
      const monthKey = this.getMonthKey(arrDate);
      const nights   = res.nights || 1;
      const price    = res.averagePrice;
      const seg      = this.isGroup(res) ? 'groups' : 'individuals';

      for (const [win, keySet] of Object.entries(windows)) {
        if (!keySet.has(weekKey)) continue;
        accum[win].by_week[weekKey][seg].sumPriceNights += price * nights;
        accum[win].by_week[weekKey][seg].sumNights      += nights;
        if (!accum[win].by_month[monthKey]) {
          accum[win].by_month[monthKey] = { groups: makeAcc(), individuals: makeAcc() };
        }
        accum[win].by_month[monthKey][seg].sumPriceNights += price * nights;
        accum[win].by_month[monthKey][seg].sumNights      += nights;
      }
    }

    const toPrice = (a) => ({
      avg_price: a.sumNights > 0 ? parseFloat((a.sumPriceNights / a.sumNights).toFixed(2)) : null,
      rn: a.sumNights
    });

    const result = {};
    for (const [win, data] of Object.entries(accum)) {
      result[win] = { by_week: {}, by_month: {} };
      for (const [k, cell] of Object.entries(data.by_week)) {
        result[win].by_week[k] = { groups: toPrice(cell.groups), individuals: toPrice(cell.individuals) };
      }
      for (const [k, cell] of Object.entries(data.by_month)) {
        result[win].by_month[k] = { groups: toPrice(cell.groups), individuals: toPrice(cell.individuals) };
      }
    }

    return result;
  }

}

// ============ N8N EXECUTION CODE ============
const parseResult = $input.first().json;

if (!parseResult.success) {
  throw new Error('Cannot run analysis — parsing failed');
}

const analyzer      = new HistoricalAnalysisEngine(parseResult.data);
const analysisResult = analyzer.runAllAnalysis();

if (!analysisResult.success) {
  console.error('❌ ANALYSIS FAILED:', analysisResult.error);
  throw new Error('Historical analysis failed: ' + analysisResult.error);
}

const baselines  = analysisResult.analysis.weekdayBaselines;
const days       = Object.keys(baselines).filter(k => k !== '_metadata');
const sampleInfo = days.map(d =>
  `${d.slice(0,3)}: ${baselines[d].sampleSize} samples, avg ${baselines[d].historicalAvgRoomNights.toFixed(0)} RN`
).join(' | ');

const weeklyCount = Object.keys(analysisResult.analysis.weeklyHistoricalData).length;
const { recentTrend, monthlyTrend, segmentation } = analysisResult.analysis;
const trendSign = recentTrend.yoyChangePercent >= 0 ? '+' : '';

const segInfo = segmentation
  ? (() => {
      const monthCells = Object.values(segmentation.past_8w_cy.by_month);
      const totRN = monthCells.reduce((s, c) => s + c.groups.rn + c.individuals.rn, 0);
      const grpRN = monthCells.reduce((s, c) => s + c.groups.rn, 0);
      return totRN > 0 ? `groups ${(grpRN / totRN * 100).toFixed(0)}%` : 'no reservation data';
    })()
  : 'no reservation data';

console.log(`✅ Historical analysis V11 — ${sampleInfo}`);
console.log(`   Weekly data: ${weeklyCount} ISO weeks | Recent trend: ${trendSign}${recentTrend.yoyChangePercent}% YoY | ${monthlyTrend.monthName}: ${monthlyTrend.yoyChangePercent >= 0 ? '+' : ''}${monthlyTrend.yoyChangePercent}% YoY`);
console.log(`   Reservation analyses: segmentation (${segInfo}) | freshness: ${analysisResult.reservationsDataFreshness}`);

return [{ json: { parseResult, analysisResult } }];
