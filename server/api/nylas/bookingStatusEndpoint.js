/**
 * GET /api/nylas/booking-status?transactionId=...
 *
 * What the client/coach-facing UI should actually display as "when is this session" - our own
 * database's booking_start/booking_end when we have a row, since a reschedule only ever updates
 * there (see bookingSync.js), never on Sharetribe's own immutable booking record. Falls back to
 * Sharetribe's booking dates when there is no row yet (e.g. the create-booking call has not
 * reached Nylas, or landed, yet) or no database configured at all (local dev).
 */

const { createCookieTokenStore, getSdk, handleError } = require('../../api-util/sdk');
const { isConfigured } = require('./config');
const { loadCalendarBookingTransaction } = require('./manageBookingShared');
const db = require('./db');

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Calendar integration is not configured' });
    return;
  }

  const { transactionId } = req.query || {};
  if (!transactionId) {
    res.status(400).json({ error: 'transactionId is required' });
    return;
  }

  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);

  try {
    const { booking } = await loadCalendarBookingTransaction(sdk, transactionId);

    if (db.isAvailable()) {
      const mappings = await db.findByTransactionId(transactionId);
      const active = mappings.find(m => m.status !== 'cancelled');
      if (active) {
        res.status(200).json({
          source: 'database',
          status: active.status,
          bookingStart: active.booking_start,
          bookingEnd: active.booking_end,
        });
        return;
      }
    }

    res.status(200).json({
      source: 'sharetribe',
      status: null,
      bookingStart: booking?.attributes?.start ?? null,
      bookingEnd: booking?.attributes?.end ?? null,
    });
  } catch (e) {
    if (e.status) {
      handleError(res, e);
      return;
    }
    console.error(`[nylas] Booking status lookup failed for transaction ${transactionId}: ${e.message}`);
    res.status(502).json({ error: 'Could not load booking status' });
  }
};
