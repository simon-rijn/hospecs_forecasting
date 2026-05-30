// Upsert Reservations v0.12 — 2026-05-18

const input = $input.first().json;
const reservationsArray = input.reservations_array || [];

if (!Array.isArray(reservationsArray) || reservationsArray.length === 0) {
  throw new Error('No reservations_array found or it is empty');
}

const rows = reservationsArray.map(r => ({
  reservation_id:  parseInt(r.reservation_id, 10),
  created_at:      r.created_at      ?? null,
  cancelled_at:    r.cancelled_at    ?? null,
  arrival_date:    r.arrival_date    ?? null,
  departure_date:  r.departure_date  ?? null,
  room_nights:     r.nights          ?? null,
  weekday_arrival: r.weekday_arrival ?? null,
  channel:         r.channel         ?? null,
  rate_code:       r.rate_code       ?? null,
  group_name:      r.group_name      ?? null,
  average_price:   r.average_price   ?? null,
  total_price:     null,
  data_table_id:   null,
  hotel_name:      r.hotelName       ?? null,
}));

console.log(`✅ Upsert reservations: ${rows.length} rows prepared`);

return [{ json: { rows, count: rows.length } }];
