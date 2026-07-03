// Data Parser Validator v0.12 — 2026-05-18
/**
 * Hotel Revenue Forecasting System - Module 1: Data Parser & Validator (V11)
 * 
 * Handles:
 * - Loading and parsing all input data sources
 * - Comprehensive validation of data integrity
 * - Date parsing and normalization
 * - Data quality warnings and errors
 * - Preparation of clean data structures for forecasting engine
 * 
 * Expected Inputs:
 * 1. current_housestate.json - 90 days forward OTB data
 * 2. context.xlsx (7 sheets via separate CSVs or single object):
 *    - Hotel_Info
 *    - Events
 *    - Trends
 *    - Historical_Reservations
 *    - Historical_Housestate
 *    - Previous_Forecast
 *    - Forecast_Accuracy_History
 */

class DataParserValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.reservationsDataFreshness = 'current'; // overridden to 'stale_1week' when daily update was not received
    this.validationResults = {
      currentHousestate: { valid: false, recordCount: 0 },
      hotelInfo: { valid: false },
      events: { valid: false, recordCount: 0 },
      trends: { valid: false, recordCount: 0 },
      historicalReservations: { valid: false, recordCount: 0 },
      historicalHousestate: { valid: false, recordCount: 0 },
      previousForecast: { valid: false, recordCount: 0 },
      forecastAccuracyHistory: { valid: false, recordCount: 0 }
    };
  }

  /**
   * Read a housestate day field supporting both the current snake_case output of
   * extract_housestate_v11.js (date, room_nights, room_revenue, …) and the legacy
   * PascalCase output (Date, RoomNights, RoomRevenue, …). Uses ?? so a legitimate
   * 0 value is preserved.
   */
  hsRead(day, snakeKey, pascalKey) {
    return day[snakeKey] ?? day[pascalKey];
  }

  /**
   * Main parsing function - orchestrates all data loading
   */
  parseAllData(inputData) {
    try {
      // Parse current housestate (OTB data)
      const currentHousestate = this.parseCurrentHousestate(inputData.currentHousestate);
      
      // Parse hotel configuration
      const hotelInfo = this.parseHotelInfo(inputData.hotelInfo);
      
      // Parse events
      const events = this.parseEvents(inputData.events);
      
      // Parse trends (may be placeholder)
      const trends = this.parseTrends(inputData.trends);
      
      // Parse historical reservations
      const historicalReservations = this.parseHistoricalReservations(inputData.historicalReservations);
      
      // Parse historical housestate
      const historicalHousestate = this.parseHistoricalHousestate(inputData.historicalHousestate);
      
      // Parse previous forecast
      const previousForecast = this.parsePreviousForecast(inputData.previousForecast);
      
      // Parse forecast accuracy history
      const forecastAccuracyHistory = this.parseForecastAccuracyHistory(inputData.forecastAccuracyHistory);
      
      // Flag outliers in historical data (dynamic thresholds)
      this.flagOutliers(historicalHousestate, hotelInfo);

      // Run cross-validation checks
      this.runCrossValidation({
        currentHousestate,
        hotelInfo,
        events,
        historicalReservations,
        historicalHousestate,
        previousForecast
      });
      
      return {
        success: this.errors.length === 0,
        data: {
          currentHousestate,
          hotelInfo,
          events,
          trends,
          historicalReservations,
          historicalHousestate,
          previousForecast,
          forecastAccuracyHistory,
          reservationsDataFreshness: this.reservationsDataFreshness
        },
        errors: this.errors,
        warnings: this.warnings,
        validationResults: this.validationResults
      };
      
    } catch (error) {
      this.errors.push({
        type: 'CRITICAL',
        source: 'DataParser',
        message: `Fatal error during data parsing: ${error.message}`,
        timestamp: new Date().toISOString()
      });
      
      return {
        success: false,
        data: null,
        errors: this.errors,
        warnings: this.warnings,
        validationResults: this.validationResults
      };
    }
  }

  /**
   * Parse Current Housestate (OTB Data)
   * Expected: Array with hotel name as key containing 90 days of data
   */
  parseCurrentHousestate(rawData) {
    const source = 'CurrentHousestate';
    
    try {
      // Handle both array format and direct object format
      let hotelData;
      
      if (Array.isArray(rawData)) {
        // Flat extractor rows: each item directly has a date field (snake_case) or a
        // legacy Date field (PascalCase)
        if (rawData.length > 0 && (rawData[0].date !== undefined || rawData[0].Date !== undefined)) {
          hotelData = rawData;
        } else {
          // Legacy: nested context.xlsx with hotel-name key wrapper
          const hotelObj = rawData.find(item => {
            const keys = Object.keys(item);
            return keys.some(key => key !== 'Historical Housestats' && key !== 'Historical Reservations');
          });

          if (!hotelObj) {
            this.errors.push({
              type: 'CRITICAL',
              source,
              message: 'Could not find hotel data in current housestate array'
            });
            return [];
          }

          const hotelName = Object.keys(hotelObj).find(key =>
            key !== 'Historical Housestats' && key !== 'Historical Reservations'
          );
          hotelData = hotelObj[hotelName];
        }

      } else if (typeof rawData === 'object' && rawData !== null) {
        hotelData = rawData;
      } else {
        this.errors.push({
          type: 'CRITICAL',
          source,
          message: 'Invalid current housestate format'
        });
        return [];
      }

      if (!Array.isArray(hotelData)) {
        this.errors.push({
          type: 'CRITICAL',
          source,
          message: 'Current housestate hotel data is not an array'
        });
        return [];
      }

      if (hotelData.length === 0) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: 'Current housestate (OTB) has no rows — seasonal window will be unconstrained'
        });
      }
      
      // Parse and validate each day
      const parsedData = hotelData.map((day, index) => {
        const fbRaw    = this.hsRead(day, 'fb_revenue', 'FB_Revenue');
        const otherRaw = this.hsRead(day, 'other_revenue', 'OtherRevenue');
        const parsed = {
          date: this.parseDate(this.hsRead(day, 'date', 'Date'), source, `row ${index + 1}`),
          weekday: this.validateWeekday(this.hsRead(day, 'weekday', 'Weekday'), source, `row ${index + 1}`),
          roomNights: this.parseNumber(this.hsRead(day, 'room_nights', 'RoomNights'), source, `row ${index + 1}`, 'RoomNights'),
          roomRevenue: this.parseNumber(this.hsRead(day, 'room_revenue', 'RoomRevenue'), source, `row ${index + 1}`, 'RoomRevenue'),
          totalRevenue: this.parseNumber(this.hsRead(day, 'total_revenue', 'TotalRevenue'), source, `row ${index + 1}`, 'TotalRevenue'),
          fbRevenue: fbRaw != null ? this.parseNumber(fbRaw, source, `row ${index + 1}`, 'FB_Revenue') : null,
          otherRevenue: otherRaw != null ? this.parseNumber(otherRaw, source, `row ${index + 1}`, 'OtherRevenue') : null,
          rawWarnings: day._warnings || []
        };
        
        // Validate data quality
        if (parsed.totalRevenue < parsed.roomRevenue && parsed.totalRevenue > 0) {
          this.warnings.push({
            type: 'WARNING',
            source,
            message: `${parsed.date}: TotalRevenue (${parsed.totalRevenue.toFixed(2)}) < RoomRevenue (${parsed.roomRevenue.toFixed(2)})`
          });
        }
        
        if (parsed.totalRevenue < 0) {
          this.warnings.push({
            type: 'WARNING',
            source,
            message: `${parsed.date}: Negative TotalRevenue (${parsed.totalRevenue.toFixed(2)})`
          });
        }
        
        if (parsed.roomNights < 0) {
          this.warnings.push({
            type: 'WARNING',
            source,
            message: `${parsed.date}: Negative RoomNights value (${parsed.roomNights})`
          });
        }
        
        return parsed;
      });
      
      // Ensure chronological order
      const sorted = parsedData.sort((a, b) => a.date - b.date);
      
      this.validationResults.currentHousestate = {
        valid: true,
        recordCount: sorted.length,
        dateRange: {
          start: sorted[0].date.toISOString().split('T')[0],
          end: sorted[sorted.length - 1].date.toISOString().split('T')[0]
        }
      };
      
      return sorted;
      
    } catch (error) {
      this.errors.push({
        type: 'CRITICAL',
        source,
        message: `Error parsing current housestate: ${error.message}`
      });
      return [];
    }
  }

  /**
   * Parse Hotel Info
   */
  parseHotelInfo(rawData) {
    const source = 'HotelInfo';
    
    try {
      // Handle both array format (CSV) and single object
      let hotelData = rawData;
      
      if (Array.isArray(rawData)) {
        if (rawData.length === 0) {
          this.errors.push({
            type: 'CRITICAL',
            source,
            message: 'Hotel info array is empty'
          });
          return null;
        }
        hotelData = rawData[0]; // Take first row
      }
      
      const parsed = {
        maxRooms: this.parseNumber(hotelData.Max_Rooms, source, 'Max_Rooms', 'Max_Rooms', true),
        maxPersons: this.parseNumber(hotelData.Max_Persons, source, 'Max_Persons', 'Max_Persons'),
        minStayDuration: this.parseNumber(hotelData.Min_Stay_Duration, source, 'Min_Stay_Duration', 'Min_Stay_Duration') || 1,
        maxStayDuration: this.parseNumber(hotelData.Max_Stay_Duration, source, 'Max_Stay_Duration', 'Max_Stay_Duration') || 30,
        hotelName: String(hotelData.Hotel_Name || 'Unknown Hotel'),
        hotelAddress: String(hotelData.Hotel_Address || ''),
        hotelType: String(hotelData.Hotel_Type || 'Unknown'),
        seasonalHotel: String(hotelData.Seasonal_Hotel || 'No').toLowerCase() === 'yes',
        areaType: String(hotelData.Area_Type || 'Unknown'),
        bias: this.parseNumber(hotelData.bias, source, 'Bias', 'Bias') || 1.0,
        hotelContext: hotelData.Hotel_Context ? String(hotelData.Hotel_Context).trim() : null
      };

      // Validate bias limits
      if (parsed.bias < 0.5 || parsed.bias > 2.0) {
        this.errors.push({
          type: 'ERROR',
          source,
          message: `Bias ${parsed.bias} outside acceptable range (0.5 - 2.0)`
        });
        parsed.bias = Math.max(0.5, Math.min(2.0, parsed.bias));
      }
      
      // Validate max rooms
      if (parsed.maxRooms < 1 || parsed.maxRooms > 500) {
        this.errors.push({
          type: 'ERROR',
          source,
          message: `Max_Rooms ${parsed.maxRooms} seems unrealistic`
        });
      }
      
      this.validationResults.hotelInfo = { valid: true };
      
      return parsed;
      
    } catch (error) {
      this.errors.push({
        type: 'CRITICAL',
        source,
        message: `Error parsing hotel info: ${error.message}`
      });
      return null;
    }
  }

  /**
   * Parse Events
   */
  parseEvents(rawData) {
    const source = 'Events';
    
    try {
      if (!Array.isArray(rawData)) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: 'No events data provided (this is optional)'
        });
        this.validationResults.events = { valid: true, recordCount: 0 };
        return [];
      }
      
      const parsed = rawData.map((event, index) => {
        return {
          eventName: String(event.Event_Name || `Event ${index + 1}`),
          startDate: this.parseDate(event.Start_Date, source, `row ${index + 1}`),
          endDate: this.parseDate(event.End_Date, source, `row ${index + 1}`),
          pickupImpact: this.parseNumber(event.Pickup_Impact, source, `row ${index + 1}`, 'Pickup_Impact') || 0,
          overrideMaxRooms: event.Override_Max_Rooms ?
            this.parseNumber(event.Override_Max_Rooms, source, `row ${index + 1}`, 'Override_Max_Rooms') :
            null,
          description: String(event.Description || '')
        };
      }).filter(event => event.startDate && event.endDate);
      
      this.validationResults.events = {
        valid: true,
        recordCount: parsed.length
      };
      
      return parsed;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing events (non-critical): ${error.message}`
      });
      this.validationResults.events = { valid: true, recordCount: 0 };
      return [];
    }
  }

  /**
   * Parse Trends (Placeholder for future use)
   */
  parseTrends(rawData) {
    const source = 'Trends';
    
    try {
      if (!Array.isArray(rawData) || rawData.length === 0) {
        this.warnings.push({
          type: 'INFO',
          source,
          message: 'No trends data provided (placeholder for future use)'
        });
        this.validationResults.trends = { valid: true, recordCount: 0 };
        return [];
      }
      
      // Future: Parse seasonal factors, channel trends, etc.
      this.validationResults.trends = { valid: true, recordCount: rawData.length };
      return rawData;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing trends (non-critical): ${error.message}`
      });
      this.validationResults.trends = { valid: true, recordCount: 0 };
      return [];
    }
  }

  /**
   * Parse Historical Reservations
   */
  parseHistoricalReservations(rawData) {
    const source = 'HistoricalReservations';

    try {
      // ── Graceful handling when the file was not found ────────────────────────
      // The 9th merge input passes an error item when 'Reserveringsbestand niet
      // gevonden' is thrown. In that case (or when rawData is simply absent),
      // continue without reservation data — segment/channel/cancellation analyses
      // will be skipped but the rest of the pipeline keeps running.
      if (rawData == null) {
        this.reservationsDataFreshness = 'stale_1week';
        this.warnings.push({ type: 'WARNING', source, message: 'Dagelijkse reserveringsupdate niet ontvangen — data is maximaal 1 week oud. Pipeline loopt door met de laatste bekende reserveringslijst.' });
        this.validationResults.historicalReservations = { valid: true, recordCount: 0, dateRange: null };
        return [];
      }

      // ── Unwrap nested format if present ──────────────────────────────────
      let reservationsData = rawData;

      if (Array.isArray(rawData)) {
        // Detect error item from the 9th merge input
        const hasErrorItem = rawData.some(item =>
          (typeof item?.message === 'string' && item.message.toLowerCase().includes('reserveringsbestand niet gevonden')) ||
          (typeof item?.error   === 'string' && item.error.toLowerCase().includes('reserveringsbestand niet gevonden'))
        );
        if (hasErrorItem) {
          this.reservationsDataFreshness = 'stale_1week';
          this.warnings.push({ type: 'WARNING', source, message: 'Dagelijkse reserveringsupdate niet ontvangen — data is maximaal 1 week oud. Pipeline loopt door met de laatste bekende reserveringslijst.' });
          this.validationResults.historicalReservations = { valid: true, recordCount: 0, dateRange: null };
          return [];
        }

        const reservationsObj = rawData.find(item => item['Historical Reservations']);
        if (reservationsObj) {
          reservationsData = reservationsObj['Historical Reservations'];
        }
      }

      if (!Array.isArray(reservationsData)) {
        this.reservationsDataFreshness = 'stale_1week';
        this.warnings.push({ type: 'WARNING', source, message: 'Dagelijkse reserveringsupdate niet ontvangen — data is maximaal 1 week oud. Pipeline loopt door met de laatste bekende reserveringslijst.' });
        this.validationResults.historicalReservations = { valid: true, recordCount: 0, dateRange: null };
        return [];
      }

      // ── Parse rows ──────────────────────────────────────────────────
      // Skip the _summary record added by the extraction script
      const dataRows = reservationsData.filter(res => !res._summary);

      let oldestReservation = null;
      let newestReservation = null;

      const parsed = dataRows.map((res, index) => {
        // Support both database field names (Title_Case) and extraction output (snake_case)
        const arrivalDate   = this.parseDate(res.Arrival_Date   || res.arrival_date,   source, `row ${index + 1}`);
        const departureDate = this.parseDate(res.Departure_Date || res.departure_date, source, `row ${index + 1}`);
        const createdAt     = this.parseDate(res.Reservation_created_at || res.created_at, source, `row ${index + 1}`);

        // cancelled_at is optional — parse only when present to avoid spurious warnings
        const cancelledAtRaw = res.Cancelled_At || res.cancelled_at || null;
        const cancelledAt    = cancelledAtRaw ? this.parseDate(cancelledAtRaw, source, `row ${index + 1} cancelled_at`) : null;

        if (arrivalDate) {
          if (!oldestReservation || arrivalDate < oldestReservation) oldestReservation = arrivalDate;
          if (!newestReservation || arrivalDate > newestReservation) newestReservation = arrivalDate;
        }

        return {
          arrivalDate,
          departureDate,
          nights:        this.parseNumber(res.Nights || res.nights, source, `row ${index + 1}`, 'Nights') || 1,
          weekdayArrival: this.validateWeekday(res.Weekday_Arrival || res.weekday_arrival, source, `row ${index + 1}`),
          status:        res.Status      || res.status      || null,
          groupName:     res.Group_Name  || res.group_name  || null,
          channel:       res.Channel     || res.channel     || null,
          rateCode:      res.Rate_Code   || res.rate_code   || null,
          averagePrice:  this.parseNumber(res.averagePrice || res.average_price, source, `row ${index + 1}`, 'averagePrice') || 0,
          createdAt,
          cancelledAt,
          leadtime: arrivalDate && createdAt
            ? Math.round((new Date(arrivalDate.getFullYear(), arrivalDate.getMonth(), arrivalDate.getDate()) - new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate())) / 86400000)
            : null
        };
      });

      // ── Age check ───────────────────────────────────────────────────
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      if (newestReservation && newestReservation < sixMonthsAgo) {
        this.warnings.push({
          type: 'WARNING', source,
          message: `Historical reservations data is outdated (newest arrival: ${newestReservation.toISOString().split('T')[0]}).`
        });
      }

      this.validationResults.historicalReservations = {
        valid: true,
        recordCount: parsed.length,
        dateRange: oldestReservation && newestReservation ? {
          start: oldestReservation.toISOString().split('T')[0],
          end:   newestReservation.toISOString().split('T')[0]
        } : null
      };

      return parsed;

    } catch (error) {
      this.errors.push({ type: 'CRITICAL', source, message: `Error parsing historical reservations: ${error.message}` });
      return [];
    }
  }

  /**
   * Parse Historical Housestate
   */
  parseHistoricalHousestate(rawData) {
    const source = 'HistoricalHousestate';
    
    try {
      // Handle both array format and nested format
      let housestateData = rawData;
      
      if (Array.isArray(rawData)) {
        const housestateObj = rawData.find(
          item => item['Historical Housestats'] || item['Historical Housestates']
        );
        if (housestateObj) {
          housestateData =
            housestateObj['Historical Housestats'] || housestateObj['Historical Housestates'];
        }
      }

      
      if (!Array.isArray(housestateData)) {
        this.errors.push({
          type: 'CRITICAL',
          source,
          message: 'Historical housestate data is not an array'
        });
        return [];
      }
      
      // Check we have at least 1 year of data
      if (housestateData.length < 730) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Historical housestate has only ${housestateData.length} days (minimum recommended: 730 = 2 years)`
        });
      }
      
      const parsed = housestateData.map((day, index) => {
        const fbRaw    = this.hsRead(day, 'fb_revenue', 'FB_Revenue');
        const otherRaw = this.hsRead(day, 'other_revenue', 'OtherRevenue');
        return {
          date: this.parseDate(this.hsRead(day, 'date', 'Date'), source, `row ${index + 1}`),
          weekday: this.validateWeekday(this.hsRead(day, 'weekday', 'Weekday'), source, `row ${index + 1}`),
          roomNights: this.parseNumber(this.hsRead(day, 'room_nights', 'RoomNights'), source, `row ${index + 1}`, 'RoomNights'),
          roomRevenue: this.parseNumber(this.hsRead(day, 'room_revenue', 'RoomRevenue'), source, `row ${index + 1}`, 'RoomRevenue'),
          totalRevenue: this.parseNumber(this.hsRead(day, 'total_revenue', 'TotalRevenue'), source, `row ${index + 1}`, 'TotalRevenue'),
          fbRevenue: fbRaw != null ? this.parseNumber(fbRaw, source, `row ${index + 1}`, 'FB_Revenue') : null,
          otherRevenue: otherRaw != null ? this.parseNumber(otherRaw, source, `row ${index + 1}`, 'OtherRevenue') : null
        };
      });
      
      // Sort chronologically (filter out null dates first)
      const sorted = parsed.filter(day => day.date !== null).sort((a, b) => a.date - b.date);
      
      this.validationResults.historicalHousestate = {
        valid: sorted.length > 0,
        recordCount: sorted.length,
        dateRange: sorted.length > 0 ? {
          start: sorted[0].date.toISOString().split('T')[0],
          end: sorted[sorted.length - 1].date.toISOString().split('T')[0]
        } : null
      };
      
      return sorted;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing historical housestate: ${error.message} (Will use limited historical data)`
      });
      this.validationResults.historicalHousestate = { valid: true, recordCount: 0 };
      return [];
    }
  }

  /**
   * Parse Previous Forecast
   */
  parsePreviousForecast(rawData) {
    const source = 'PreviousForecast';
    
    try {
      // Handle nested format
      let forecastData = rawData;
      
      if (Array.isArray(rawData)) {
        const forecastObj = rawData.find(item => item['Previous Forecasts']);
        if (forecastObj) {
          forecastData = forecastObj['Previous Forecasts'];
        }
      }
      
      if (!Array.isArray(forecastData) || forecastData.length === 0) {
        this.warnings.push({
          type: 'INFO',
          source,
          message: 'No previous forecast available (expected for first run)'
        });
        this.validationResults.previousForecast = { valid: true, recordCount: 0 };
        return [];
      }
      
      const parsed = forecastData
        .filter(day => day.Stay_Date !== null && day.Stay_Date !== undefined) // Filter out all-null records
        .map((day, index) => {
          return {
            stayDate: this.parseDate(day.Stay_Date, source, `row ${index + 1}`),
            forecastedRoomNights: this.parseNumber(day.Room_Nights_Final, source, `row ${index + 1}`, 'Room_Nights_Final'),
            forecastedRoomRevenue: this.parseNumber(day.Room_Revenue, source, `row ${index + 1}`, 'Room_Revenue'),
            forecastedTotalRevenue: this.parseNumber(day.Total_Revenue, source, `row ${index + 1}`, 'Total_Revenue'),
            forecastedADR: this.parseNumber(day.ADR, source, `row ${index + 1}`, 'ADR'),
            forecastedOccupancy: this.parseNumber(day.Occupancy_Pct, source, `row ${index + 1}`, 'Occupancy_Pct')
          };
        });
      
      // If all records were filtered out (all null), treat as empty
      if (parsed.length === 0) {
        this.warnings.push({
          type: 'INFO',
          source,
          message: 'No previous forecast available (expected for first run)'
        });
      }
      
      this.validationResults.previousForecast = {
        valid: true,
        recordCount: parsed.length
      };
      
      return parsed;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing previous forecast (non-critical): ${error.message}`
      });
      this.validationResults.previousForecast = { valid: true, recordCount: 0 };
      return [];
    }
  }

  /**
   * Parse Forecast Accuracy History
   */
  parseForecastAccuracyHistory(rawData) {
    const source = 'ForecastAccuracyHistory';
    
    try {
      // Handle nested format
      let accuracyData = rawData;
      
      if (Array.isArray(rawData)) {
        const accuracyObj = rawData.find(item => item['Forecast Accuracy History']);
        if (accuracyObj) {
          accuracyData = accuracyObj['Forecast Accuracy History'];
        }
      }
      
      if (!Array.isArray(accuracyData) || accuracyData.length === 0) {
        this.warnings.push({
          type: 'INFO',
          source,
          message: 'No forecast accuracy history available (expected for first run)'
        });
        this.validationResults.forecastAccuracyHistory = { valid: true, recordCount: 0 };
        return [];
      }
      
      const parsed = accuracyData
        .filter(entry => entry.Week_Date !== null && entry.Week_Date !== undefined) // Filter out all-null records
        .map((entry, index) => {
          return {
            weekEnding: this.parseDate(entry.Week_Ending || entry.Week_Date, source, `row ${index + 1}`),
            accuracyRoomNights: this.parseNumber(entry.Accuracy_Room_Nights || entry.Accuracy_RoomNights_1w, source, `row ${index + 1}`, 'Accuracy_Room_Nights'),
            accuracyRoomRevenue: this.parseNumber(entry.Accuracy_Room_Revenue || entry.Accuracy_RoomRevenue_1w, source, `row ${index + 1}`, 'Accuracy_Room_Revenue'),
            accuracyTotalRevenue: this.parseNumber(entry.Accuracy_Total_Revenue || entry.Accuracy_TotalRevenue_1w, source, `row ${index + 1}`, 'Accuracy_Total_Revenue'),
            accuracyADR: this.parseNumber(entry.Accuracy_ADR, source, `row ${index + 1}`, 'Accuracy_ADR'),
            accuracyOccupancy: this.parseNumber(entry.Accuracy_Occupancy, source, `row ${index + 1}`, 'Accuracy_Occupancy')
          };
        });
      
      // If all records were filtered out (all null), treat as empty
      if (parsed.length === 0) {
        this.warnings.push({
          type: 'INFO',
          source,
          message: 'No forecast accuracy history available (expected for first run)'
        });
      }
      
      this.validationResults.forecastAccuracyHistory = {
        valid: true,
        recordCount: parsed.length
      };
      
      return parsed;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing forecast accuracy history (non-critical): ${error.message}`
      });
      this.validationResults.forecastAccuracyHistory = { valid: true, recordCount: 0 };
      return [];
    }
  }

  /**
   * Flag outlier days in historical housestate using dynamic thresholds
   * - Room nights: > 1.5 × maxRooms or < 0
   * Flagged days are marked with isOutlier = true for exclusion in analysis
   * Future: ADR range check (configurable per hotel via Hotel Info)
   */
  flagOutliers(historicalHousestate, hotelInfo) {
    const source = 'OutlierDetection';
    const maxRoomNights = hotelInfo.maxRooms * 1.5;

    let outlierCount = 0;

    historicalHousestate.forEach(day => {
      day.isOutlier = false;

      // Room nights check
      if (day.roomNights > maxRoomNights || day.roomNights < 0) {
        day.isOutlier = true;
        day.outlierReason = `RoomNights ${day.roomNights} outside valid range (0–${maxRoomNights.toFixed(0)})`;
      }

      if (day.isOutlier) outlierCount++;
    });

    // Warn if too many outliers
    const totalDays = historicalHousestate.length;
    const outlierPct = totalDays > 0 ? (outlierCount / totalDays) * 100 : 0;

    if (outlierCount > 0) {
      this.warnings.push({
        type: 'INFO',
        source,
        message: `${outlierCount} of ${totalDays} historical days flagged as outliers (${outlierPct.toFixed(1)}%)`
      });
    }

    if (outlierPct > 10) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `More than 10% of historical data flagged as outliers (${outlierPct.toFixed(1)}%). Consider reviewing data quality.`
      });
    }
  }

  /**
   * Cross-validation checks between datasets
   */
  runCrossValidation(datasets) {
    const source = 'CrossValidation';
    
    // Check if current housestate dates align with calendar
    if (datasets.currentHousestate.length > 0) {
      const firstDate = datasets.currentHousestate[0].date;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const daysDiff = Math.floor((firstDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysDiff < -7 || daysDiff > 7) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Current housestate starts ${Math.abs(daysDiff)} days ${daysDiff > 0 ? 'in the future' : 'in the past'}`
        });
      }
    }
    
    // Check if historical data overlaps with current forecast period
    if (datasets.historicalHousestate.length > 0 && datasets.currentHousestate.length > 0) {
      const histEnd = datasets.historicalHousestate[datasets.historicalHousestate.length - 1].date;
      const currentStart = datasets.currentHousestate[0].date;
      
      const gapDays = Math.floor((currentStart - histEnd) / (1000 * 60 * 60 * 24));
      
      if (gapDays < -30) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Historical data overlaps with current period by ${Math.abs(gapDays)} days`
        });
      }
    }
    
    // Check max rooms consistency
    if (datasets.hotelInfo && datasets.currentHousestate.length > 0) {
      const maxRoomsOTB = Math.max(...datasets.currentHousestate.map(d => d.roomNights));
      
      if (maxRoomsOTB > datasets.hotelInfo.maxRooms) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `OTB data shows ${maxRoomsOTB} room nights, but Max_Rooms is ${datasets.hotelInfo.maxRooms}`
        });
      }
    }
  }

  /**
   * Helper: Parse date from various formats
   */
  parseDate(value, source, context) {
    if (!value) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Missing date value at ${context}`
      });
      return null;
    }
    
    try {
      const date = new Date(value);
      
      if (isNaN(date.getTime())) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Invalid date '${value}' at ${context}`
        });
        return null;
      }
      
      return date;
      
    } catch (error) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Error parsing date '${value}' at ${context}: ${error.message}`
      });
      return null;
    }
  }

  /**
   * Helper: Parse and validate number
   */
  parseNumber(value, source, context, fieldName, required = false) {
    if (value === null || value === undefined || value === '') {
      if (required) {
        this.errors.push({
          type: 'ERROR',
          source,
          message: `Missing required field '${fieldName}' at ${context}`
        });
      }
      return 0;
    }
    
    // Normalise European decimal comma → period ("1,1" → "1.1") before parsing
    const normalised = typeof value === 'string' ? value.replace(',', '.') : value;
    const num = Number(normalised);

    if (isNaN(num)) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Invalid number '${value}' for ${fieldName} at ${context}`
      });
      return 0;
    }
    
    return num;
  }

  /**
   * Helper: Validate weekday
   */
  validateWeekday(value, source, context) {
    const validWeekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    
    if (!value || !validWeekdays.includes(value)) {
      this.warnings.push({
        type: 'WARNING',
        source,
        message: `Invalid weekday '${value}' at ${context}`
      });
      return 'Unknown';
    }
    
    return value;
  }

  /**
   * Generate validation report
   */
  getValidationReport() {
    return {
      summary: {
        totalErrors: this.errors.length,
        totalWarnings: this.warnings.length,
        criticalErrors: this.errors.filter(e => e.type === 'CRITICAL').length,
        canProceed: this.errors.filter(e => e.type === 'CRITICAL').length === 0
      },
      errors: this.errors,
      warnings: this.warnings,
      validationResults: this.validationResults
    };
  }
}

// Export for n8n usage

// ============ N8N EXECUTION CODE ============
const allItems = $input.all();
const allInputs = allItems.map(item => item.json); // strip n8n wrapper

// Housestate days can arrive in two shapes and we must keep BOTH:
//   1. Flat rows  — each item has a date field directly (extractor output;
//                   typically the ~90-day forward OTB window).
//   2. Nested rows — a 'Historical Housestats'/'Historical Housestates' array on a single
//                   item (context.xlsx format; typically the multi-year history).
// Earlier this only collected flat rows, so a nested multi-year history wired in alongside
// the flat OTB rows was silently dropped and history collapsed to ~90 days.
//
// A housestate row's date key is snake_case ('date') in the current parser output and
// PascalCase ('Date') in legacy data — read both so a rename never drops rows.
const hsDate = (row) => (row && (row.date ?? row.Date)) || null;

const flatHousestateRows = allInputs.filter(item =>
  hsDate(item) && !item._summary && !item._errors
);

const nestedHousestateRows = [];
allInputs.forEach(item => {
  const nested = item['Historical Housestats'] || item['Historical Housestates'];
  if (Array.isArray(nested)) {
    nested.forEach(row => {
      if (row && hsDate(row) && !row._summary && !row._errors) nestedHousestateRows.push(row);
    });
  }
});

// Merge, de-duplicating by calendar day (keep the flat row when a day appears in both,
// since the flat OTB feed is the more current representation of recent days).
const seenDays = new Set();
const housestateRows = [...flatHousestateRows, ...nestedHousestateRows].filter(row => {
  const dayKey = String(hsDate(row)).substring(0, 10); // "YYYY-MM-DD"
  if (seenDays.has(dayKey)) return false;
  seenDays.add(dayKey);
  return true;
});

let currentHousestateInput, historicalHousestateInput;

if (housestateRows.length > 0) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  historicalHousestateInput = housestateRows.filter(row => new Date(hsDate(row)) < today);
  currentHousestateInput    = housestateRows.filter(row => new Date(hsDate(row)) >= today);
  console.log(`Housestate split: ${historicalHousestateInput.length} historical days, ${currentHousestateInput.length} OTB days (sources — flat: ${flatHousestateRows.length}, nested: ${nestedHousestateRows.length})`);
} else {
  // Legacy fallback: nested context.xlsx format
  historicalHousestateInput = allInputs;
  currentHousestateInput    = allInputs;
}

const inputData = {
  currentHousestate:       currentHousestateInput,
  hotelInfo:               allInputs.find(obj => obj.Max_Rooms),
  events:                  (allInputs.find(obj => obj.Events) || {}).Events || [],
  trends:                  (allInputs.find(obj => obj.Trends) || {}).Trends || [],
  historicalReservations:  allInputs,
  historicalHousestate:    historicalHousestateInput,
  previousForecast:
    (allInputs.find(obj => obj['Previous Forecasts']) || {})['Previous Forecasts'] || [],
  forecastAccuracyHistory:
    (allInputs.find(obj => obj['Forecast Accuracy History']) || {})['Forecast Accuracy History'] || [],
};

const parser = new DataParserValidator();
const parseResult = parser.parseAllData(inputData);

if (!parseResult.success) {
  console.error('❌ PARSING FAILED');
  console.error('Errors:', parseResult.errors);
  throw new Error('Data parsing failed: ' + JSON.stringify(parseResult.errors));
}

console.log('✅ Data parsed:', parseResult.data.currentHousestate.length, 'days');
return [{ json: parseResult }];
