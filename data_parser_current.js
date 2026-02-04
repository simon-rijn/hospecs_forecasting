/**
 * Hotel Revenue Forecasting System - Module 1: Data Parser & Validator
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
          forecastAccuracyHistory
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
        // Find the hotel data object
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
        
        // Get the hotel name key
        const hotelName = Object.keys(hotelObj).find(key => 
          key !== 'Historical Housestats' && key !== 'Historical Reservations'
        );
        hotelData = hotelObj[hotelName];
        
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
      
      // Validate we have close to 90 days
      if (hotelData.length < 85 || hotelData.length > 95) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Expected ~90 days of data, found ${hotelData.length} days`
        });
      }
      
      // Parse and validate each day
      const parsedData = hotelData.map((day, index) => {
        const parsed = {
          date: this.parseDate(day.Date, source, `row ${index + 1}`),
          weekday: this.validateWeekday(day.Weekday, source, `row ${index + 1}`),
          roomNights: this.parseNumber(day.RoomNights, source, `row ${index + 1}`, 'RoomNights'),
          roomRevenue: this.parseNumber(day.RoomRevenue, source, `row ${index + 1}`, 'RoomRevenue'),
          totalRevenue: this.parseNumber(day.TotalRevenue, source, `row ${index + 1}`, 'TotalRevenue'),
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
        growthTrend: this.parseNumber(hotelData.Growth_Trend, source, 'Growth_Trend', 'Growth_Trend') || 1.0
      };
      
      // Validate growth trend limits
      if (parsed.growthTrend < 0.5 || parsed.growthTrend > 2.0) {
        this.errors.push({
          type: 'ERROR',
          source,
          message: `Growth_Trend ${parsed.growthTrend} outside acceptable range (0.5 - 2.0)`
        });
        parsed.growthTrend = Math.max(0.5, Math.min(2.0, parsed.growthTrend));
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
      // Handle both array format and nested format
      let reservationsData = rawData;
      
      if (Array.isArray(rawData)) {
        const reservationsObj = rawData.find(item => item['Historical Reservations']);
        if (reservationsObj) {
          reservationsData = reservationsObj['Historical Reservations'];
        }
      }
      
      if (!Array.isArray(reservationsData)) {
        this.errors.push({
          type: 'CRITICAL',
          source,
          message: 'Historical reservations data is not an array'
        });
        return [];
      }
      
      // Check data age
      const now = new Date();
      const sixMonthsAgo = new Date(now);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      
      let oldestReservation = null;
      let newestReservation = null;
      
      const parsed = reservationsData
        .filter(res => !res.cancelledAt) // Exclude cancelled reservations
        .map((res, index) => {
          const arrivalDate = this.parseDate(res.Arrival_Date, source, `row ${index + 1}`);
          const departureDate = this.parseDate(res.Departure_Date, source, `row ${index + 1}`);
          const createdAt = this.parseDate(res.Reservation_created_at, source, `row ${index + 1}`);
          
          // Track oldest/newest
          if (!oldestReservation || arrivalDate < oldestReservation) {
            oldestReservation = arrivalDate;
          }
          if (!newestReservation || arrivalDate > newestReservation) {
            newestReservation = arrivalDate;
          }
          
          return {
            arrivalDate,
            departureDate,
            nights: this.parseNumber(res.Nights, source, `row ${index + 1}`, 'Nights') || 1,
            weekdayArrival: this.validateWeekday(res.Weekday_Arrival, source, `row ${index + 1}`),
            channel: String(res.Channel || 'Unknown'),
            rateCode: String(res.Rate_Code || ''),
            roomNights: this.parseNumber(res.Room_Nights, source, `row ${index + 1}`, 'Room_Nights') || 1,
            averagePrice: this.parseNumber(res.averagePrice, source, `row ${index + 1}`, 'averagePrice') || 0,
            totalPrice: this.parseNumber(res.totalPrice, source, `row ${index + 1}`, 'totalPrice') || 0,
            createdAt,
            leadtime: arrivalDate && createdAt ? 
              Math.floor((arrivalDate - createdAt) / (1000 * 60 * 60 * 24)) : 
              null
          };
        });
      
      // Check if data is outdated
      if (newestReservation && newestReservation < sixMonthsAgo) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Historical reservations data is outdated (newest: ${newestReservation.toISOString().split('T')[0]}). Using 2-year-old data as fallback.`
        });
      }
      
      this.validationResults.historicalReservations = {
        valid: true,
        recordCount: parsed.length,
        dateRange: oldestReservation && newestReservation ? {
          start: oldestReservation.toISOString().split('T')[0],
          end: newestReservation.toISOString().split('T')[0]
        } : null
      };
      
      return parsed;
      
    } catch (error) {
      this.errors.push({
        type: 'CRITICAL',
        source,
        message: `Error parsing historical reservations: ${error.message}`
      });
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
      if (housestateData.length < 365) {
        this.warnings.push({
          type: 'WARNING',
          source,
          message: `Historical housestate has only ${housestateData.length} days (recommended: 365+)`
        });
      }
      
      const parsed = housestateData.map((day, index) => {
        return {
          date: this.parseDate(day.Date, source, `row ${index + 1}`),
          weekday: this.validateWeekday(day.Weekday, source, `row ${index + 1}`),
          roomNights: this.parseNumber(day.RoomNights, source, `row ${index + 1}`, 'RoomNights'),
          roomRevenue: this.parseNumber(day.RoomRevenue, source, `row ${index + 1}`, 'RoomRevenue'),
          totalRevenue: this.parseNumber(day.TotalRevenue, source, `row ${index + 1}`, 'TotalRevenue')
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
   * - Room nights: > 1.5 × maxRooms
   * - ADR: outside EUR 30–300 range
   * Flagged days are marked with isOutlier = true for exclusion in analysis
   */
  flagOutliers(historicalHousestate, hotelInfo) {
    const source = 'OutlierDetection';
    const maxRoomNights = hotelInfo.maxRooms * 1.5;
    const minADR = 30;
    const maxADR = 300;

    let outlierCount = 0;

    historicalHousestate.forEach(day => {
      day.isOutlier = false;
      const dateStr = day.date ? day.date.toISOString().split('T')[0] : 'unknown';

      // Room nights check
      if (day.roomNights > maxRoomNights || day.roomNights < 0) {
        day.isOutlier = true;
        day.outlierReason = `RoomNights ${day.roomNights} exceeds ${maxRoomNights.toFixed(0)} (1.5 × maxRooms)`;
      }

      // ADR check (only if room nights > 0)
      if (!day.isOutlier && day.roomNights > 0 && day.roomRevenue > 0) {
        const adr = day.roomRevenue / day.roomNights;
        if (adr < minADR || adr > maxADR) {
          day.isOutlier = true;
          day.outlierReason = `ADR €${adr.toFixed(2)} outside range €${minADR}–€${maxADR}`;
        }
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
    
    const num = Number(value);
    
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
module.exports = DataParserValidator;

// Example usage (for testing):
if (require.main === module) {
  console.log('Data Parser Validator Module loaded successfully');
  console.log('Use: const DataParserValidator = require("./1_data_parser_validator.js");');
  console.log('Then: const parser = new DataParserValidator();');
  console.log('Then: const result = parser.parseAllData(inputData);');
}

// ============ N8N EXECUTION CODE ============
const allItems = $input.all();
const allInputs = allItems.map(item => item.json); // strip n8n wrapper

const inputData = {
  // Parser verwacht hier de hele array, en zoekt zelf de hotel-key
  currentHousestate: allInputs,

  // Eén object met Max_Rooms, etc.
  hotelInfo: allInputs.find(obj => obj.Max_Rooms),

  // Parser verwacht een array van events
  events: (allInputs.find(obj => obj.Events) || {}).Events || [],

  // Parser verwacht een array van trends
  trends: (allInputs.find(obj => obj.Trends) || {}).Trends || [],

  // Parser zoekt zelf in de array naar "Historical Reservations"
  historicalReservations: allInputs,

  // Parser zoekt zelf in de array naar "Historical Housestats" of "Historical Housestates"
  historicalHousestate: allInputs,

  // Hier wil hij direct de array "Previous Forecasts"
  previousForecast:
    (allInputs.find(obj => obj['Previous Forecasts']) || {})['Previous Forecasts'] || [],

  // En hier de array "Forecast Accuracy History"
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