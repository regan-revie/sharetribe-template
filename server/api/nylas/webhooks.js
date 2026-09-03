/**
 * Nylas webhook endpoint.
 *
 * Two handlers, because Nylas uses two methods against the same URL:
 *
 *  - GET  with ?challenge=<value>  Nylas's ownership check, sent when a webhook destination is
 *                                  created and whenever it is re-activated. It must be answered
 *                                  within 10 seconds with the exact challenge value and nothing
 *                                  else. Failing this is why a sleeping free-tier host cannot be
 *                                  used - see render.yaml.
 *  - POST with a signed JSON body  the actual notifications.
 *
 * The GET deliberately needs no secret: the secret does not exist until this endpoint has passed
 * the challenge once and the destination has been created.
 */

const { verifySignature, SIGNATURE_HEADER } = require('./signature');
const { WEBHOOK_SECRET, canVerifyWebhooks } = require('./config');

// Scheduler booking triggers we expect to act on. Anything else is acknowledged and ignored, so an
// accidentally over-broad subscription cannot break the endpoint.
const HANDLED_TRIGGERS = [
  'booking.created',
  'booking.pending',
  'booking.rescheduled',
  'booking.cancelled',
];

/**
 * Answer Nylas's ownership challenge by echoing the challenge value verbatim.
 *
 * The response must be the raw value: no JSON wrapper, no quotes, no trailing newline. Sending a
 * string body lets Express set Content-Length, which also avoids the chunked encoding Nylas
 * rejects.
 */
const challenge = (req, res) => {
  const value = req.query && req.query.challenge;

  if (typeof value !== 'string' || value.length === 0) {
    res
      .status(400)
      .type('text/plain')
      .send('Missing challenge query parameter');
    return;
  }

  res
    .status(200)
    .type('text/plain')
    .send(value);
};

/**
 * Receive a webhook notification.
 *
 * Requires `req.rawBody` to hold the unparsed request bytes; the signature is computed over what
 * Nylas actually sent, and a reserialised body will not match.
 */
const receive = (req, res) => {
  // Without a secret we cannot tell a genuine Nylas notification from a forged one, so refuse to
  // act on it. 503 rather than 401: the fault is our missing configuration, not their request.
  if (!canVerifyWebhooks()) {
    console.error(
      '[nylas] Webhook received but NYLAS_WEBHOOK_SECRET is not set, so the signature cannot be ' +
        'verified. Refusing to process. Set the secret returned when the webhook destination was ' +
        'created.'
    );
    res.status(503).json({ error: 'Webhook verification is not configured' });
    return;
  }

  const signature = req.get(SIGNATURE_HEADER);

  if (!verifySignature(req.rawBody, signature, WEBHOOK_SECRET)) {
    console.error('[nylas] Rejected a webhook with a missing or invalid signature.');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const body = req.body || {};
  const trigger = body.type;

  if (!HANDLED_TRIGGERS.includes(trigger)) {
    console.log(`[nylas] Ignoring unhandled webhook trigger: ${trigger}`);
    res.status(200).json({ received: true, handled: false });
    return;
  }

  // Log identifiers only. Booking payloads carry participant names, email addresses and event
  // titles, none of which belong in application logs.
  const data = (body.data && body.data.object) || {};
  const bookingId = data.booking_id || data.id;

  // The Sharetribe transaction id travels in customFields. It is NOT retrievable from the Nylas
  // booking API afterwards, and is not inherited by the event Nylas creates, so this webhook is
  // the only place it ever appears. Once persistence exists it must be written here, on arrival.
  const hasCustomFields = Boolean(data.customFields || data.custom_fields);

  console.log(
    `[nylas] ${trigger} booking=${bookingId || 'unknown'} customFields=${hasCustomFields}`
  );

  // TODO (plan step 8): persist the Nylas booking id to Sharetribe transaction id mapping, then
  // call the privileged transition through the Integration SDK. Both are deliberately absent here:
  // sharetribe-flex-integration-sdk is not yet a dependency, and the mapping needs a durable store.
  // When that lands, acknowledge before doing the work so slow processing cannot cause a timeout.

  res.status(200).json({ received: true, handled: true });
};

module.exports = { challenge, receive, HANDLED_TRIGGERS };
