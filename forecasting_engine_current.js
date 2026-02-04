/**
 * Hotel Revenue Forecasting System - Module 3: Forecasting Engine
 * 
 * Calculates forecast with metrics per day:
 * - Room Nights (Traditional, Curve-based, Final)
 * - Pickup
 * - Room Revenue
 * - Total Revenue
 * - ADR
 * - Occupancy %
 * - RevPAR
 * - TRevPAR
 * - Other Revenue / RevPAR
 * - Channel Mix
 * - Leadtime curve data
 */

class ForecastingEngine {
  constructor(parsedData, historicalAnalysis) {
    this.data = parsedData;
    this.analysis = historicalAnalysis;
    this.hotelInfo = parsedData.hotelInfo;
    this.warnings = [];
    this.forecast = [];
  }

  /**
   * Main forecasting function - generates forecast for all OTB days
   */
  generateForecast() {
    try {
      const otbData = this.data.currentHousestate;
      
      if (!otbData || otbData.length === 0) {
        return {
          success: false,
          error: 'No OTB data available',
          warnings: this.warnings
        };
      }
      
      const firstDate = new Date(otbData[0].date);
      
      otbData.forEach((otbDay) => {
        const otbDate = new Date(otbDay.date);
        
        const daysUntilArrival = Math.floor(
          (otbDate - firstDate) / (1000 * 60 * 60 * 24)
        );
        
        const dayForecast = this.forecastSingleDay(otbDay, daysUntilArrival);
        this.forecast.push(dayForecast);
      });
      
      return {
        success: true,
        forecast: this.forecast,
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
   * Forecast a single day with all metrics
   */
  forecastSingleDay(otbDay, daysUntilArrival) {
    const weekday = otbDay.weekday;
    const baseline = this.analysis.weekdayBaselines[weekday];
    const growthTrend = this.hotelInfo.growthTrend;
    const maxRooms = this.hotelInfo.maxRooms;
    
    const stayDate = new Date(otbDay.date);
    
    // Event pickup
    const eventPickup = this.getEventPickup(stayDate);
    
    // OOO rooms (future extension)
    const oooRooms = 0;
    const availableRooms = maxRooms - oooRooms;
    
    // 1. Room Nights Traditional (> 30 days out)
    const roomNightsTraditional = Math.min(
      (baseline.avgRoomNights + eventPickup) * growthTrend,
      availableRooms
    );
    
    // 2. Room Nights Curve-based (≤ 30 days out)
    const leadtimeCurve = this.analysis.leadtimeCurves[weekday];
    const curveKey = this.getLeadtimeCurveKey(daysUntilArrival);
    const curvePercentage = leadtimeCurve[curveKey] || 50; // fallback 50%
    
    const roomNightsCurve = Math.min(
      ((otbDay.roomNights / (curvePercentage / 100)) + eventPickup) * growthTrend,
      availableRooms
    );
    
    // 3. Room Nights Final (switch at 30 days)
    const roomNightsFinal = daysUntilArrival > 30
      ? roomNightsTraditional
      : roomNightsCurve;
    
    // 4. Pickup
    const pickup = roomNightsFinal - otbDay.roomNights;
    
    // 5. Room Revenue
    const expectedADR = baseline.avgADR * growthTrend;
    const pickupRevenue = pickup * expectedADR;
    const roomRevenue = (otbDay.roomRevenue + pickupRevenue) * growthTrend;
    
    // 6. Total Revenue
    const revenueRatio = this.analysis.revenueRatios.weekdayRatios[weekday];
    let totalRevenue = roomRevenue * revenueRatio;
    
    if (otbDay.totalRevenue < 0 || otbDay.totalRevenue < otbDay.roomRevenue) {
      const previousDay = this.forecast[this.forecast.length - 1];
      if (previousDay) {
        totalRevenue = previousDay.trevpar * roomNightsFinal;
      } else {
        totalRevenue = roomRevenue * revenueRatio;
      }
      const dateStr = stayDate.toISOString().split('T')[0];
      this.warnings.push(`${dateStr}: Used fallback for negative TotalRevenue`);
    }
    
    // 7. ADR
    const adr = roomRevenue / roomNightsFinal;
    
    // 8. Occupancy %
    const occupancy = (roomNightsFinal / availableRooms) * 100;
    
    // 9. RevPAR
    const revpar = roomRevenue / availableRooms;
    
    // 10. TRevPAR
    const trevpar = totalRevenue / availableRooms;
    
    // 11. Other Revenue
    const otherRevenue = totalRevenue - roomRevenue;
    
    // 12. Other RevPAR
    const otherRevpar = otherRevenue / availableRooms;
    
    // Channel mix
    const channelMix = this.getChannelMixForDay(weekday);
    
    // Leadtime curve data
    const leadtimeCurveData = this.getLeadtimeCurveData(weekday, daysUntilArrival);
    
    // Average leadtime (global)
    const avgLeadtime = this.analysis.leadtimeDistribution.avgLeadtime || 18;
    
    return {
      stayDate,
      weekday,
      daysUntilArrival,
      
      roomNightsTraditional: Math.round(roomNightsTraditional),
      roomNightsCurve: Math.round(roomNightsCurve),
      roomNightsFinal: Math.round(roomNightsFinal),
      pickup: Math.round(pickup),
      
      roomRevenue,
      totalRevenue,
      otherRevenue,
      
      adr,
      occupancy,
      revpar,
      trevpar,
      otherRevpar,
      
      otbRoomNights: otbDay.roomNights,
      otbRoomRevenue: otbDay.roomRevenue,
      otbTotalRevenue: otbDay.totalRevenue,
      
      channelMix,
      
      leadtimeCurveCumulative: leadtimeCurveData.cumulative,
      leadtimeCurveIncremental: leadtimeCurveData.incremental,
      avgLeadtime
    };
  }

  /**
   * Get event pickup for a specific date
   */
  getEventPickup(date) {
    const events = this.data.events || [];
    let totalPickup = 0;
    const targetDate = new Date(date);

    events.forEach(event => {
      const start = event.startDate ? new Date(event.startDate) : null;
      const end = event.endDate ? new Date(event.endDate) : null;

      if (start && end && targetDate >= start && targetDate <= end) {
        totalPickup += event.pickupImpact || 0;
      }
    });
    
    return totalPickup;
  }

  /**
   * Get appropriate leadtime curve key for days until arrival
   * Matches checkpoints: 0, 1, 2, 4, 6, ..., 90
   */
  getLeadtimeCurveKey(days) {
    let d = Math.floor(days);

    if (d <= 0) return 'day0';
    if (d === 1) return 'day1';
    if (d >= 90) return 'day90';

    if (d < 2) d = 2;
    if (d % 2 === 1) d = d - 1; // round down to even

    return `day${d}`;
  }

  /**
   * Get channel mix for a day
   */
  getChannelMixForDay(_weekday) {
    // For now, same channel mix every day
    return this.analysis.channelMix;
  }

  /**
   * Get leadtime curve data for a day
   */
  getLeadtimeCurveData(weekday, daysUntilArrival) {
    const curve = this.analysis.leadtimeCurves[weekday];
    if (!curve) {
      return { cumulative: 50, incremental: 0 };
    }

    const currentKey = this.getLeadtimeCurveKey(daysUntilArrival);
    const prevKey = this.getLeadtimeCurveKey(daysUntilArrival - 1);
    
    const currentPct = curve[currentKey] ?? 50;
    const prevPct = curve[prevKey] ?? currentPct;
    
    return {
      cumulative: currentPct,
      incremental: currentPct - prevPct
    };
  }

  /**
   * Get forecast summary
   */
  getForecastSummary() {
    if (this.forecast.length === 0) {
      return 'No forecast generated yet';
    }
    
    const totalRoomNights = this.forecast.reduce((sum, day) => sum + day.roomNightsFinal, 0);
    const totalRoomRevenue = this.forecast.reduce((sum, day) => sum + day.roomRevenue, 0);
    const totalTotalRevenue = this.forecast.reduce((sum, day) => sum + day.totalRevenue, 0);
    
    const avgOccupancy = this.forecast.reduce((sum, day) => sum + day.occupancy, 0) / this.forecast.length;
    const avgADR = totalRoomRevenue / totalRoomNights;

    const firstStayDate = new Date(this.forecast[0].stayDate);
    const lastStayDate = new Date(this.forecast[this.forecast.length - 1].stayDate);
    
    return {
      days: this.forecast.length,
      totalRoomNights: Math.round(totalRoomNights),
      totalRoomRevenue: totalRoomRevenue.toFixed(2),
      totalTotalRevenue: totalTotalRevenue.toFixed(2),
      avgOccupancy: avgOccupancy.toFixed(1),
      avgADR: avgADR.toFixed(2),
      dateRange: {
        start: firstStayDate.toISOString().split('T')[0],
        end: lastStayDate.toISOString().split('T')[0]
      }
    };
  }

  /**
   * Export forecast to CSV-compatible format
   */
  exportToCSV() {
    const rows = [];
    
    const headers = [
      'Stay_Date',
      'Weekday',
      'Days_Until_Arrival',
      'Room_Nights_Traditional',
      'Room_Nights_Curve',
      'Room_Nights_Final',
      'Pickup',
      'Room_Revenue',
      'Total_Revenue',
      'ADR',
      'Occupancy_Pct',
      'RevPAR',
      'TRevPAR',
      'Other_Revenue',
      'Other_RevPAR',
      'OTB_Room_Nights',
      'OTB_Room_Revenue',
      'OTB_Total_Revenue',
      'Leadtime_Curve_Cumulative',
      'Leadtime_Curve_Incremental',
      'Avg_Leadtime_Days'
    ];
    
    const channels = Object.keys(this.forecast[0]?.channelMix || {});
    channels.forEach(channel => {
      headers.push(`Channel_LastYear_${channel.replace(/\s+/g, '_')}`);
      headers.push(`Channel_Forecast_${channel.replace(/\s+/g, '_')}`);
    });
    
    rows.push(headers);
    
    this.forecast.forEach(day => {
      const stayDate = new Date(day.stayDate);
      const row = [
        stayDate.toISOString().split('T')[0],
        day.weekday,
        day.daysUntilArrival,
        day.roomNightsTraditional,
        day.roomNightsCurve,
        day.roomNightsFinal,
        day.pickup,
        day.roomRevenue.toFixed(2),
        day.totalRevenue.toFixed(2),
        day.adr.toFixed(2),
        day.occupancy.toFixed(1),
        day.revpar.toFixed(2),
        day.trevpar.toFixed(2),
        day.otherRevenue.toFixed(2),
        day.otherRevpar.toFixed(2),
        day.otbRoomNights,
        day.otbRoomRevenue.toFixed(2),
        day.otbTotalRevenue.toFixed(2),
        day.leadtimeCurveCumulative.toFixed(1),
        day.leadtimeCurveIncremental.toFixed(1),
        day.avgLeadtime.toFixed(1)
      ];
      
      channels.forEach(channel => {
        const mix = day.channelMix[channel];
        row.push(mix.lastYear.toFixed(1));
        row.push(mix.forecast.toFixed(1));
      });
      
      rows.push(row);
    });
    
    return rows;
  }
}

// Export for n8n usage
module.exports = ForecastingEngine;

// Example usage
if (require.main === module) {
  console.log('Forecasting Engine loaded successfully');
  console.log('Use: const ForecastingEngine = require("./3_forecasting_engine.js");');
}

// ============ N8N EXECUTION CODE ============
const input = $input.first().json;
const forecaster = new ForecastingEngine(input.parseResult.data, input.analysisResult.analysis);
const forecastResult = forecaster.generateForecast();

if (!forecastResult.success) {
  console.error('❌ FORECAST FAILED:', forecastResult.error);
  throw new Error('Forecast generation failed: ' + forecastResult.error);
}

const summary = forecaster.getForecastSummary();
console.log('✅ Forecast:', summary.totalRoomNights, 'RN, €' + summary.totalTotalRevenue);

// hotelInfo meesturen voor de output-node
return [{
  json: {
    success: true,
    forecast: forecastResult.forecast,
    summary,
    warnings: forecastResult.warnings,
    hotelInfo: input.parseResult.data.hotelInfo
  }
}];
