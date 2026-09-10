/**
 * POST /api/nylas/enable-listing
 *
 * A coach opting one of their listings into calendar booking. Requirement #4: Revie defines the
 * event types, the coach chooses which to sell, so this takes an event type key rather than letting
 * a coach describe their own.
 *
 * Body: { listingId, eventTypeKey, calendarId?, minBookingNoticeMinutes? }
 *
 * Does three things, the third of which is easy to miss:
 *  1. Pushes a Nylas Scheduler configuration for the coach's grant.
 *  2. Records the configuration id and notice period on the listing, where the availability
 *     endpoint reads them.
 *  3. Writes a permissive Sharetribe availability plan carrying the calendar's timezone - see
 *     below for why both halves of that matter.
 */

const { createCookieTokenStore, getSdk, handleError, serialize } = require('../../api-util/sdk');
const {
  listCalendars,
  defaultCalendarFor,
  syncConfiguration,
  getEventType,
  SCHEDULING_DEFAULTS,
} = require('./scheduler');
const { isConfigured } = require('./config');

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A deliberately wide-open Sharetribe availability plan.
 *
 * Two separate problems are solved by this, and each would be a silent failure on its own:
 *
 *  - `:action/create-pending-booking` validates the requested time against Sharetribe's own
 *    availability plan. Nylas is the real authority on when a coach is free, so Sharetribe must not
 *    second-guess it: an empty plan would reject every booking Nylas had just offered, surfacing as
 *    a confusing "not available" at checkout.
 *  - `OrderPanel` derives `timeZone` from `availabilityPlan.timezone` and renders **no booking form
 *    at all** without it. So the plan also carries the coach's real calendar timezone, taken from
 *    Nylas - which is the same value that makes the `timezone` listing field redundant.
 */
const permissiveAvailabilityPlan = timezone => ({
  type: 'availability-plan/time',
  timezone,
  entries: WEEKDAYS.map(dayOfWeek => ({
    dayOfWeek,
    startTime: '00:00',
    // End of day is '00:00', not '24:00'. The Marketplace API rejects '24:00' outright with "End
    // time must be in hh:mm format", and '23:59' with "End time must be a multiple of 5 minutes".
    // '24:00' is only the template's *internal* representation - see EditListingAvailabilityPanel.js,
    // which converts it to '00:00' on the way to the API and back again on the way out.
    endTime: '00:00',
    seats: 1,
  })),
});

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Calendar integration is not configured' });
    return;
  }

  const { listingId, eventTypeKey, calendarId, minBookingNoticeMinutes } = req.body || {};

  if (!listingId || !eventTypeKey) {
    res.status(400).json({ error: 'listingId and eventTypeKey are required' });
    return;
  }
  if (!getEventType(eventTypeKey)) {
    res.status(400).json({ error: 'Unknown event type' });
    return;
  }

  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);

  try {
    // Identifies the caller and proves they are logged in. There is no CSRF protection in this
    // codebase, so every state-changing endpoint has to establish who is calling before acting.
    const userResponse = await sdk.currentUser.show();
    const profile = userResponse.data.data.attributes.profile || {};
    const grantId = (profile.privateData || {}).nylasGrantId;

    if (!grantId) {
      res
        .status(409)
        .json({ error: 'Connect a calendar before enabling booking', code: 'no-grant' });
      return;
    }

    // ownListings rather than listings: this refuses a listing the caller does not own, so a coach
    // cannot enable booking on somebody else's listing and point it at their own calendar.
    const listingResponse = await sdk.ownListings.show({ id: listingId });
    const listing = listingResponse.data.data;

    const calendars = await listCalendars(grantId);
    const chosen = calendarId
      ? calendars.find(c => c.id === calendarId && !c.read_only)
      : defaultCalendarFor(calendars);

    if (!chosen) {
      res.status(409).json({
        error: calendarId ? 'That calendar cannot be written to' : 'No writable calendar found',
        code: 'no-calendar',
      });
      return;
    }

    const notice = Number.isFinite(Number(minBookingNoticeMinutes))
      ? Number(minBookingNoticeMinutes)
      : SCHEDULING_DEFAULTS.minBookingNoticeMinutes;

    const { configuration } = await syncConfiguration({
      grantId,
      eventTypeKey,
      coachName: profile.displayName,
      coachEmail: (profile.privateData || {}).nylasGrantEmail || chosen.id,
      calendarId: chosen.id,
      minBookingNoticeMinutes: notice,
    });

    const updated = await sdk.ownListings.update({
      id: listingId,
      publicData: {
        nylasConfigurationId: configuration.id,
        // Stored beside the configuration id by this same call, so the two cannot drift apart.
        nylasMinBookingNoticeMinutes: notice,
        nylasEventTypeKey: eventTypeKey,
        calendarBookingEnabled: true,
      },
      availabilityPlan: permissiveAvailabilityPlan(chosen.timezone),
    });

    res
      .status(200)
      .set('Content-Type', 'application/transit+json')
      .send(
        serialize({
          status: 200,
          statusText: 'OK',
          data: {
            configurationId: configuration.id,
            calendarId: chosen.id,
            timezone: chosen.timezone,
            minBookingNoticeMinutes: notice,
            listingId: updated.data.data.id,
          },
        })
      );
  } catch (e) {
    if (e.status) {
      handleError(res, e);
      return;
    }
    console.error(`[nylas] Enabling calendar booking failed: ${e.message}`);
    res.status(502).json({ error: 'Could not enable calendar booking' });
  }
};

module.exports.permissiveAvailabilityPlan = permissiveAvailabilityPlan;
module.exports.WEEKDAYS = WEEKDAYS;
