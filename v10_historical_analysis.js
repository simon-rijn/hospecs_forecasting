/**
 * Hotel Revenue Forecasting System - Module 2: Historical Analysis Engine (V10)
 *
 * Calculates:
 * - Weekday baseline averages (room nights, ADR, revenue) using all available historical
 *   data from the same calendar period (forecast window ± 4 weeks, across all available years)
 * - Revenue ratios (F&B and Other relative to RoomRevenue), per weekday
 *
 * Changes from V9:
 * - REMOVED: Narrow 90-day seasonal window → replaced with calendar-period window across all years
 * - REMOVED: Booking pace curves (reservation data captures only 30-60% of actual occupancy)
 * - REMOVED: Channel mix and leadtime distribution (not needed for AI-assisted forecast)
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
      this.analysis.weekdayBaselines = this.calculateWeekdayBaselines();
      this.analysis.revenueRatios = this.calculateRevenueRatios();

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

  /**
   * Get the day-of-year (1-based) for a date
   */
  getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / (1000 * 60 * 60 * 24));
  }

  /**
   * Determine the forecast calendar window (day-of-year range ± 4 weeks)
   * Returns { minDoy, maxDoy } — year-independent calendar bounds
   */
  getForecastCalendarWindow() {
    const otbData = this.data.currentHousestate;

    if (!otbData || otbData.length === 0) {
      throw new Error('CRITICAL: No current housestate data. Cannot determine forecast window.');
    }

    const firstDate = new Date(otbData[0].date);
    const lastDate = new Date(otbData[otbData.length - 1].date);

    const minDoy = this.getDayOfYear(firstDate) - 28;
    const maxDoy = this.getDayOfYear(lastDate) + 28;

    return { minDoy, maxDoy };
  }

  /**
   * Filter historical housestate records to the same calendar period across all years.
   * Uses day-of-year ± 4 weeks, so records from any available year that fall in the
   * same seasonal window are included — dramatically wider than the old 90-day single-year window.
   */
  filterToCalendarPeriod(historicalData) {
    const { minDoy, maxDoy } = this.getForecastCalendarWindow();

    return historicalData.filter(day => {
      if (day.isOutlier) return false;
      const d = new Date(day.date);
      const doy = this.getDayOfYear(d);

      // Handle year wrap-around (window crossing Dec 31 / Jan 1)
      if (minDoy <= 0) {
        return doy >= (minDoy + 365) || doy <= maxDoy;
      }
      if (maxDoy > 365) {
        return doy >= minDoy || doy <= (maxDoy - 365);
      }
      return doy >= minDoy && doy <= maxDoy;
    });
  }

  /**
   * Calculate weekday baseline averages from historical data.
   * Uses all available data within the calendar-period window (year-independent).
   */
  calculateWeekdayBaselines() {
    const historicalData = this.data.historicalHousestate;

    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data available. Cannot calculate baselines.');
    }

    const filteredData = this.filterToCalendarPeriod(historicalData);

    if (filteredData.length === 0) {
      throw new Error('CRITICAL: No historical data found in calendar window. Cannot calculate baselines.');
    }

    if (filteredData.length < 30) {
      this.warnings.push(
        `WARNING: Only ${filteredData.length} days of historical data in calendar window ` +
        `(recommended: 30+). Baselines may be less reliable.`
      );
    }

    // Group by weekday
    const weekdayGroups = {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [],
      Friday: [], Saturday: [], Sunday: []
    };

    filteredData.forEach(day => {
      if (weekdayGroups[day.weekday]) {
        weekdayGroups[day.weekday].push({
          roomNights: day.roomNights,
          roomRevenue: day.roomRevenue,
          totalRevenue: day.totalRevenue
        });
      }
    });

    const baselines = {};
    const missingWeekdays = [];

    Object.keys(weekdayGroups).forEach(weekday => {
      const days = weekdayGroups[weekday];

      if (days.length === 0) {
        missingWeekdays.push(weekday);
        return;
      }

      const historicalAvgRoomNights = days.reduce((sum, d) => sum + d.roomNights, 0) / days.length;
      const historicalAvgRoomRevenue = days.reduce((sum, d) => sum + d.roomRevenue, 0) / days.length;
      const historicalAvgTotalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0) / days.length;
      const historicalADR = historicalAvgRoomNights > 0
        ? historicalAvgRoomRevenue / historicalAvgRoomNights
        : 0;

      baselines[weekday] = {
        historicalAvgRoomNights,
        historicalAvgRoomRevenue,
        historicalAvgTotalRevenue,
        historicalADR,
        sampleSize: days.length
      };

      if (days.length < 6) {
        this.warnings.push(
          `WARNING: ${weekday} baseline has only ${days.length} samples (recommended: 6+). May be unreliable.`
        );
      }
    });

    if (missingWeekdays.length > 0) {
      throw new Error(
        `CRITICAL: Missing historical data for weekdays: ${missingWeekdays.join(', ')}. ` +
        `Need at least one data point per weekday in calendar window.`
      );
    }

    // Add metadata for debugging
    baselines._metadata = {
      daysIncluded: filteredData.length
    };

    return baselines;
  }

  /**
   * Calculate revenue ratios: F&B and Other relative to RoomRevenue, per weekday.
   * Uses same calendar-period window as baselines.
   */
  calculateRevenueRatios() {
    const historicalData = this.data.historicalHousestate;

    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data. Cannot calculate revenue ratios.');
    }

    const filteredData = this.filterToCalendarPeriod(historicalData);
    const validDays = filteredData.filter(d => d.roomRevenue > 0 && d.totalRevenue > 0);

    if (validDays.length === 0) {
      throw new Error('CRITICAL: No valid revenue data in calendar window. Cannot calculate revenue ratios.');
    }

    const hasFBData = validDays.some(d => d.fbRevenue != null);
    const hasOtherData = validDays.some(d => d.otherRevenue != null);

    // Overall ratios
    const totalRoomRev = validDays.reduce((sum, d) => sum + d.roomRevenue, 0);
    const totalTotalRev = validDays.reduce((sum, d) => sum + d.totalRevenue, 0);
    const overallTotalRatio = totalTotalRev / totalRoomRev;

    let overallFBRatio, overallOtherRatio;

    if (hasFBData && hasOtherData) {
      const totalFBRev = validDays.reduce((sum, d) => sum + (d.fbRevenue || 0), 0);
      const totalOtherRev = validDays.reduce((sum, d) => sum + (d.otherRevenue || 0), 0);
      overallFBRatio = totalFBRev / totalRoomRev;
      overallOtherRatio = totalOtherRev / totalRoomRev;
    } else {
      overallFBRatio = 0;
      overallOtherRatio = overallTotalRatio - 1;
      this.warnings.push(
        'WARNING: No F&B revenue data in source. All non-room revenue treated as Other Revenue.'
      );
    }

    // Per-weekday ratios
    const weekdayRatios = {};
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(weekday => {
      const wkDays = validDays.filter(d => d.weekday === weekday);

      if (wkDays.length === 0) {
        weekdayRatios[weekday] = {
          totalRatio: overallTotalRatio,
          fbRatio: overallFBRatio,
          otherRatio: overallOtherRatio
        };
        this.warnings.push(
          `WARNING: No revenue data for ${weekday} in calendar window. Using overall ratios.`
        );
        return;
      }

      const wkRoomRev = wkDays.reduce((sum, d) => sum + d.roomRevenue, 0);
      const wkTotalRev = wkDays.reduce((sum, d) => sum + d.totalRevenue, 0);

      if (hasFBData && hasOtherData) {
        const wkFBRev = wkDays.reduce((sum, d) => sum + (d.fbRevenue || 0), 0);
        const wkOtherRev = wkDays.reduce((sum, d) => sum + (d.otherRevenue || 0), 0);
        weekdayRatios[weekday] = {
          totalRatio: wkTotalRev / wkRoomRev,
          fbRatio: wkFBRev / wkRoomRev,
          otherRatio: wkOtherRev / wkRoomRev
        };
      } else {
        const wkTotalRatio = wkTotalRev / wkRoomRev;
        weekdayRatios[weekday] = {
          totalRatio: wkTotalRatio,
          fbRatio: 0,
          otherRatio: wkTotalRatio - 1
        };
      }
    });

    return {
      overallTotalRatio,
      overallFBRatio,
      overallOtherRatio,
      weekdayRatios,
      hasFBData
    };
  }
}

// ============ N8N EXECUTION CODE ============
const parseResult = $input.first().json;

if (!parseResult.success) {
  throw new Error('Cannot run analysis - parsing failed');
}

const analyzer = new HistoricalAnalysisEngine(parseResult.data);
const analysisResult = analyzer.runAllAnalysis();

if (!analysisResult.success) {
  console.error('❌ ANALYSIS FAILED:', analysisResult.error);
  throw new Error('Historical analysis failed: ' + analysisResult.error);
}

const baselines = analysisResult.analysis.weekdayBaselines;
const days = Object.keys(baselines).filter(k => k !== '_metadata');
const sampleInfo = days.map(d => `${d.slice(0,3)}: ${baselines[d].sampleSize} samples, avg ${baselines[d].historicalAvgRoomNights.toFixed(0)} RN`).join(' | ');
console.log('✅ Historical analysis completed (V10) —', sampleInfo);

return [{ json: { parseResult, analysisResult } }];
