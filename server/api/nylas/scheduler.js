/**
 * Nylas Scheduler configuration sync.
 *
 * Requirement #4: Revie defines the event types, coaches choose which to sell. So the templates
 * live here in code, keyed by Sharetribe listing type id, and a configuration is pushed to a
 * coach's Nylas account when they opt in. Coaches never author event types themselves.
 */

const { nylasRequest } = require('./client');

/**
 * Revie's sellable event types, keyed by the Sharetribe listing type id they correspond to.
 * Keeping the keys identical to Sharetribe's listing type ids is what lets a listing be matched to
 * its Nylas configuration without a separate mapping table.
 */
const EVENT_TYPES = {
  'signature-session': {
    title: 'Signature Session',
    description: 'A coaching session booked through Revie.',
    durationMinutes: 60,
  },
};

/**
 * Revie-wide scheduling defaults. Coaches can override the notice period per coach; the rest are
 * platform policy.
 */
const SCHEDULING_DEFAULTS = {
  // How far ahead a client must book, in minutes. Nylas's own default is 60, which is far too
  // little for a coaching session someone has to prepare for.
  minBookingNoticeMinutes: 24 * 60,
  // How far into the future the calendar is bookable, in days. Capped below at
  // STRIPE_MAX_BOOKING_DAYS.
  availableDaysInFuture: 30,
  // The free-cancellation threshold, in minutes: cancel earlier than this and the client is
  // refunded, cancel later and they are charged. Platform policy rather than a coach preference,
  // so deliberately not overridable per coach.
  //
  // NOTE: setting this on the Nylas configuration only *blocks* the cancellation UI inside the
  // window; it moves no money. The refund half is a Sharetribe concern and does not exist yet -
  // the process has no partial or zero refund action anywhere, so every cancellation route it
  // offers issues a full refund whatever the timing. See CLAUDE.md.
  freeCancellationMinutes: 48 * 60,
};

/**
 * Stripe will not hold a card authorisation indefinitely, and the template caps bookings at 90 days
 * for exactly this reason (see dayCountAvailableForBooking in src/config/configStripe.js). Letting a
 * coach open their calendar further would create bookings whose payment authorisation expires before
 * the session happens, so the value is clamped rather than trusted.
 */
const STRIPE_MAX_BOOKING_DAYS = 90;

const clampBookingWindow = days => {
  const n = Number(days);
  // Checked with Number.isFinite rather than a falsy test: 0 is falsy, so `n || default` would
  // silently hand a coach the default window instead of clamping their zero to the minimum.
  if (!Number.isFinite(n)) return SCHEDULING_DEFAULTS.availableDaysInFuture;
  return Math.max(1, Math.min(Math.round(n), STRIPE_MAX_BOOKING_DAYS));
};

const resolveMinBookingNotice = minutes => {
  const n = Number(minutes);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : SCHEDULING_DEFAULTS.minBookingNoticeMinutes;
};

const getEventType = key => EVENT_TYPES[key];

/** List the calendars on a grant. Requires the calendar.readonly scope. */
const listCalendars = grantId => nylasRequest(`/v3/grants/${grantId}/calendars`);

/**
 * Pick the calendar a coach should sell against when they have not chosen one.
 *
 * Prefers the primary calendar, then the first writable one. Read-only calendars are excluded
 * because Nylas must be able to create booking events on whatever we choose - a subscribed holiday
 * calendar would pass a naive "first result" check and then fail at booking time.
 */
const defaultCalendarFor = calendars => {
  const writable = (calendars || []).filter(c => !c.read_only);
  return writable.find(c => c.is_primary) || writable[0] || null;
};

/** Existing configurations on a grant. */
const listConfigurations = grantId =>
  nylasRequest(`/v3/grants/${grantId}/scheduling/configurations`);

const buildConfigurationBody = ({
  eventType,
  coachName,
  coachEmail,
  calendarId,
  minBookingNoticeMinutes,
  availableDaysInFuture,
}) => ({
  // Private configuration. This is a security control, not a preference.
  //
  // With requires_session_auth false, Nylas hosts a public booking page at book.nylas.com/<slug>
  // and POST /v3/scheduling/bookings accepts unauthenticated requests - verified, it returns 400 on
  // a bad body rather than 401. Anyone holding a configuration id or slug could therefore book a
  // coaching session for free, bypassing Sharetribe and payment entirely: the coach's calendar
  // would fill up and no money would move.
  //
  // Private instead means availability and booking both require a session id minted through
  // POST /v3/scheduling/sessions, which needs our API key. Our server creates one only once
  // Sharetribe has taken payment, so a booking cannot exist without a paid transaction behind it.
  requires_session_auth: true,
  participants: [
    {
      name: coachName,
      email: coachEmail,
      is_organizer: true,
      // Read availability from, and write the booking to, the calendar the coach sells against.
      availability: { calendar_ids: [calendarId] },
      booking: { calendar_id: calendarId },
    },
  ],
  availability: {
    duration_minutes: eventType.durationMinutes,
  },
  scheduler: {
    // The coach's notice period - "no bookings within the next N hours". 72 hours is 4320.
    min_booking_notice: resolveMinBookingNotice(minBookingNoticeMinutes),
    available_days_in_future: clampBookingWindow(availableDaysInFuture),
    // Deliberately 0: a client may always cancel, so the coach's calendar frees up and they know
    // not to expect anyone. Whether the client is *refunded* is decided by isFreeCancellation()
    // below and enforced by which Sharetribe transition the webhook handler calls - not by blocking
    // Nylas's cancel button, which would leave the coach expecting a client who is not coming.
    min_cancellation_notice: 0,
  },
  event_booking: {
    title: eventType.title,
    description: eventType.description,
  },
});

/**
 * Create or update the configuration for one event type on one coach's grant.
 *
 * Idempotent by title: if a configuration for this event type already exists it is updated rather
 * than duplicated, so a coach re-opting-in does not end up selling the same session twice.
 */
const syncConfiguration = async ({
  grantId,
  eventTypeKey,
  coachName,
  coachEmail,
  calendarId,
  minBookingNoticeMinutes,
  availableDaysInFuture,
}) => {
  const eventType = getEventType(eventTypeKey);
  if (!eventType) {
    throw new Error(`Unknown Revie event type: ${eventTypeKey}`);
  }

  const body = buildConfigurationBody({
    eventType,
    coachName,
    coachEmail,
    calendarId,
    minBookingNoticeMinutes,
    availableDaysInFuture,
  });
  const existing = await listConfigurations(grantId);
  const match = (existing || []).find(
    c => c.event_booking && c.event_booking.title === eventType.title
  );

  if (match) {
    const updated = await nylasRequest(
      `/v3/grants/${grantId}/scheduling/configurations/${match.id}`,
      { method: 'PUT', body }
    );
    return { configuration: updated, created: false };
  }

  const created = await nylasRequest(`/v3/grants/${grantId}/scheduling/configurations`, {
    method: 'POST',
    body,
  });
  return { configuration: created, created: true };
};

/**
 * Does a cancellation fall inside the free-cancellation window?
 *
 * This decides money, so it refuses to guess: unparseable or missing times throw rather than
 * defaulting one way. A webhook that throws is retried and surfaced; a webhook that silently picks
 * a refund policy is a billing dispute nobody notices.
 *
 * The boundary is inclusive — cancelling at exactly 48 hours is free — because the generous side of
 * an off-by-one on someone's money is the defensible one.
 *
 * @param {Date|string|number} bookingStart when the session was due to start
 * @param {Date|string|number} cancelledAt when the client cancelled
 * @returns {boolean} true when the client should be refunded
 */
const isFreeCancellation = ({ bookingStart, cancelledAt }) => {
  const start = new Date(bookingStart).getTime();
  const cancelled = new Date(cancelledAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(cancelled)) {
    throw new Error('isFreeCancellation needs a valid bookingStart and cancelledAt');
  }

  const noticeMinutes = (start - cancelled) / 60000;
  return noticeMinutes >= SCHEDULING_DEFAULTS.freeCancellationMinutes;
};

module.exports = {
  isFreeCancellation,
  EVENT_TYPES,
  SCHEDULING_DEFAULTS,
  STRIPE_MAX_BOOKING_DAYS,
  clampBookingWindow,
  resolveMinBookingNotice,
  getEventType,
  listCalendars,
  listConfigurations,
  defaultCalendarFor,
  buildConfigurationBody,
  syncConfiguration,
};
