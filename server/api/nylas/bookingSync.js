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
const { isFreeCancellation, TRANSACTION_FIELD } = require('./scheduler');

/**
 * Pull the Sharetribe transaction id out of a booking payload.
 *
 * Confirmed against Nylas's own mock-payload endpoint (POST /v3/webhooks/mock-payload) and a real
 * webhook delivery: additional fields arrive nested under `booking_info.additional_fields`, not at
 * the top level docs and forum posts suggested. Both a plain object and an array of {name, value}
 * pairs are still accepted here, since the value shape once a real field was populated was not
 * something the mock payload (which only ever showed `null`) could confirm.
 */
const extractTransactionId = data => {
  const fields =
    data?.booking_info?.additional_fields ?? data?.customFields ?? data?.custom_fields;
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
 * Also nested under `booking_info`, confirmed the same way as extractTransactionId above.
 * Nylas sends epoch *seconds*, not milliseconds. Treating one as the other silently puts the
 * session fifty years out and would make every cancellation look free.
 */
const extractBookingStart = data => {
  const raw =
    data?.booking_info?.start_time ?? data?.start_time ?? data?.startTime ?? data?.start;
  if (raw == null) return null;
  if (typeof raw === 'number') return new Date(raw * 1000);
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/** Pull the session end time out of a booking payload. Same nesting and epoch-seconds caveat as
 * extractBookingStart above. */
const extractBookingEnd = data => {
  const raw = data?.booking_info?.end_time ?? data?.end_time ?? data?.endTime ?? data?.end;
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
      bookingEnd: extractBookingEnd(data),
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
    // Rescheduling moves the session without touching the money - no Sharetribe transition, no
    // refund logic, same transaction throughout. But Sharetribe's own booking record is immutable
    // once created, so it cannot show the new time: this database row is what does. Decided with
    // Regan - the client/coach-facing "when is this session" surfaces are meant to read from here,
    // not from Sharetribe's now-stale record.
    const mapping = await db.findByBookingId(bookingId);
    if (!mapping) {
      // Same reasoning as the no-transaction-id case above: a reschedule notification for a
      // booking we never recorded did not come from Revie's checkout.
      return { handled: false, reason: 'unknown-booking' };
    }

    await db.recordBooking({
      nylasBookingId: bookingId,
      sharetribeTransactionId: mapping.sharetribe_transaction_id,
      nylasGrantId: mapping.nylas_grant_id,
      bookingStart: extractBookingStart(data) ?? mapping.booking_start,
      bookingEnd: extractBookingEnd(data) ?? mapping.booking_end,
      status: 'rescheduled',
    });
    return { handled: true, action: 'rescheduled' };
  }

  return { handled: false, reason: 'unhandled-trigger' };
};

module.exports = {
  TRANSACTION_FIELD,
  extractTransactionId,
  extractBookingStart,
  extractBookingEnd,
  extractBookingId,
  handleBookingWebhook,
};
