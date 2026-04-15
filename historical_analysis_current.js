/**
 * Hotel Revenue Forecasting System - Module 2: Historical Analysis Engine
 * 
 * Calculates:
 * - Weekday baseline averages (room nights, revenue, ADR)
 * - Channel mix percentages
 * - Leadtime distribution (buckets + avg leadtime)
 * - Booking pace curves per weekday (CORRECTED LOGIC)
 * - Overall booking pace curve (all reservations, not weekday-bound)
 * - Revenue ratios (TotalRevenue / RoomRevenue), overall + per weekday
 * 
 * These calculations run ONCE and are reused for all forecast days
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
      // Calculate weekday baseline averages
      this.analysis.weekdayBaselines = this.calculateWeekdayBaselines();
      
      // Calculate channel mix
      this.analysis.channelMix = this.calculateChannelMix();
      
      // Calculate leadtime distributions
      this.analysis.leadtimeDistribution = this.calculateLeadtimeDistribution();
      
      // Calculate booking pace curves (CORRECTED LOGIC)
      const bookingPaceCurvesResult = this.calculateBookingPaceCurves();
      this.analysis.leadtimeCurves = bookingPaceCurvesResult.weekdayCurves;
      this.analysis.overallLeadtimeCurve = bookingPaceCurvesResult.overallCurve;
      
      // Calculate revenue ratios
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
   * Calculate weekday baseline averages from historical data
   * Groups by weekday and calculates mean values
   */
  calculateWeekdayBaselines() {
    const historicalData = this.data.historicalHousestate;
    
    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data available. Cannot calculate baselines.');
    }
    
    if (historicalData.length < 365) {
      this.warnings.push(
        `WARNING: Only ${historicalData.length} days of historical data (recommended: 365+). This may affect forecast accuracy.`
      );
    }
    
    // Group by weekday
    const weekdayGroups = {
      'Monday': [],
      'Tuesday': [],
      'Wednesday': [],
      'Thursday': [],
      'Friday': [],
      'Saturday': [],
      'Sunday': []
    };
    
    historicalData.forEach(day => {
      if (weekdayGroups[day.weekday]) {
        weekdayGroups[day.weekday].push({
          roomNights: day.roomNights,
          roomRevenue: day.roomRevenue,
          totalRevenue: day.totalRevenue
        });
      }
    });
    
    // Calculate averages for each weekday
    const baselines = {};
    const missingWeekdays = [];
    
    Object.keys(weekdayGroups).forEach(weekday => {
      const days = weekdayGroups[weekday];
      
      if (days.length === 0) {
        missingWeekdays.push(weekday);
        return;
      }
      
      const avgRoomNights = days.reduce((sum, d) => sum + d.roomNights, 0) / days.length;
      const avgRoomRevenue = days.reduce((sum, d) => sum + d.roomRevenue, 0) / days.length;
      const avgTotalRevenue = days.reduce((sum, d) => sum + d.totalRevenue, 0) / days.length;
      const avgADR = avgRoomRevenue / avgRoomNights;
      
      baselines[weekday] = {
        avgRoomNights,
        avgRoomRevenue,
        avgTotalRevenue,
        avgADR,
        sampleSize: days.length
      };
    });
    
    if (missingWeekdays.length > 0) {
      throw new Error(
        `CRITICAL: Missing historical data for weekdays: ${missingWeekdays.join(', ')}. ` +
        `Need at least one data point per weekday.`
      );
    }
    
    return baselines;
  }

  /**
   * Calculate channel mix percentages
   */
  calculateChannelMix() {
    const reservations = this.data.historicalReservations;
    
    if (!reservations || reservations.length === 0) {
      throw new Error('CRITICAL: No historical reservations data available. Cannot calculate channel mix.');
    }
    
    // Group by channel
    const channelCounts = {};
    let totalRoomNights = 0;
    
    reservations.forEach(res => {
      const channel = res.channel || 'Unknown';
      if (!channelCounts[channel]) {
        channelCounts[channel] = 0;
      }
      channelCounts[channel] += res.roomNights;
      totalRoomNights += res.roomNights;
    });
    
    if (totalRoomNights === 0) {
      throw new Error('CRITICAL: No valid room nights in historical reservations. Cannot calculate channel mix.');
    }
    
    // Calculate percentages
    const channelMix = {};
    Object.keys(channelCounts).forEach(channel => {
      channelMix[channel] = {
        lastYear: (channelCounts[channel] / totalRoomNights) * 100,
        forecast: (channelCounts[channel] / totalRoomNights) * 100 // placeholder
      };
    });
    
    return channelMix;
  }

  /**
   * Calculate leadtime distribution
   * Groups bookings by leadtime buckets
   */
  calculateLeadtimeDistribution() {
    const reservations = this.data.historicalReservations;
    
    if (!reservations || reservations.length === 0) {
      throw new Error('CRITICAL: No historical reservations data. Cannot calculate leadtime distribution.');
    }
    
    // Filter out reservations with invalid leadtime
    const validReservations = reservations.filter(res => 
      res.leadtime !== null && res.leadtime >= 0
    );
    
    if (validReservations.length === 0) {
      throw new Error(
        'CRITICAL: No valid leadtime data in historical reservations. Check that Reservation_created_at dates are present.'
      );
    }
    
    // Buckets: 0-1d, 2-7d, 8-14d, 15-21d, 22-28d, 28+d
    const buckets = {
      '0-1d': 0,
      '2-7d': 0,
      '8-14d': 0,
      '15-21d': 0,
      '22-28d': 0,
      '28+d': 0
    };
    
    validReservations.forEach(res => {
      const lt = res.leadtime;
      if (lt <= 1) buckets['0-1d']++;
      else if (lt <= 7) buckets['2-7d']++;
      else if (lt <= 14) buckets['8-14d']++;
      else if (lt <= 21) buckets['15-21d']++;
      else if (lt <= 28) buckets['22-28d']++;
      else buckets['28+d']++;
    });
    
    const total = validReservations.length;
    
    // Convert to percentages
    const distribution = {};
    Object.keys(buckets).forEach(bucket => {
      distribution[bucket] = (buckets[bucket] / total) * 100;
    });
    
    // Calculate average leadtime
    const avgLeadtime = validReservations.reduce((sum, res) => sum + res.leadtime, 0) / total;
    
    return {
      buckets: distribution,
      avgLeadtime,
      sampleSize: total
    };
  }

  /**
   * Leadtime checkpoints:
   *  - 0 days (same day)
   *  - 1 day before
   *  - then every 2 days up to 90 days
   *  => 0, 1, 2, 4, 6, ..., 90
   */
  getLeadtimeCheckpoints() {
    const checkpoints = [0, 1];
    for (let d = 2; d <= 90; d += 2) {
      checkpoints.push(d);
    }
    return checkpoints;
  }

  /**
   * Calculate booking pace curves for curve-based forecasting
   * CORRECTED LOGIC: Shows "what % of final bookings are typically on books at X days out"
   * 
   * Returns:
   * - weekdayCurves: { Monday: {...}, Tuesday: {...}, ... }
   * - overallCurve: { day0: %, day1: %, ... } over ALL reservations
   */
  calculateBookingPaceCurves() {
    const reservations = this.data.historicalReservations;
    const housestate = this.data.historicalHousestate;
    
    if (!reservations || reservations.length === 0) {
      throw new Error('CRITICAL: No historical reservations data. Cannot calculate booking pace curves.');
    }
    
    if (!housestate || housestate.length === 0) {
      throw new Error('CRITICAL: No historical housestate data. Cannot calculate booking pace curves.');
    }
    
    // Get lookback window: 1 year ago + 6 weeks
    const lookbackWindow = this.getLookbackWindow();
    
    // Filter to lookback period
    const relevantReservations = reservations.filter(res => {
      const arrivalDate = new Date(res.arrivalDate);
      return arrivalDate >= lookbackWindow.start && arrivalDate <= lookbackWindow.end;
    });
    
    const relevantHousestate = housestate.filter(day => {
      const date = new Date(day.date);
      return date >= lookbackWindow.start && date <= lookbackWindow.end;
    });
    
    if (relevantReservations.length === 0) {
      throw new Error('CRITICAL: No reservations found in lookback window. Cannot calculate booking pace curves.');
    }
    
    if (relevantHousestate.length === 0) {
      throw new Error('CRITICAL: No housestate data found in lookback window. Cannot calculate booking pace curves.');
    }
    
    // Group housestate by weekday
    const stayDatesByWeekday = this.groupStayDatesByWeekday(relevantHousestate);
    
    const curves = {};
    const checkpoints = this.getLeadtimeCheckpoints();
    const missingWeekdays = [];
    
    // Calculate curves per weekday
    Object.keys(stayDatesByWeekday).forEach(weekday => {
      const stayDates = stayDatesByWeekday[weekday];
      
      if (stayDates.length === 0) {
        missingWeekdays.push(weekday);
        return;
      }
      
      const curvePoints = {};
      
      checkpoints.forEach(daysOut => {
        const percentages = [];
        
        stayDates.forEach(stayDateRecord => {
          const stayDate = new Date(stayDateRecord.date);
          const finalActual = stayDateRecord.roomNights;
          
          if (finalActual === 0) return; // Skip if no final room nights
          
          // Get all reservations for this stay date
          const reservationsForDate = relevantReservations.filter(res => {
            const arrivalDate = new Date(res.arrivalDate);
            return arrivalDate.getTime() === stayDate.getTime();
          });
          
          // Calculate OTB at this checkpoint
          let otbRoomNights = 0;
          
          reservationsForDate.forEach(res => {
            // Was this reservation on the books at 'daysOut' days before arrival?
            if (res.leadtime >= daysOut) {
              otbRoomNights += res.roomNights;
            }
          });
          
          // Calculate percentage
          const percentage = (otbRoomNights / finalActual) * 100;
          percentages.push(percentage);
        });
        
        // Average across all historical stay dates
        const avgPercentage = percentages.length > 0
          ? percentages.reduce((sum, pct) => sum + pct, 0) / percentages.length
          : 0;
        
        curvePoints[`day${daysOut}`] = avgPercentage;
      });
      
      curves[weekday] = curvePoints;
    });
    
    // Handle missing weekdays
    if (missingWeekdays.length > 0) {
      this.warnings.push(
        `WARNING: No booking pace data for ${missingWeekdays.join(', ')}. Using average curve as fallback.`
      );
      
      const averageCurve = this.calculateAverageCurve(curves);
      missingWeekdays.forEach(weekday => {
        curves[weekday] = averageCurve;
      });
    }

    // Calculate overall booking pace curve (not weekday-specific)
    const overallCurve = this.calculateOverallBookingPaceCurve(
      relevantReservations,
      relevantHousestate,
      checkpoints
    );
    
    return {
      weekdayCurves: curves,
      overallCurve
    };
  }

  /**
   * Get lookback window: 1 year ago + 6 weeks
   */
  getLookbackWindow() {
    const currentHousestate = this.data.currentHousestate;
    
    if (!currentHousestate || currentHousestate.length === 0) {
      throw new Error('CRITICAL: No current housestate data. Cannot determine lookback window.');
    }
    
    const forecastStartDate = new Date(currentHousestate[0].date);
    
    // 1 year ago
    const lookbackStart = new Date(forecastStartDate);
    lookbackStart.setFullYear(lookbackStart.getFullYear() - 1);
    
    // + 6 weeks
    const lookbackEnd = new Date(lookbackStart);
    lookbackEnd.setDate(lookbackEnd.getDate() + (6 * 7));
    
    return { start: lookbackStart, end: lookbackEnd };
  }

  /**
   * Group housestate records by weekday
   */
  groupStayDatesByWeekday(housestateRecords) {
    const groups = {
      'Monday': [],
      'Tuesday': [],
      'Wednesday': [],
      'Thursday': [],
      'Friday': [],
      'Saturday': [],
      'Sunday': []
    };
    
    housestateRecords.forEach(record => {
      if (groups[record.weekday]) {
        groups[record.weekday].push({
          date: record.date,
          roomNights: record.roomNights
        });
      }
    });
    
    return groups;
  }

  /**
   * Calculate overall booking pace curve (not per weekday)
   * Uses ALL stay dates with valid data
   */
  calculateOverallBookingPaceCurve(relevantReservations, relevantHousestate, checkpoints) {
    const overallCurve = {};
    
    checkpoints.forEach(daysOut => {
      const percentages = [];
      
      relevantHousestate.forEach(stayDateRecord => {
        const stayDate = new Date(stayDateRecord.date);
        const finalActual = stayDateRecord.roomNights;
        
        if (finalActual === 0) return;
        
        // Get all reservations for this stay date
        const reservationsForDate = relevantReservations.filter(res => {
          const arrivalDate = new Date(res.arrivalDate);
          return arrivalDate.getTime() === stayDate.getTime();
        });
        
        // Calculate OTB at this checkpoint
        let otbRoomNights = 0;
        
        reservationsForDate.forEach(res => {
          if (res.leadtime >= daysOut) {
            otbRoomNights += res.roomNights;
          }
        });
        
        const percentage = (otbRoomNights / finalActual) * 100;
        percentages.push(percentage);
      });
      
      // Average across all stay dates
      const avgPercentage = percentages.length > 0
        ? percentages.reduce((sum, pct) => sum + pct, 0) / percentages.length
        : 0;
      
      overallCurve[`day${daysOut}`] = avgPercentage;
    });
    
    return overallCurve;
  }

  /**
   * Calculate average curve from existing curves (used for missing weekdays)
   */
  calculateAverageCurve(curves) {
    const curveKeys = Object.keys(curves);
    if (curveKeys.length === 0) {
      throw new Error('CRITICAL: Cannot calculate average booking pace curve - no data available.');
    }
    
    const checkpoints = this.getLeadtimeCheckpoints();
    const avgCurve = {};
    
    checkpoints.forEach(days => {
      const key = `day${days}`;
      const values = curveKeys
        .map(weekday => curves[weekday][key])
        .filter(v => typeof v === 'number');
      
      avgCurve[key] = values.reduce((sum, val) => sum + val, 0) / values.length;
    });
    
    return avgCurve;
  }

  /**
   * Calculate revenue ratios (TotalRevenue / RoomRevenue)
   */
  calculateRevenueRatios() {
    const historicalData = this.data.historicalHousestate;
    
    if (!historicalData || historicalData.length === 0) {
      throw new Error('CRITICAL: No historical housestate data. Cannot calculate revenue ratios.');
    }
    
    const validDays = historicalData.filter(d => 
      d.roomRevenue > 0 && d.totalRevenue > 0
    );
    
    if (validDays.length === 0) {
      throw new Error('CRITICAL: No valid revenue data in historical housestate. Cannot calculate revenue ratios.');
    }
    
    const totalRoomRev = validDays.reduce((sum, d) => sum + d.roomRevenue, 0);
    const totalTotalRev = validDays.reduce((sum, d) => sum + d.totalRevenue, 0);
    const overallRatio = totalTotalRev / totalRoomRev;
    
    // Calculate per weekday
    const weekdayRatios = {};
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    weekdays.forEach(weekday => {
      const weekdayDays = validDays.filter(d => d.weekday === weekday);
      
      if (weekdayDays.length === 0) {
        weekdayRatios[weekday] = overallRatio;
        this.warnings.push(
          `WARNING: No revenue ratio data for ${weekday}. Using overall ratio: ${overallRatio.toFixed(2)}`
        );
      } else {
        const weekdayRoomRev = weekdayDays.reduce((sum, d) => sum + d.roomRevenue, 0);
        const weekdayTotalRev = weekdayDays.reduce((sum, d) => sum + d.totalRevenue, 0);
        weekdayRatios[weekday] = weekdayTotalRev / weekdayRoomRev;
      }
    });
    
    return {
      overallRatio,
      weekdayRatios
    };
  }

  /**
   * Get analysis summary for logging
   */
  getAnalysisSummary() {
    if (!this.analysis.weekdayBaselines) {
      return 'Analysis not yet run';
    }
    
    const summary = {
      weekdayBaselines: Object.keys(this.analysis.weekdayBaselines).map(day => ({
        day,
        avgRoomNights: this.analysis.weekdayBaselines[day].avgRoomNights.toFixed(1),
        avgADR: this.analysis.weekdayBaselines[day].avgADR.toFixed(2),
        sampleSize: this.analysis.weekdayBaselines[day].sampleSize
      })),
      channels: Object.keys(this.analysis.channelMix || {}).length,
      avgLeadtime: this.analysis.leadtimeDistribution.avgLeadtime?.toFixed(1) || 'N/A',
      overallRevenueRatio: this.analysis.revenueRatios.overallRatio.toFixed(2)
    };
    
    return summary;
  }
}

// Export for n8n usage
module.exports = HistoricalAnalysisEngine;

// Example usage (for testing):
if (require.main === module) {
  console.log('Historical Analysis Engine loaded successfully');
  console.log('Use: const HistoricalAnalysisEngine = require("./2_historical_analysis.js");');
  console.log('Then: const analyzer = new HistoricalAnalysisEngine(parsedData);');
  console.log('Then: const result = analyzer.runAllAnalysis();');
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

console.log('✅ Historical analysis completed');
return [{ json: { parseResult, analysisResult } }];