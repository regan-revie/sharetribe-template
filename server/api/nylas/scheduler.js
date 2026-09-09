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

const buildConfigurationBody = ({ eventType, coachName, coachEmail, calendarId }) => ({
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
const syncConfiguration = async ({ grantId, eventTypeKey, coachName, coachEmail, calendarId }) => {
  const eventType = getEventType(eventTypeKey);
  if (!eventType) {
    throw new Error(`Unknown Revie event type: ${eventTypeKey}`);
  }

  const body = buildConfigurationBody({ eventType, coachName, coachEmail, calendarId });
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
  getEventType,
  listCalendars,
  listConfigurations,
  defaultCalendarFor,
  buildConfigurationBody,
  syncConfiguration,
};
