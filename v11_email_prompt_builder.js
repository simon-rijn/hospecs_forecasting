/**
 * Hotel Revenue Forecasting System - Module 5c: Email Prompt Builder (V11)
 *
 * Builds the prompt for the "Schrijf E-mail AI" node.
 * Takes the plain-text forecast (Row_Type = 'text_report') produced by
 * v11_text_formatter.js and wraps it in a structured system + user prompt.
 *
 * Output: { Row_Type: 'email_prompt', system_prompt, user_prompt, ...meta }
 *
 * N8N wiring:
 *   v11_text_formatter → this node → Schrijf E-mail AI node (OpenAI / Claude)
 *
 * AI node configuration:
 *   System prompt:  {{ $json.system_prompt }}
 *   User message:   {{ $json.user_prompt }}
 */

// ============ N8N EXECUTION CODE ============

const allInputs = $input.all();

const textItem = allInputs.find(item => item.json?.Row_Type === 'text_report');
if (!textItem) {
  throw new Error('Email Prompt Builder V11: no text_report row found.');
}

const { text, hotel_name, report_period, Forecast_Created_At } = textItem.json;

// ── System prompt ─────────────────────────────────────────────────────────────
//
// Edit this section to change the tone, rules, or structure of the email.
// Keep the OUTPUT FORMAT block so the AI returns clean, copy-pasteable email text.

const SYSTEM_PROMPT = `Je bent een revenue manager bij een hotel in Nederland.
Je schrijft wekelijkse begeleidende e-mails over de revenue forecast aan het managementteam.

DOEL VAN DE E-MAIL
De e-mail begeleidt het bijgevoegde forecastrapport. Breng de lezer snel op de hoogte
van wat er speelt, wat aandacht verdient en welke acties relevant zijn — zonder dat zij
het volledige rapport hoeven te lezen.

STIJLREGELS
- Schrijf in het Nederlands, zakelijk maar persoonlijk
- Begin met een korte openingszin over de periode, niet met "Beste" of aanhef (die vult de
  afzender zelf in)
- Maximaal 4 alinea's:
    1. Stand van zaken — één à twee zinnen over de actuele bezetting / OTB
    2. Belangrijkste signalen — max. 3 bullets met de meest opvallende bevindingen
       (kansen én risico's); elke bullet max. 1 zin
    3. Aanbevolen acties — max. 3 concrete, uitvoerbare stappen voor de komende week
    4. Afsluitende zin — kort, positief, nodigt uit tot vragen
- Noem GEEN individuele weekcijfers tenzij ze uitzonderlijk zijn (>20% afwijking)
- Verwijs NIET naar "het rapport" of "de bijlage" — schrijf alsof de e-mail zelfstandig staat
- Gebruik GEEN bullet-symbolen voor de alinea's zelf, alleen voor de bullets in alinea 2 en 3

OUTPUT
Retourneer alleen de e-mailtekst. Geen onderwerpregel, geen aanhef, geen groet.
De tekst begint direct met de openingszin van alinea 1.`;

// ── User prompt ───────────────────────────────────────────────────────────────
//
// Injects the plain-text forecast as context.

const USER_PROMPT = `Schrijf een begeleidende e-mail op basis van de onderstaande forecastdata.

FORECASTRAPPORT — ${hotel_name || 'Hotel'} | ${report_period || ''}
${'─'.repeat(70)}
${text}
${'─'.repeat(70)}

Schrijf de e-mail nu.`;

// ── Output ────────────────────────────────────────────────────────────────────

console.log(`✅ Email Prompt Builder V11: system=${SYSTEM_PROMPT.length} chars | user=${USER_PROMPT.length} chars`);

return [{
  json: {
    Row_Type:            'email_prompt',
    system_prompt:       SYSTEM_PROMPT,
    user_prompt:         USER_PROMPT,
    hotel_name:          hotel_name,
    report_period:       report_period,
    Forecast_Created_At: Forecast_Created_At
  }
}];
