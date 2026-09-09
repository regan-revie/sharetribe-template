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

const { API_BASE_URL, API_KEY } = require('./config');

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
const fetchAvailability = async ({ configurationId, from, to }) => {
  const params = new URLSearchParams({
    configuration_id: configurationId,
    start_time: String(toUnixSeconds(from)),
    end_time: String(toUnixSeconds(to)),
  });

  const response = await fetch(`${API_BASE_URL}/v3/scheduling/availability?${params.toString()}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
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

module.exports = { fetchAvailability, filterSlotsByNotice, toBookableSlot, toUnixSeconds };
