/**
 * POST /api/nylas/reschedule-booking
 *
 * Moves an existing booking to a new time in place - same Nylas booking id, same Sharetribe
 * transaction, no new payment and no refund logic. Nylas's hosted reschedule link cannot do this
 * for the same reason its cancel link cannot - see cancelBookingEndpoint.js.
 *
 * Sharetribe's own booking record is immutable once created, so it is left showing the original
 * time; decided with Regan that our own database becomes the authority on when the session
 * actually is. This endpoint only calls Nylas - db.recordBooking() runs in bookingSync.js once the
 * booking.rescheduled webhook confirms it, so there is exactly one place that writes the new time.
 */

const { createCookieTokenStore, getSdk, handleError } = require('../../api-util/sdk');
const { rescheduleBooking } = require('./availability');
const { isConfigured } = require('./config');
const { loadCalendarBookingTransaction } = require('./manageBookingShared');
const db = require('./db');

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Calendar integration is not configured' });
    return;
  }
  if (!db.isAvailable()) {
    res.status(503).json({ error: 'Booking records are not available' });
    return;
  }

  const { transactionId, start, end } = req.body || {};
  if (!transactionId || !start || !end) {
    res.status(400).json({ error: 'transactionId, start and end are required' });
    return;
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    res.status(400).json({ error: 'start and end must be valid dates' });
    return;
  }
  if (endDate <= startDate) {
    res.status(400).json({ error: 'end must be after start' });
    return;
  }
  if (startDate <= new Date()) {
    res.status(400).json({ error: 'start must be in the future' });
    return;
  }

  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);

  try {
    const { configurationId } = await loadCalendarBookingTransaction(sdk, transactionId);
    if (!configurationId) {
      res.status(422).json({ error: 'Listing is not set up for calendar booking' });
      return;
    }

    const mappings = await db.findByTransactionId(transactionId);
    const active = mappings.find(m => m.status !== 'cancelled');
    if (!active) {
      res.status(409).json({ error: 'No active calendar booking found for this transaction' });
      return;
    }

    await rescheduleBooking({
      configurationId,
      bookingId: active.nylas_booking_id,
      start: startDate,
      end: endDate,
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    if (e.status) {
      handleError(res, e);
      return;
    }
    console.error(`[nylas] Booking reschedule failed for transaction ${transactionId}: ${e.message}`);
    res.status(502).json({ error: 'Could not reschedule the calendar booking' });
  }
};
