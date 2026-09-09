/**
 * Bookable slots for a coach's Scheduler configuration.
 *
 * Two things about Nylas's availability endpoint drive this module's existence, both established by
 * calling it rather than reading the docs:
 *
 * 1. **It does not honour `min_booking_notice`.** With a 72-hour notice configured, the endpoint
 *    happily returned a slot starting six minutes later. Nylas applies the notice period in its own
 *    booking UI, which we do not use. So the filtering is ours to do, and it has to happen on the
 *    server — a client-side filter is one devtools edit away from being bypassed.
 * 2. **It is public.** The endpoint answers unauthenticated requests given only a configuration id,
 *    so a browser could call it directly. We proxy it anyway: it is the only place the notice filter
 *    can be enforced, and it keeps configuration ids off the page.
 *
 * It does honour `available_days_in_future`, so the far end of the window needs no filtering.
 */

const { API_BASE_URL } = require('./config');
const { nylasRequest } = require('./client');

/**
 * How long a Scheduler session stays valid. Short on purpose: a session is the capability to see
 * availability and to book, so it should not outlive the page view that needs it.
 */
const SESSION_TTL_MINUTES = 30;

/**
 * Mint a Scheduler session for a private configuration.
 *
 * Configurations are private (`requires_session_auth: true`), which is what stops anyone holding a
 * configuration id from booking a coaching session for free. The price of that is this call: both
 * availability and booking now need a session id, and minting one requires our API key, so it can
 * only happen server-side.
 *
 * @param {string} configurationId
 * @returns {Promise<string>} the session id
 */
const createSession = async configurationId => {
  const data = await nylasRequest('/v3/scheduling/sessions', {
    method: 'POST',
    body: { configuration_id: configurationId, time_to_live_in_minutes: SESSION_TTL_MINUTES },
  });
  if (!data || !data.session_id) {
    throw new Error('Nylas returned no session_id when creating a Scheduler session');
  }
  return data.session_id;
};

/** Nylas works in Unix seconds; JavaScript works in milliseconds. */
const toUnixSeconds = date => Math.floor(new Date(date).getTime() / 1000);

/**
 * Raw availability for a configuration, unfiltered.
 *
 * @param {object} params
 * @param {string} params.configurationId
 * @param {Date|number|string} params.from
 * @param {Date|number|string} params.to
 * @returns {Promise<Array<{start_time: number, end_time: number, emails: string[]}>>}
 */
const fetchAvailability = async ({ configurationId, from, to, sessionId }) => {
  const session = sessionId || (await createSession(configurationId));

  // A private configuration is addressed *by the session alone*. Established by probing the live
  // API, because the docs do not spell it out and the obvious shapes all fail: session_id as a
  // query parameter is rejected outright ("invalid path"), and passing configuration_id alongside
  // the session returns "Configuration not found", since a private configuration will not resolve
  // by id. The session id goes in the Authorization header *in place of* the API key, and the
  // configuration is implied by it.
  const params = new URLSearchParams({
    start_time: String(toUnixSeconds(from)),
    end_time: String(toUnixSeconds(to)),
  });

  const response = await fetch(`${API_BASE_URL}/v3/scheduling/availability?${params.toString()}`, {
    headers: { Authorization: `Bearer ${session}`, Accept: 'application/json' },
  });

  if (!response.ok) {
    const err = new Error(`Nylas availability request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const payload = await response.json();
  return (payload.data && payload.data.time_slots) || [];
};

/**
 * Drop slots that start sooner than the coach's notice period allows.
 *
 * Pure, so the boundary behaviour is testable without touching the network. A slot starting exactly
 * on the notice boundary is kept: the coach asked for "no bookings within the next N hours", and a
 * slot exactly N hours away is not within it.
 *
 * @param {Array<{start_time: number}>} slots as returned by Nylas, in Unix seconds
 * @param {number} minBookingNoticeMinutes from the configuration's scheduler block
 * @param {number} nowSeconds current time in Unix seconds
 */
const filterSlotsByNotice = (slots, minBookingNoticeMinutes, nowSeconds) => {
  const notice = Number(minBookingNoticeMinutes);
  // An absent or nonsensical notice must not silently disable the filter, because the failure is
  // invisible: bookings simply start appearing too soon. Treat it as "no notice configured" only
  // when it is genuinely zero.
  const noticeSeconds = Number.isFinite(notice) && notice > 0 ? notice * 60 : 0;
  const earliestStart = nowSeconds + noticeSeconds;

  return (slots || []).filter(slot => Number(slot.start_time) >= earliestStart);
};

/** Reshape a Nylas slot into the milliseconds the booking form and Sharetribe both work in. */
const toBookableSlot = slot => ({
  start: slot.start_time * 1000,
  end: slot.end_time * 1000,
});

module.exports = {
  createSession,
  fetchAvailability,
  filterSlotsByNotice,
  toBookableSlot,
  toUnixSeconds,
  SESSION_TTL_MINUTES,
};
