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
  // Public configuration: a client booking a coaching session is not authenticated against Nylas,
  // only against Sharetribe. Session auth would require minting a Nylas session per booker.
  requires_session_auth: false,
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
    // Global platform policy, not a coach setting.
    min_cancellation_notice: SCHEDULING_DEFAULTS.freeCancellationMinutes,
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

module.exports = {
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
