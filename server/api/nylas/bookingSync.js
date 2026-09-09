/**
 * Turns a verified Nylas booking webhook into the right Sharetribe transition.
 *
 * Kept apart from webhooks.js so the signature verification there - which is security-critical and
 * proven in production - is not disturbed by changes to booking policy.
 *
 * The policy, decided with Regan and recorded in CLAUDE.md:
 *  - booking.created   → confirm the transaction, capturing payment. Coaches do not approve
 *                        bookings; the calendar already said they were free.
 *  - booking.cancelled → more than 48 hours out, refund. Inside 48 hours, do nothing at all: the
 *                        transaction completes by itself at booking-end + 2 days, so the client
 *                        keeps their charge and the coach is paid.
 */

const db = require('./db');
const { applyTransition, isConfigured: integrationConfigured } = require('./integration');
const { isFreeCancellation } = require('./scheduler');

/** The custom field carrying the Sharetribe transaction id through a Nylas booking. */
const TRANSACTION_FIELD = 'sharetribeTransactionId';

/**
 * Pull the Sharetribe transaction id out of a booking payload.
 *
 * Nylas's own docs and forum posts disagree about whether customFields arrives as an array of
 * {name, value} pairs or as a plain object, and the casing varies between camelCase and snake_case
 * across their surfaces. Rather than guess one shape and fail silently on the other, all of them
 * are accepted. The first real booking will show which is actually sent.
 */
const extractTransactionId = data => {
  const fields = data?.customFields ?? data?.custom_fields;
  if (!fields) return null;

  if (Array.isArray(fields)) {
    const match = fields.find(
      f => f && (f.name === TRANSACTION_FIELD || f.key === TRANSACTION_FIELD)
    );
    return match?.value ?? null;
  }
  if (typeof fields === 'object') {
    return fields[TRANSACTION_FIELD] ?? null;
  }
  return null;
};

/**
 * Pull the session start time out of a booking payload.
 *
 * Nylas sends epoch *seconds*, not milliseconds. Treating one as the other silently puts the
 * session fifty years out and would make every cancellation look free.
 */
const extractBookingStart = data => {
  const raw = data?.start_time ?? data?.startTime ?? data?.start;
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw * 1000);
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const extractBookingId = data => data?.booking_id ?? data?.bookingId ?? data?.id ?? null;

/**
 * Apply a verified booking webhook.
 *
 * @returns {Promise<{handled: boolean, reason?: string, action?: string}>}
 */
const handleBookingWebhook = async ({ trigger, data, grantId }) => {
  const bookingId = extractBookingId(data);
  if (!bookingId) return { handled: false, reason: 'no-booking-id' };

  if (!db.isAvailable()) return { handled: false, reason: 'no-database' };
  if (!integrationConfigured()) return { handled: false, reason: 'no-integration-credentials' };

  if (trigger === 'booking.created' || trigger === 'booking.pending') {
    const transactionId = extractTransactionId(data);

    // A booking with no transaction id was not made through Revie's checkout - most likely someone
    // used the Nylas scheduling page link directly, which is publicly reachable. There is no
    // payment behind it, so there is nothing to confirm; record it and move on rather than guess.
    if (!transactionId) {
      return { handled: false, reason: 'no-transaction-id' };
    }

    await db.recordBooking({
      nylasBookingId: bookingId,
      sharetribeTransactionId: transactionId,
      nylasGrantId: grantId,
      bookingStart: extractBookingStart(data),
      status: trigger === 'booking.created' ? 'created' : 'pending',
    });

    if (trigger === 'booking.pending') return { handled: true, action: 'recorded' };

    const result = await applyTransition(transactionId, 'transition/operator-accept');
    if (result.alreadyApplied) return { handled: true, action: 'already-accepted' };
    if (!result.ok) throw result.error;
    return { handled: true, action: 'accepted' };
  }

  if (trigger === 'booking.cancelled') {
    const mapping = await db.findByBookingId(bookingId);
    if (!mapping) return { handled: false, reason: 'unknown-booking' };

    await db.setStatus(bookingId, 'cancelled');

    const bookingStart = mapping.booking_start ?? extractBookingStart(data);
    if (!bookingStart) {
      // Refusing to guess: without a start time there is no way to tell a free cancellation from a
      // chargeable one, and picking either silently is a billing dispute nobody notices.
      throw new Error(`Cannot decide refund for booking ${bookingId}: no booking start time`);
    }

    if (!isFreeCancellation({ bookingStart, cancelledAt: new Date() })) {
      // Inside 48 hours: deliberately no transition. The transaction completes on its own and the
      // client is charged, which is the policy.
      return { handled: true, action: 'charged-late-cancellation' };
    }

    const result = await applyTransition(mapping.sharetribe_transaction_id, 'transition/cancel');
    if (result.alreadyApplied) return { handled: true, action: 'already-cancelled' };
    if (!result.ok) throw result.error;
    return { handled: true, action: 'refunded' };
  }

  if (trigger === 'booking.rescheduled') {
    // Rescheduling moves the session without touching the money. Sharetribe's booking times cannot
    // be changed in place, so this needs its own design - recorded for now so nothing is lost.
    await db.setStatus(bookingId, 'rescheduled');
    return { handled: true, action: 'recorded-reschedule' };
  }

  return { handled: false, reason: 'unhandled-trigger' };
};

module.exports = {
  TRANSACTION_FIELD,
  extractTransactionId,
  extractBookingStart,
  extractBookingId,
  handleBookingWebhook,
};
