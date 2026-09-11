/**
 * GET /api/nylas/availability?listingId=…&start=…&end=…
 *
 * The booking form's source of slots. Proxied rather than called from the browser for two reasons:
 * the notice-period filter has to run somewhere a client cannot edit it, and minting the Scheduler
 * session needs the API key.
 *
 * Reads the coach's configuration from the listing's publicData. That is safe now configurations
 * are private - before that change, publishing a configuration id would have let anyone book the
 * coach for free.
 */

const { getSdk, handleError } = require('../../api-util/sdk');
const {
  createSession,
  fetchAvailability,
  filterSlotsByNotice,
  toBookableSlot,
} = require('./availability');
const { isConfigured } = require('./config');

/** Nylas caps the window at available_days_in_future anyway; this stops absurd requests earlier. */
const MAX_WINDOW_DAYS = 120;

const parseWindow = (startRaw, endRaw) => {
  const start = startRaw ? new Date(startRaw) : new Date();
  const end = endRaw ? new Date(endRaw) : new Date(start.getTime() + 30 * 86400000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return { error: 'Invalid start or end' };
  if (end <= start) return { error: 'end must be after start' };
  if (end - start > MAX_WINDOW_DAYS * 86400000)
    return { error: `Window may not exceed ${MAX_WINDOW_DAYS} days` };

  // Never offer slots in the past, however the caller framed the window.
  const now = new Date();
  return { start: start < now ? now : start, end };
};

module.exports = async (req, res) => {
  const { listingId, start: startRaw, end: endRaw } = req.query || {};

  if (!isConfigured()) {
    res.status(503).json({ error: 'Calendar availability is not configured' });
    return;
  }
  if (!listingId) {
    res.status(400).json({ error: 'listingId is required' });
    return;
  }

  const window = parseWindow(startRaw, endRaw);
  if (window.error) {
    res.status(400).json({ error: window.error });
    return;
  }

  try {
    // The caller's own session, so a private marketplace still refuses listings they may not see.
    // On a public marketplace this works for a logged-out visitor too, which it must.
    const sdk = getSdk(req, res);
    const response = await sdk.listings.show({ id: listingId });
    const publicData = response.data.data.attributes.publicData || {};

    const configurationId = publicData.nylasConfigurationId;
    if (!configurationId) {
      // Not an error: the coach simply has not connected a calendar and opted in yet. The form
      // renders an explanatory state rather than an empty calendar that looks broken.
      res.status(200).json({ slots: [], connected: false });
      return;
    }

    const sessionId = await createSession(configurationId);
    const raw = await fetchAvailability({ from: window.start, to: window.end, sessionId });

    // Written alongside the configuration id by the same sync, so the two cannot drift.
    const notice = publicData.nylasMinBookingNoticeMinutes;
    const nowSeconds = Math.floor(Date.now() / 1000);

    // The coach's working hours are applied here rather than through Nylas's default_open_hours,
    // which stores a timezone and then computes the window as UTC. Evaluating each slot against the
    // coach's own week keeps it correct through daylight saving with nothing to re-sync. The zone
    // comes from the availability plan, which enableListing.js fills from the connected calendar.
    const coachTimeZone = response.data.data.attributes.availabilityPlan?.timezone;
    const withinHours = filterSlotsByOpenHours(raw, publicData.nylasOpenHours, coachTimeZone);

    const slots = filterSlotsByNotice(withinHours, notice, nowSeconds).map(toBookableSlot);

    res.status(200).json({ slots, connected: true });
  } catch (e) {
    // A Sharetribe error (listing missing, or not visible to this caller) should surface as itself.
    if (e.status) {
      handleError(res, e);
      return;
    }
    console.error(`[nylas] Availability lookup failed: ${e.message}`);
    res.status(502).json({ error: 'Could not load availability' });
  }
};

module.exports.parseWindow = parseWindow;
module.exports.MAX_WINDOW_DAYS = MAX_WINDOW_DAYS;
