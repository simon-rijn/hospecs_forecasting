/**
 * Hotel Revenue Forecasting System - Module 3: Forecasting Engine (V10)
 *
 * Changes from V9:
 * - FIX: daysUntilArrival now calculated from today (new Date()), not from otbData[0].date
 * - REMOVED: Booking pace curve lookups and Traditional/Curve split
 * - REMOVED: Channel mix output
 * - SIMPLIFIED: Single forecast path — historical weekday baseline × growth trend
 * - ADDED: Weekly aggregation of OTB + historical data for AI enrichment
 * - ADDED: Pre-built AI prompt ready for HTTP Request node
 *
 * Output:
 *   { success, forecast (daily, traditional), weeklyAiInput, aiPrompt, hotelInfo, warnings }
 *
 * The AI HTTP node uses aiPrompt to call Claude, then the AI Forecast Processor node
 * replaces roomNightsFinal with AI-estimated weekly totals distributed proportionally.
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
   * Main forecasting function — generates daily traditional forecast + AI input
   */
  generateForecast() {
    try {
      const otbData = this.data.currentHousestate;

      if (!otbData || otbData.length === 0) {
        return { success: false, error: 'No OTB data available', warnings: this.warnings };
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      otbData.forEach((otbDay) => {
        const otbDate = new Date(otbDay.date);

        // V10 FIX: daysUntilArrival from today, not from otbData[0]
        const daysUntilArrival = Math.round((otbDate - today) / (1000 * 60 * 60 * 24));

        const dayForecast = this.forecastSingleDay(otbDay, daysUntilArrival);
        this.forecast.push(dayForecast);
      });

      // Build weekly AI input from the daily forecast
      const weeklyAiInput = this.buildWeeklyAiInput();
      const aiPrompt = this.buildAiPrompt(weeklyAiInput);

      return {
        success: true,
        forecast: this.forecast,
        weeklyAiInput,
        aiPrompt,
        warnings: this.warnings
      };

    } catch (error) {
      return { success: false, error: error.message, warnings: this.warnings };
    }
  }

  /**
   * Forecast a single day — traditional path only
   */
  forecastSingleDay(otbDay, daysUntilArrival) {
    const weekday = otbDay.weekday;
    const baseline = this.analysis.weekdayBaselines[weekday];
    const growthTrend = this.hotelInfo.growthTrend;
    const maxRooms = this.hotelInfo.maxRooms;

    const stayDate = new Date(otbDay.date);

    // Event pickup and available rooms
    const eventPickup = this.getEventPickup(stayDate);
    const availableRooms = this.getAvailableRooms(stayDate, maxRooms);

    // Room Nights: baseline × growth + event pickup, capped at capacity
    const roomNightsFinal = Math.min(
      (baseline.historicalAvgRoomNights * growthTrend) + eventPickup,
      availableRooms
    );

    // Pickup (clamped to 0: cannot be fewer than already on books)
    const pickup = Math.max(0, roomNightsFinal - otbDay.roomNights);

    // ADR metrics
    const historicalADR = baseline.historicalADR;
    const expectedADR = baseline.historicalADR * growthTrend;
    const otbADR = otbDay.roomNights > 0 ? otbDay.roomRevenue / otbDay.roomNights : null;

    // Room Revenue: OTB revenue + pickup at current ADR (fallback to expected)
    const pickupADR = otbADR != null ? otbADR : expectedADR;
    const roomRevenue = otbDay.roomRevenue + (pickup * pickupADR);

    // F&B and Other Revenue via weekday ratios
    const ratios = this.analysis.revenueRatios.weekdayRatios[weekday];
    let fbRevenue, otherRevenue, totalRevenue;

    const baseRevenue = roomRevenue > 0 ? roomRevenue : (baseline.historicalAvgRoomNights * expectedADR);

    if (otbDay.totalRevenue < 0 || otbDay.totalRevenue < otbDay.roomRevenue) {
      fbRevenue = baseRevenue * ratios.fbRatio;
      otherRevenue = baseRevenue * ratios.otherRatio;
      totalRevenue = roomRevenue + fbRevenue + otherRevenue;
      const dateStr = stayDate.toISOString().split('T')[0];
      this.warnings.push(`${dateStr}: Used fallback for invalid OTB TotalRevenue`);
    } else {
      fbRevenue = roomRevenue * ratios.fbRatio;
      otherRevenue = roomRevenue * ratios.otherRatio;
      totalRevenue = roomRevenue + fbRevenue + otherRevenue;
    }

    // Derived metrics
    const occupancy = (roomNightsFinal / availableRooms) * 100;
    const revpar = roomRevenue / availableRooms;
    const trevpar = totalRevenue / availableRooms;
    const fbRevpar = fbRevenue / availableRooms;
    const otherRevpar = otherRevenue / availableRooms;

    return {
      stayDate,
      weekday,
      daysUntilArrival,

      roomNightsFinal: Math.round(roomNightsFinal),
      pickup: Math.round(pickup),

      roomRevenue,
      fbRevenue,
      otherRevenue,
      totalRevenue,

      historicalADR,
      expectedADR,
      otbADR,
      occupancy,
      revpar,
      fbRevpar,
      trevpar,
      otherRevpar,

      otbRoomNights: otbDay.roomNights,
      otbRoomRevenue: otbDay.roomRevenue,
      otbTotalRevenue: otbDay.totalRevenue,

      availableRooms,

      // Stored for downstream use by AI processor
      _baselineRoomNights: baseline.historicalAvgRoomNights,
      _growthTrend: growthTrend
    };
  }

  /**
   * Aggregate daily forecast to ISO weeks for AI input
   */
  buildWeeklyAiInput() {
    const hotelInfo = this.hotelInfo;
    const weeks = [];

    // Group forecast days by ISO week
    const weekMap = new Map();
    this.forecast.forEach(day => {
      const weekKey = this.getIsoWeekKey(new Date(day.stayDate));
      if (!weekMap.has(weekKey)) weekMap.set(weekKey, []);
      weekMap.get(weekKey).push(day);
    });

    weekMap.forEach((days, weekKey) => {
      const firstDay = new Date(days[0].stayDate);
      const lastDay = new Date(days[days.length - 1].stayDate);

      const currentOtbRoomNights = days.reduce((s, d) => s + d.otbRoomNights, 0);
      const currentOtbRevenue = days.reduce((s, d) => s + d.otbRoomRevenue, 0);
      const traditionalRoomNights = days.reduce((s, d) => s + d.roomNightsFinal, 0);
      const historicalRoomNights = days.reduce((s, d) => s + d._baselineRoomNights, 0);
      const expectedRoomNights = days.reduce((s, d) => s + (d._baselineRoomNights * d._growthTrend), 0);
      const capacity = days.reduce((s, d) => s + d.availableRooms, 0);
      const daysUntilWeekStart = days[0].daysUntilArrival;

      // Events active during this week
      const events = this.getEventsForDateRange(firstDay, lastDay);

      weeks.push({
        weekKey,
        weekStart: firstDay.toISOString().split('T')[0],
        weekEnd: lastDay.toISOString().split('T')[0],
        numDays: days.length,
        currentOtbRoomNights,
        currentOtbRevenue: Math.round(currentOtbRevenue),
        traditionalForecastRoomNights: Math.round(traditionalRoomNights),
        historicalAvgRoomNights: Math.round(historicalRoomNights),
        expectedRoomNights: Math.round(expectedRoomNights),
        capacity,
        daysUntilWeekStart,
        events
      });
    });

    return {
      hotel: {
        name: hotelInfo.hotelName || hotelInfo.Hotel_Name || 'Hotel',
        type: hotelInfo.hotelType || '',
        maxRooms: hotelInfo.maxRooms,
        growthTrend: hotelInfo.growthTrend
      },
      weeks
    };
  }

  /**
   * Build a ready-to-send prompt string for the AI HTTP node
   */
  buildAiPrompt(weeklyAiInput) {
    const { hotel, weeks } = weeklyAiInput;

    const weekLines = weeks.map(w => {
      const eventStr = w.events.length > 0
        ? `Events: ${w.events.map(e => `${e.name} (+${e.pickupImpact} RN)`).join(', ')}`
        : 'No events';
      const paceStr = w.daysUntilWeekStart <= 0
        ? `[PAST or current week]`
        : `${w.daysUntilWeekStart} days out`;

      return (
        `Week ${w.weekKey} (${w.weekStart}–${w.weekEnd}, ${w.numDays} days, ${paceStr})\n` +
        `  Current OTB: ${w.currentOtbRoomNights} room nights\n` +
        `  Historical average: ${w.historicalAvgRoomNights} RN | Expected (with ${((hotel.growthTrend - 1) * 100).toFixed(0)}% growth): ${w.expectedRoomNights} RN\n` +
        `  Traditional model forecast: ${w.traditionalForecastRoomNights} RN\n` +
        `  Capacity: ${w.capacity} RN | ${eventStr}`
      );
    }).join('\n\n');

    return (
      `You are a hotel revenue forecasting assistant. Based on the data below, forecast the final room nights for each week.\n\n` +
      `Hotel: ${hotel.name} (${hotel.type || 'hotel'}, max ${hotel.maxRooms} rooms/night)\n\n` +
      `WEEKLY FORECAST DATA:\n${weekLines}\n\n` +
      `INSTRUCTIONS:\n` +
      `- Forecast final room nights for each week. Your estimate must be:\n` +
      `  * At least equal to Current OTB (guests already booked, cannot decrease)\n` +
      `  * At most equal to Capacity (physical limit)\n` +
      `  * Grounded in Historical average and Expected RN; explain deviations > 20%\n` +
      `- If a week is in the past or has very high OTB (>95% of capacity), trust OTB over historical\n\n` +
      `Respond with a JSON object matching this exact schema:\n` +
      `{\n` +
      `  "weeks": [\n` +
      `    {\n` +
      `      "weekKey": "YYYY-WNN",          // ISO week identifier, copied exactly from input\n` +
      `      "forecastedRoomNights": 420,    // integer, your final estimate\n` +
      `      "confidence": "high",           // "high", "medium", or "low"\n` +
      `      "note": "one sentence reason"   // brief justification, especially if deviating from expected\n` +
      `    }\n` +
      `  ]\n` +
      `}\n` +
      `Include one entry per week. Do not add any fields beyond those listed.`
    );
  }

  /**
   * Get ISO week key: "YYYY-WNN"
   */
  getIsoWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayOfWeek = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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
   * Get available rooms for a specific date (may be reduced by event override)
   */
  getAvailableRooms(date, maxRooms) {
    const events = this.data.events || [];
    const targetDate = new Date(date);
    let effectiveMax = maxRooms;

    events.forEach(event => {
      if (event.overrideMaxRooms == null || event.overrideMaxRooms <= 0) return;
      const start = event.startDate ? new Date(event.startDate) : null;
      const end = event.endDate ? new Date(event.endDate) : null;
      if (start && end && targetDate >= start && targetDate <= end) {
        effectiveMax = Math.min(effectiveMax, event.overrideMaxRooms);
      }
    });

    return effectiveMax;
  }

  /**
   * Get unique events active during a date range
   */
  getEventsForDateRange(startDate, endDate) {
    const events = this.data.events || [];
    const result = [];

    events.forEach(event => {
      const start = event.startDate ? new Date(event.startDate) : null;
      const end = event.endDate ? new Date(event.endDate) : null;
      if (start && end && start <= endDate && end >= startDate) {
        result.push({ name: event.name || 'Event', pickupImpact: event.pickupImpact || 0 });
      }
    });

    return result;
  }
}

// ============ N8N EXECUTION CODE ============
const input = $input.first().json;
const forecaster = new ForecastingEngine(input.parseResult.data, input.analysisResult.analysis);
const forecastResult = forecaster.generateForecast();

if (!forecastResult.success) {
  console.error('❌ FORECAST FAILED:', forecastResult.error);
  throw new Error('Forecast generation failed: ' + forecastResult.error);
}

const totalRN = forecastResult.forecast.reduce((s, d) => s + d.roomNightsFinal, 0);
const totalRev = forecastResult.forecast.reduce((s, d) => s + d.totalRevenue, 0);
console.log(`✅ Forecast (V10): ${forecastResult.forecast.length} days, ${totalRN} RN, €${totalRev.toFixed(0)}`);

return [{
  json: {
    success: true,
    forecast: forecastResult.forecast,
    weeklyAiInput: forecastResult.weeklyAiInput,
    aiPrompt: forecastResult.aiPrompt,
    warnings: forecastResult.warnings,
    hotelInfo: input.parseResult.data.hotelInfo
  }
}];
