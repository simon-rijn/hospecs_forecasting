// n8n Code node — Selecteer het reserveringsbestand uit de binaire bestanden
// Zet het gevonden bestand altijd op de vaste key 'data' zodat de
// volgende HTTP Request node altijd inputDataFieldName = "data" kan gebruiken.

const PREFIX = 'forecasting_ai_reserveringen';
const binaries = $input.first().binary || {};

const key = Object.keys(binaries).find(k =>
  (binaries[k].fileName || k).toLowerCase().includes(PREFIX)
);

if (!key) {
  const found = Object.keys(binaries)
    .map(k => binaries[k].fileName || k)
    .join(', ');
  throw new Error(
    `Reserveringsbestand niet gevonden.\n` +
    `Gezocht op prefix: "${PREFIX}"\n` +
    `Beschikbare bestanden: ${found || '(geen binaire bestanden)'}`
  );
}

return [{
  json: $input.first().json,
  binary: { data: $input.first().binary[key] }
}];
