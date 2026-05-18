// Forecasting Engine v0.12 — 2026-05-18
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
  constructor(parsedData, historicalAnalysis, reservationsDataFreshness) {
    this.data     = parsedData;
    this.analysis = historicalAnalysis;
    this.hotelInfo = parsedData.hotelInfo;
    this.warnings  = [];
    this.reservationsDataFreshness = reservationsDataFreshness || 'current';
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
        historicalMonthly: this.buildHistoricalMonthly(),
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
    // YoY trend and bias compound as equal factors applied to the historical baseline.
    // Bias is a running accuracy correction updated from previous forecast analysis.
    const trendFactor   = 1 + ((this.analysis.recentTrend.yoyChangePercent || 0) / 100);
    const bias          = this.hotelInfo.bias || 1.0;
    let   roomNightsFinal = Math.round((historicalAvg || 0) * trendFactor * bias);

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
      forecastRangeLow:  Math.max(otb.roomNights, Math.round(roomNightsFinal * (1 - variancePct / 100))),
      forecastRangeHigh: Math.min(weekCapacity, Math.round(roomNightsFinal * (1 + variancePct / 100))),

      // Partial week metadata (current week only)
      isPartialWeek: forecastableDays < 7,
      daysElapsed:   7 - forecastableDays,

      // Supplementary diagnostics — passed through to Meta object in AI processor
      svbRaw:               parseFloat(svb.toFixed(1)),
      otbFillRate:          parseFloat(otbFillRate.toFixed(3)),
      historicalADRFallback: parseFloat(fallbackADR.toFixed(2)),
      adrSource:            otb.roomNights >= 10 ? 'otb' : 'historical',

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
    const ratios  = this.analysis.revenueRatios || {};

    const fmt    = (pct) => pct != null ? (pct >= 0 ? `+${pct}%` : `${pct}%`) : 'n/b';
    const fmtEur = (n)   => n   != null ? `€${Math.round(n).toLocaleString('nl-NL')}` : 'n/b';

    // ── Derived: YoY trend direction (vroege vs. late weken) ──────────────────
    const yoyValues = weeklyForecast.map(w => w.yoyVsLYPct).filter(v => v != null);
    const earlyYoY  = yoyValues.slice(0, 6);
    const lateYoY   = yoyValues.slice(6);
    const avgEarly  = earlyYoY.length > 0
      ? parseFloat((earlyYoY.reduce((s, v) => s + v, 0) / earlyYoY.length).toFixed(1)) : null;
    const avgLate   = lateYoY.length > 0
      ? parseFloat((lateYoY.reduce((s, v) => s + v, 0) / lateYoY.length).toFixed(1))  : null;
    const trendDir  = (avgEarly != null && avgLate != null)
      ? ((avgLate - avgEarly) > 1.5  ? 'VERBETEREND'
       : (avgLate - avgEarly) < -1.5 ? 'VERSLECHTEREND'
       : 'STABIEL')
      : 'onbekend';

    // ── Derived: maandtotalen (Thursday-regel) ────────────────────────────────
    const MONTH_NL = ['Januari','Februari','Maart','April','Mei','Juni',
                      'Juli','Augustus','September','Oktober','November','December'];
    const monthMap = new Map();
    weeklyForecast.forEach(w => {
      const mon = new Date(w.weekStart);
      mon.setDate(mon.getDate() + 3); // Thursday
      const mk = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}`;
      if (!monthMap.has(mk)) {
        monthMap.set(mk, {
          label: `${MONTH_NL[mon.getMonth()]} ${mon.getFullYear()}`,
          otb: 0, forecast: 0, capacity: 0, revenue: 0, weeks: 0
        });
      }
      const m = monthMap.get(mk);
      m.weeks    += 1;
      m.otb      += w.otbRoomNights;
      m.forecast += w.roomNightsFinal;
      m.capacity += w.capacity;
      m.revenue  += w.estTotalRevenue;
    });
    const monthLines = Array.from(monthMap.values()).map(m => {
      const fillPct = m.forecast > 0 ? Math.round(m.otb / m.forecast * 100) : 0;
      const occPct  = m.capacity > 0 ? parseFloat((m.forecast / m.capacity * 100).toFixed(1)) : 0;
      return `  ${m.label}: ${m.weeks} wkn | OTB ${m.otb} RN (${fillPct}% van fcst) | Fcst ${m.forecast} RN (${occPct}% bez.) | Est. ${fmtEur(m.revenue)}`;
    }).join('\n');

    // ── Per-week lines ─────────────────────────────────────────────────────────
    const weekLines = weeklyForecast.map(w => {
      const paceStr = w.daysUntilWeekStart <= 0
        ? '[lopende week]'
        : `${w.daysUntilWeekStart} dgn tot start`;

      const fillPct    = Math.round(w.otbFillRate * 100);
      const pickupConc = w.roomNightsFinal > 0
        ? Math.round(w.pickup / w.roomNightsFinal * 100) : 0;

      // ADR delta
      const adrDelta    = w.otbADR != null && w.historicalADRFallback > 0
        ? parseFloat((w.otbADR - w.historicalADRFallback).toFixed(2)) : null;
      const adrDeltaPct = adrDelta != null && w.historicalADRFallback > 0
        ? parseFloat((adrDelta / w.historicalADRFallback * 100).toFixed(1)) : null;
      const otbADRStr   = w.otbADR != null ? `€${w.otbADR}` : 'onvoldoende OTB';
      const deltaStr    = adrDelta != null
        ? `${adrDelta >= 0 ? '+' : ''}€${adrDelta} (${adrDeltaPct >= 0 ? '+' : ''}${adrDeltaPct}%)`
        : 'n/b';

      // RevPAR
      const revpar = w.capacity > 0 ? Math.round(w.estRoomRevenue / w.capacity) : null;

      // Historical by year
      const histStr = Object.entries(w.historicalByYear)
        .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
        .map(([yr, rn]) => {
          const isLY = parseInt(yr) === parseInt(w.weekKey.split('-')[0]) - 1;
          return `${yr}: ${rn}${w.lyEstimated && isLY ? ' (geschat)' : ''}`;
        }).join(' | ');

      // Risk flag
      let riskLine = '';
      if (w.otbFillRate < 0.25 && w.daysUntilWeekStart > 0 && w.daysUntilWeekStart <= 14) {
        riskLine = `\n  ⚠ HOOG RISICO  : OTB slechts ${fillPct}% — ${w.daysUntilWeekStart} dagen tot weekstart, ${w.pickup} RN nog nodig`;
      } else if (w.otbFillRate < 0.45 && w.daysUntilWeekStart > 0 && w.daysUntilWeekStart <= 21) {
        riskLine = `\n  ⚠ MEDIUM RISICO: OTB ${fillPct}% — ${w.daysUntilWeekStart} dagen tot weekstart, ${w.pickup} RN nog nodig`;
      }

      // Events
      const eventLine = w.events.length > 0
        ? `\n  Events     : ${w.events.map(e => `${e.name} (+${e.pickupImpact} RN)`).join(', ')}`
        : '';

      return (
        `[${w.weekKey}] ${w.weekStart}–${w.weekEnd} (${paceStr})\n` +
        `  Volume     : Fcst ${w.roomNightsFinal} RN | OTB ${w.otbRoomNights} RN (${fillPct}% vol) | Pickup nodig ${w.pickup} (${pickupConc}% van fcst) | Cap ${w.capacity} | Bez ${w.occupancyPct}%\n` +
        `  Prijs      : OTB ADR ${otbADRStr} (bron: ${w.adrSource}) | Hist. ADR €${w.historicalADRFallback} | Delta ${deltaStr}\n` +
        `  Omzet      : Kamer ${fmtEur(w.estRoomRevenue)} | F&B ${fmtEur(w.estFBRevenue)} | Totaal ${fmtEur(w.estTotalRevenue)} | RevPAR ${fmtEur(revpar)}\n` +
        `  Risico     : Variance ±${w.variancePct}% (SVB ${w.svbRaw}) | Bandbreedte ${w.forecastRangeLow}–${w.forecastRangeHigh} RN | YoY vs LY: ${fmt(w.yoyVsLYPct)}\n` +
        `  Historisch : ${histStr || 'geen data'}` +
        eventLine +
        riskLine
      );
    }).join('\n\n');

    // ── Full prompt ────────────────────────────────────────────────────────────
    return (
      `Je bent een hotel revenue forecasting analist. Een algoritme heeft de onderstaande weekforecast al gegenereerd.\n` +
      `Jouw rol is om de forecast te verbinden met de historische analyse en te verklaren wat de cijfers betekenen.\n` +
      `Pas GEEN getallen aan. Genereer GEEN nieuwe forecasts.\n\n` +

      `HOTEL: ${hotel.hotelName || 'Hotel'} (${hotel.hotelType || 'hotel'}, max ${hotel.maxRooms} kamers/nacht)\n\n` +

      (hotel.hotelContext
        ? `━━━ HOTELCONTEXT ━━━\n${hotel.hotelContext}\n\n`
        : '') +

      `━━━ OMZETSTRUCTUUR (historisch gemiddeld) ━━━\n` +
      `F&B ratio: ${ratios.overallFBRatio ? ratios.overallFBRatio.toFixed(2) : 'n/b'}× kameromzet | ` +
      `Overig ratio: ${ratios.overallOtherRatio ? ratios.overallOtherRatio.toFixed(2) : 'n/b'}× kameromzet\n\n` +

      `━━━ RECENTE TREND ━━━\n` +
      `Laatste 4 weken vs. LY: ${fmt(recent.yoyChangePercent)} ` +
      `(${recent.last4WeeksActual || 0} RN vs ${recent.last4WeeksSameLastYear || 0} RN LY)\n` +
      `Vorige maand (${monthly.monthName || '—'}): ${fmt(monthly.yoyChangePercent)} ` +
      `(${monthly.previousMonthActual || 0} RN vs ${monthly.previousMonthLastYear || 0} RN LY)\n\n` +

      `━━━ YOY TRENDRICHTING OVER DE HORIZON ━━━\n` +
      `Vroege weken (W1–W6): gem. YoY ${avgEarly != null ? fmt(avgEarly) : 'n/b'}\n` +
      `Late weken  (W7–W12): gem. YoY ${avgLate  != null ? fmt(avgLate)  : 'n/b'}\n` +
      `Richting: ${trendDir}\n\n` +

      `━━━ MAANDTOTALEN (12-weeks horizon) ━━━\n` +
      `${monthLines}\n\n` +

      `━━━ RESERVERINGSANALYSE ━━━\n` +
      this.buildReservationSection() + `\n\n` +

      `━━━ WEEKDETAILS ━━━\n` +
      `${weekLines}\n\n` +

      `Antwoord UITSLUITEND met geldige JSON — geen extra tekst of markdown fences:\n` +
      `{\n` +
      `  "volume_diagnosis": [\n` +
      `    "verklaring waarom het volume hoger of lager is dan verwacht — combineer altijd ≥2 databronnen"\n` +
      `  ],\n` +
      `  "week_signals": [\n` +
      `    {\n` +
      `      "week_key": "JJJJ-WNN",\n` +
      `      "level": "high|medium|info",\n` +
      `      "diagnosis": "waarom is er meer of minder geboekt dan verwacht",\n` +
      `      "action": "wat te doen — alleen invullen bij level high of medium"\n` +
      `    }\n` +
      `  ],\n` +
      `  "anomalies": [\n` +
      `    "tegenstrijdigheid die alleen zichtbaar is door data te kruisen (1–3 items)"\n` +
      `  ],\n` +
      `  "data_gaps": [\n` +
      `    "ontbrekende data die een conclusie zou veranderen — formuleer als concrete vraag (1–3 items)"\n` +
      `  ]\n` +
      `}\n\n` +
      `Richtlijnen:\n\n` +
      `KERNVRAAG: waarom is er meer of minder geboekt dan verwacht, waar komt dit vandaan, en wat is eraan te doen?\n\n` +
      `- volume_diagnosis (2–4 items): verklaar het volumepatroon vanuit de data. Gebruik altijd ≥2 bronnen per conclusie.\n` +
      `  Relevante verbanden:\n` +
      `  · Segmentmix vs historisch → groepsaandeel hoger/lager dan normaal verklaart volume én ADR\n` +
      `  · Kanaalverschuiving → welk kanaal levert minder dan historisch verwacht, en hoeveel volume mist daardoor\n` +
      `    ⚠ GDS-Reconline is een verzamelkanaal (meerdere GDS-bronnen). Als dit kanaal afwijkt, formuleer dan:\n` +
      `    "Nader onderzoek per GDS-sub-kanaal nodig om te bepalen welke bron onderpresteert."\n` +
      `  · Leadtime vs fill rate → is de huidige OTB normaal gegeven de typische boekingshorizon, of werkelijk te laag\n` +
      `  · Annuleringsrate → stijgende annulering verklaart waarom hoge OTB toch niet tot volume leidt\n` +
      `  · YoY trend → bevestigt of weerspreekt het volumepatroon in de individuele weken\n\n` +
      `- week_signals: alleen weken met een duidelijk afwijkende situatie.\n` +
      `  level = high (directe actie vereist binnen 1 week), medium (bij te sturen binnen 2–3 weken), info (context zonder urgentie).\n` +
      `  diagnosis: één zin die uitlegt WAAROM het volume afwijkt — verwijs naar specifieke datapunten.\n` +
      `  action (alleen bij high/medium): concreet en uitvoerbaar. Bijv. welk segment te activeren,\n` +
      `  welk kanaal in te zetten, of wanneer het moment van bijsturen voorbij is.\n\n` +
      `- anomalies: tegenstrijdigheden die alleen zichtbaar zijn door data te kruisen.\n` +
      `  Bijv.: hoge fill rate maar dalend individueel aandeel → volume groeit maar prijsmacht neemt af.\n` +
      `  OTB ADR lager dan historisch terwijl groepsaandeel boven normaal → geen echte prijsdaling.\n` +
      `  Stijgende annuleringsrate + hoge OTB → netto vraag is lager dan het lijkt.\n\n` +
      `- data_gaps: wat ontbreekt om een conclusie te bevestigen of te weerleggen.\n` +
      `  Formuleer als een vraag: "Als [ontbrekende data] beschikbaar was, zou duidelijk worden of..."`
    );
  }

  // ─── Reservation analysis section for AI prompt ──────────────────────────────

  /**
   * Builds the RESERVERINGSANALYSE block for the AI prompt.
   * Aggregates segmentation, channel breakdown, leadtime, cancellation, and
   * average-price data from the historical analysis into human-readable text.
   * Returns "[Geen reserveringsdata beschikbaar]" when all analyses are null.
   */
  buildReservationSection() {
    const seg   = this.analysis.segmentation;
    const ch    = this.analysis.channelBreakdown;
    const lt    = this.analysis.leadtimeProfile;
    const canc  = this.analysis.cancellationProfile;
    const price = this.analysis.avgPriceBySegment;
    const fresh = this.reservationsDataFreshness;

    let out = '';

    if (fresh === 'stale_1week') {
      out += `⚠ RESERVERINGSDATA 1 WEEK OUD (bestand ontbrak bij run)\n`;
    }

    if (!seg && !ch && !lt && !canc && !price) {
      out += `[Geen reserveringsdata beschikbaar]\n`;
      return out;
    }

    // ── Local helpers ──────────────────────────────────────────────────────────

    const pct    = (n, t) => t > 0 ? `${(n / t * 100).toFixed(0)}%` : 'n/b';
    const signN  = (n)    => n >= 0 ? `+${n}` : `${n}`;
    const fmtEur = (n)    => n != null ? `€${parseFloat(n).toFixed(2)}` : 'n/b';

    // Sum group + individual RN across all by_month cells of a window
    const aggSegRN = (winData) => {
      if (!winData) return null;
      let grp = 0, ind = 0;
      for (const cell of Object.values(winData.by_month || {})) {
        grp += cell.groups?.rn || 0;
        ind += cell.individuals?.rn || 0;
      }
      return { grp, ind, total: grp + ind };
    };

    // Aggregate channel RN across by_month → { channelName: { groups, individuals } }
    const aggChannelRN = (winData) => {
      if (!winData) return {};
      const totals = {};
      for (const cell of Object.values(winData.by_month || {})) {
        for (const [name, rn] of Object.entries(cell.groups || {})) {
          if (!totals[name]) totals[name] = { groups: 0, individuals: 0 };
          totals[name].groups += rn;
        }
        for (const [name, rn] of Object.entries(cell.individuals || {})) {
          if (!totals[name]) totals[name] = { groups: 0, individuals: 0 };
          totals[name].individuals += rn;
        }
      }
      return totals;
    };

    // Weighted average of per-month leadtime stats (median/p25/p75 weighted by n)
    const aggLeadtime = (winData) => {
      if (!winData) return { groups: null, individuals: null };
      let gWm = 0, gWp25 = 0, gWp75 = 0, gN = 0;
      let iWm = 0, iWp25 = 0, iWp75 = 0, iN = 0;
      for (const cell of Object.values(winData.by_month || {})) {
        const g = cell.groups, i = cell.individuals;
        if (g?.median_days != null && g.n > 0) {
          gWm += g.median_days * g.n; gWp25 += g.p25_days * g.n;
          gWp75 += g.p75_days * g.n; gN += g.n;
        }
        if (i?.median_days != null && i.n > 0) {
          iWm += i.median_days * i.n; iWp25 += i.p25_days * i.n;
          iWp75 += i.p75_days * i.n; iN += i.n;
        }
      }
      return {
        groups:      gN > 0 ? { median: Math.round(gWm / gN), p25: Math.round(gWp25 / gN), p75: Math.round(gWp75 / gN), n: gN } : null,
        individuals: iN > 0 ? { median: Math.round(iWm / iN), p25: Math.round(iWp25 / iN), p75: Math.round(iWp75 / iN), n: iN } : null
      };
    };

    // Weighted average price across by_month cells (weighted by RN)
    const aggPrice = (winData) => {
      if (!winData) return { groups: { price: null, rn: 0 }, individuals: { price: null, rn: 0 } };
      let gPN = 0, gN = 0, iPN = 0, iN = 0;
      for (const cell of Object.values(winData.by_month || {})) {
        if (cell.groups?.avg_price != null && cell.groups?.rn > 0) {
          gPN += cell.groups.avg_price * cell.groups.rn; gN += cell.groups.rn;
        }
        if (cell.individuals?.avg_price != null && cell.individuals?.rn > 0) {
          iPN += cell.individuals.avg_price * cell.individuals.rn; iN += cell.individuals.rn;
        }
      }
      return {
        groups:      { price: gN > 0 ? parseFloat((gPN / gN).toFixed(2)) : null, rn: gN },
        individuals: { price: iN > 0 ? parseFloat((iPN / iN).toFixed(2)) : null, rn: iN }
      };
    };

    const parts = [];

    // ── 1. Segmentation ────────────────────────────────────────────────────────
    if (seg) {
      const p8cy  = aggSegRN(seg.past_8w_cy);
      const p8ly  = aggSegRN(seg.past_8w_ly);
      const o12cy = aggSegRN(seg.otb_12w_cy);

      const lines = [`SEGMENTATIE (RN verdeling)`];
      if (p8cy && p8cy.total > 0) {
        let yoyStr = '';
        if (p8ly && p8ly.total > 0) {
          const d = parseFloat(((p8cy.grp / p8cy.total - p8ly.grp / p8ly.total) * 100).toFixed(1));
          yoyStr = ` | YoY groep-aandeel: ${signN(d)}pp`;
        }
        lines.push(`  Afgelopen 8w CY: Groepen ${p8cy.grp} RN (${pct(p8cy.grp, p8cy.total)}) | Individueel ${p8cy.ind} RN (${pct(p8cy.ind, p8cy.total)}) | Totaal ${p8cy.total} RN${yoyStr}`);
      }
      if (p8ly && p8ly.total > 0) {
        lines.push(`  Afgelopen 8w LY: Groepen ${p8ly.grp} RN (${pct(p8ly.grp, p8ly.total)}) | Individueel ${p8ly.ind} RN (${pct(p8ly.ind, p8ly.total)}) | Totaal ${p8ly.total} RN`);
      }
      if (o12cy && o12cy.total > 0) {
        lines.push(`  OTB 12w CY:      Groepen ${o12cy.grp} RN (${pct(o12cy.grp, o12cy.total)}) | Individueel ${o12cy.ind} RN (${pct(o12cy.ind, o12cy.total)}) | Totaal ${o12cy.total} RN`);
      }
      if ((!p8cy || p8cy.total === 0) && (!p8ly || p8ly.total === 0) && (!o12cy || o12cy.total === 0)) {
        lines.push(`  [Geen segmentatiedata]`);
      }
      parts.push(lines.join('\n'));
    }

    // ── 2. Channel breakdown ───────────────────────────────────────────────────
    // Channel display name aliases — update DIRECT_WEBSITE_CHANNEL when the
    // actual channel name for the hotel's own website becomes known.
    const DIRECT_WEBSITE_CHANNEL = 'unknown';   // placeholder — replace with real channel name
    const CHANNEL_ALIASES = {
      [DIRECT_WEBSITE_CHANNEL]: 'Eigen website'
    };
    const displayName = (name) => CHANNEL_ALIASES[name] || name;

    if (ch) {
      const chTotals = aggChannelRN(ch.past_8w_cy);
      const sorted = Object.entries(chTotals)
        .map(([name, v]) => ({ name, total: v.groups + v.individuals, groups: v.groups, individuals: v.individuals }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);

      const hasGDS = sorted.some(c => c.name === 'GDS-Reconline');

      const lines = [`KANAALVERDELING (afgelopen 8w CY, top ${sorted.length || 1})`];
      if (sorted.length === 0) {
        lines.push(`  [Geen kanaaldata]`);
      } else {
        sorted.forEach(c => {
          lines.push(`  ${displayName(c.name)}: ${c.total} RN (groepen ${c.groups} | individueel ${c.individuals})`);
        });
        if (hasGDS) {
          lines.push(`  ⚠ GDS-Reconline is een verzamelkanaal van meerdere bronnen (bijv. Amadeus, Sabre, Galileo). Conclusies over dit kanaal vereisen nader onderzoek per sub-kanaal.`);
        }
      }
      parts.push(lines.join('\n'));
    }

    // ── 3. Leadtime profile ────────────────────────────────────────────────────
    if (lt) {
      const p8cy = aggLeadtime(lt.past_8w_cy);
      const p8ly = aggLeadtime(lt.past_8w_ly);

      const lines = [`BOEKINGSHORIZON (gewogen mediaan leadtime, afgelopen 8w)`];
      if (!p8cy.groups && !p8cy.individuals) {
        lines.push(`  [Geen leadtime-data]`);
      } else {
        if (p8cy.groups) {
          const lyStr = p8ly.groups
            ? ` | LY mediaan: ${p8ly.groups.median}d (delta: ${signN(p8cy.groups.median - p8ly.groups.median)}d)`
            : '';
          lines.push(`  Groepen CY:     mediaan ${p8cy.groups.median}d | p25 ${p8cy.groups.p25}d | p75 ${p8cy.groups.p75}d (${p8cy.groups.n} res.)${lyStr}`);
        }
        if (p8cy.individuals) {
          const lyStr = p8ly.individuals
            ? ` | LY mediaan: ${p8ly.individuals.median}d (delta: ${signN(p8cy.individuals.median - p8ly.individuals.median)}d)`
            : '';
          lines.push(`  Individueel CY: mediaan ${p8cy.individuals.median}d | p25 ${p8cy.individuals.p25}d | p75 ${p8cy.individuals.p75}d (${p8cy.individuals.n} res.)${lyStr}`);
        }
      }
      parts.push(lines.join('\n'));
    }

    // ── 4. Cancellation profile ────────────────────────────────────────────────
    if (canc) {
      const lines = [`ANNULERINGSPATROON (afgelopen 8w, per maand CY vs LY)`];
      const monthEntries = Object.entries(canc.by_month || {}).sort(([a], [b]) => a.localeCompare(b));
      if (monthEntries.length === 0) {
        lines.push(`  [Geen annuleringsdata]`);
      } else {
        monthEntries.forEach(([mk, entry]) => {
          const cy = entry.cy;
          if (!cy || cy.cancellation_rate_pct == null) return;
          const yoyStr = entry.yoy_rate_delta_pct != null
            ? ` | YoY delta: ${signN(entry.yoy_rate_delta_pct)}pp`
            : '';
          lines.push(`  ${mk}: ${cy.cancellation_rate_pct}% (${cy.cancelled}/${cy.total_reservations}) | groepen ${cy.groups?.rate_pct ?? 'n/b'}% | ind. ${cy.individuals?.rate_pct ?? 'n/b'}%${yoyStr}`);
        });
      }
      parts.push(lines.join('\n'));
    }

    // ── 5. Average price by segment ────────────────────────────────────────────
    if (price) {
      const p8cy  = aggPrice(price.past_8w_cy);
      const p8ly  = aggPrice(price.past_8w_ly);
      const o12cy = aggPrice(price.otb_12w_cy);

      const deltaStr = (cyCell, lyCell) => {
        if (!cyCell?.price || !lyCell?.price) return '';
        const d = parseFloat((cyCell.price - lyCell.price).toFixed(2));
        return ` | LY: ${fmtEur(lyCell.price)} (delta: ${d >= 0 ? '+' : ''}€${d})`;
      };

      const lines = [`GEMIDDELDE KAMERPRIJS PER SEGMENT`];
      let hasData = false;
      if (p8cy.groups.price != null) {
        hasData = true;
        lines.push(`  Groepen 8w CY:       ${fmtEur(p8cy.groups.price)} (${p8cy.groups.rn} RN)${deltaStr(p8cy.groups, p8ly.groups)}`);
      }
      if (p8cy.individuals.price != null) {
        hasData = true;
        lines.push(`  Individueel 8w CY:   ${fmtEur(p8cy.individuals.price)} (${p8cy.individuals.rn} RN)${deltaStr(p8cy.individuals, p8ly.individuals)}`);
      }
      if (o12cy.groups.price != null) {
        hasData = true;
        lines.push(`  Groepen OTB 12w:     ${fmtEur(o12cy.groups.price)} (${o12cy.groups.rn} RN)`);
      }
      if (o12cy.individuals.price != null) {
        hasData = true;
        lines.push(`  Individueel OTB 12w: ${fmtEur(o12cy.individuals.price)} (${o12cy.individuals.rn} RN)`);
      }
      if (!hasData) lines.push(`  [Geen prijsdata]`);
      parts.push(lines.join('\n'));
    }

    out += parts.join('\n\n');
    return out;
  }

  // ─── Utility helpers ─────────────────────────────────────────────────────────

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

  buildHistoricalMonthly() {
    // Use daily housestate directly — avoids two systematic errors that arise from
    // routing through weeklyHistoricalData:
    //   1. Thursday-rule misattributes boundary-week days to the wrong calendar month
    //   2. Partial weeks (< 5 days) are dropped entirely, losing up to 4 days of revenue
    // PMS monthly reports use calendar-day attribution, so we must do the same here.
    const dailyData = (this.data.historicalHousestate || []);
    const maxRooms  = this.hotelInfo.maxRooms || 0;
    const today     = new Date();
    const MONTH_NL  = ['Januari','Februari','Maart','April','Mei','Juni',
                       'Juli','Augustus','September','Oktober','November','December'];

    // Past 3 complete calendar months (oldest → newest)
    const targetMonths = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      targetMonths.push({
        key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year:  d.getFullYear(),
        month: d.getMonth()
      });
    }

    // Aggregate directly from daily data by calendar month (YYYY-MM from date string).
    // Outlier days are excluded — same rule as calculateWeeklyHistoricalData.
    const monthAccum = {};
    for (const day of dailyData) {
      if (!day.date || day.isOutlier) continue;
      const mk = day.date.substring(0, 7); // "YYYY-MM-DD" → "YYYY-MM"
      if (!monthAccum[mk]) monthAccum[mk] = { roomNights: 0, roomRevenue: 0, totalRevenue: 0 };
      monthAccum[mk].roomNights    += day.roomNights    || 0;
      monthAccum[mk].roomRevenue   += day.roomRevenue   || 0;
      monthAccum[mk].totalRevenue  += day.totalRevenue  || 0;
    }

    return targetMonths.map(({ key, year, month }) => {
      const cy       = monthAccum[key];
      const lyKey    = `${year - 1}-${String(month + 1).padStart(2, '0')}`;
      const ly       = monthAccum[lyKey];
      const capacity = maxRooms * new Date(year, month + 1, 0).getDate();
      const yoy      = (cy && ly && ly.roomNights > 0)
        ? parseFloat(((cy.roomNights - ly.roomNights) / ly.roomNights * 100).toFixed(1))
        : null;
      return {
        month_key:     key,
        label:         `${MONTH_NL[month]} ${year}`,
        type:          'historical',
        room_nights:   cy ? Math.round(cy.roomNights)   : null,
        room_revenue:  cy ? Math.round(cy.roomRevenue)  : null,
        total_revenue: cy ? Math.round(cy.totalRevenue) : null,
        adr:           (cy && cy.roomNights > 0)
                         ? parseFloat((cy.roomRevenue / cy.roomNights).toFixed(2)) : null,
        occupancy_pct: (cy && capacity > 0)
                         ? parseFloat((cy.roomNights / capacity * 100).toFixed(1)) : null,
        yoy_pct:       yoy
      };
    });
  }

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
const forecaster = new ForecastingEngine(
  input.parseResult.data,
  input.analysisResult.analysis,
  input.analysisResult.reservationsDataFreshness
);
const result     = forecaster.generateWeeklyForecast();

if (!result.success) {
  console.error('❌ FORECAST FAILED:', result.error);
  throw new Error('Forecast generation failed: ' + result.error);
}

const totalRN  = result.weeklyForecast.reduce((s, w) => s + w.roomNightsFinal, 0);
const totalRev = result.weeklyForecast.reduce((s, w) => s + w.estTotalRevenue, 0);
console.log(`✅ Forecast V11: ${result.weeklyForecast.length} weeks | ${totalRN} RN total | €${totalRev.toFixed(0)} est. revenue`);

return [{ json: result }];
