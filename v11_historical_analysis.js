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
      // Existing baselines (used for ADR fallback and revenue ratios)
      this.analysis.weekdayBaselines = this.calculateWeekdayBaselines();
      this.analysis.revenueRatios    = this.calculateRevenueRatios();

      // New: weekly aggregates, volatility, and trend signals
      this.analysis.weeklyHistoricalData = this.calculateWeeklyHistoricalData();
      this.analysis.svbByWeek            = this.calculateSVBByWeek(this.analysis.weeklyHistoricalData);
      this.analysis.recentTrend          = this.calculateRecentTrend(this.analysis.weeklyHistoricalData);
      this.analysis.monthlyTrend         = this.calculateMonthlyTrend();

      return {
        success: true,
        analysis: this.analysis,
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
const { recentTrend, monthlyTrend } = analysisResult.analysis;
const trendSign = recentTrend.yoyChangePercent >= 0 ? '+' : '';

console.log(`✅ Historical analysis V11 — ${sampleInfo}`);
console.log(`   Weekly data: ${weeklyCount} ISO weeks | Recent trend: ${trendSign}${recentTrend.yoyChangePercent}% YoY | ${monthlyTrend.monthName}: ${monthlyTrend.yoyChangePercent >= 0 ? '+' : ''}${monthlyTrend.yoyChangePercent}% YoY`);

return [{ json: { parseResult, analysisResult } }];
