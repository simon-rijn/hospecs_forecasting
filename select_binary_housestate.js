// Filter Housestate v0.12 — 2026-05-18
const PREFIX   = 'forecasting_ai_hotelstatus';
const binaries = $input.first().binary || {};

const key = Object.keys(binaries).find(k =>
  (binaries[k].fileName || k).toLowerCase().includes(PREFIX)
);

if (!key) {
  const found = Object.keys(binaries).map(k => binaries[k].fileName || k).join(', ');
  throw new Error(`Geen binary met "${PREFIX}" gevonden. Aanwezig: ${found || '(geen)'}`);
}

return [{
  json:   { fileName: binaries[key].fileName },
  binary: { data: binaries[key] }
}];
