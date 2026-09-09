/**
 * Persistence for the Nylas booking ↔ Sharetribe transaction mapping.
 *
 * Why this exists at all: a Nylas booking and a Sharetribe transaction are created in two systems
 * that know nothing about each other. When Nylas later says "booking abc was cancelled", we need to
 * know which transaction to refund — and Nylas's own metadata is *not* queryable after the fact, so
 * there is no way to ask it later. The mapping has to be ours.
 *
 * Deliberately one table and no migration framework. A single mapping does not justify the
 * machinery, and an idempotent CREATE TABLE IF NOT EXISTS run at startup is easier to reason about
 * than a migration directory nobody remembers to run.
 *
 * The app runs fine without a database — local development has no Postgres — so every function
 * checks availability rather than assuming a pool exists. Callers surface that as a 503 rather than
 * silently losing a booking, the same way the webhook handler treats a missing signing secret.
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

// Render terminates TLS on its own network and presents a certificate the default trust store does
// not recognise. Verification is disabled only when talking to Render's internal hostname.
const sslConfig = () =>
  DATABASE_URL && /render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined;

let pool = null;

const isAvailable = () => Boolean(DATABASE_URL);

const getPool = () => {
  if (!isAvailable()) return null;
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: sslConfig(), max: 5 });
    // A pool that emits an unhandled 'error' takes the process down. Postgres drops idle clients
    // routinely, so this must be handled rather than left to crash the server.
    pool.on('error', err => console.error('[nylas-db] idle client error:', err.message));
  }
  return pool;
};

const query = async (text, params) => {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not configured');
  return p.query(text, params);
};

/** Create the table if it is missing. Safe to run on every boot. */
const initSchema = async () => {
  if (!isAvailable()) {
    console.error('[nylas-db] DATABASE_URL is not set; booking mappings cannot be stored.');
    return false;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS nylas_bookings (
      nylas_booking_id          text PRIMARY KEY,
      sharetribe_transaction_id text NOT NULL,
      nylas_grant_id            text NOT NULL,
      booking_start             timestamptz,
      status                    text NOT NULL,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Both directions are needed: booking id from a webhook, transaction id when reconciling from
  // the Sharetribe side. The primary key covers the first, this covers the second.
  await query(
    `CREATE INDEX IF NOT EXISTS nylas_bookings_transaction_idx
       ON nylas_bookings (sharetribe_transaction_id)`
  );
  return true;
};

/**
 * Record or update a booking mapping.
 *
 * Upserts on the Nylas booking id, because webhooks can be delivered more than once and a repeated
 * booking.created must not fail on a duplicate key.
 */
const recordBooking = async ({
  nylasBookingId,
  sharetribeTransactionId,
  nylasGrantId,
  bookingStart,
  status,
}) => {
  const { rows } = await query(
    `INSERT INTO nylas_bookings
       (nylas_booking_id, sharetribe_transaction_id, nylas_grant_id, booking_start, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (nylas_booking_id) DO UPDATE
       SET sharetribe_transaction_id = EXCLUDED.sharetribe_transaction_id,
           nylas_grant_id            = EXCLUDED.nylas_grant_id,
           booking_start             = EXCLUDED.booking_start,
           status                    = EXCLUDED.status,
           updated_at                = now()
     RETURNING *`,
    [nylasBookingId, sharetribeTransactionId, nylasGrantId, bookingStart || null, status]
  );
  return rows[0];
};

/** The lookup the webhook handler needs: Nylas booking id → Sharetribe transaction. */
const findByBookingId = async nylasBookingId => {
  const { rows } = await query(`SELECT * FROM nylas_bookings WHERE nylas_booking_id = $1`, [
    nylasBookingId,
  ]);
  return rows[0] || null;
};

/** The reverse, for reconciling or debugging from the Sharetribe side. */
const findByTransactionId = async sharetribeTransactionId => {
  const { rows } = await query(
    `SELECT * FROM nylas_bookings WHERE sharetribe_transaction_id = $1 ORDER BY created_at DESC`,
    [sharetribeTransactionId]
  );
  return rows;
};

const setStatus = async (nylasBookingId, status) => {
  const { rows } = await query(
    `UPDATE nylas_bookings SET status = $2, updated_at = now()
      WHERE nylas_booking_id = $1 RETURNING *`,
    [nylasBookingId, status]
  );
  return rows[0] || null;
};

/** Close the pool. Used by tests; production keeps it open for the process lifetime. */
const close = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

module.exports = {
  isAvailable,
  initSchema,
  recordBooking,
  findByBookingId,
  findByTransactionId,
  setStatus,
  close,
  query,
};
