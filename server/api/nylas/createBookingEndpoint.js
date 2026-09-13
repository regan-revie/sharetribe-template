/**
 * POST /api/nylas/create-booking
 *
 * The missing link discovered by actually running a booking end to end: nothing else in the
 * codebase ever tells Nylas a booking happened. `NylasBookingForm` only feeds Sharetribe's own
 * checkout (price, payment); the availability endpoint only *reads* free/busy time. Without this
 * call, a client can pay in full and the transaction sits at `confirm-payment` forever, because
 * there is no `booking.created` webhook to run `transition/operator-accept` - see
 * server/api/nylas/bookingSync.js, which was built and tested against a signed webhook payload but
 * never had anything upstream to actually send one.
 *
 * Called once, right after the client's payment is confirmed (see
 * src/containers/CheckoutPage/CheckoutPageWithPayment.js). Deliberately does not touch our own
 * database or run any Sharetribe transition itself - that is the webhook's job once Nylas calls
 * back, and duplicating it here would let the two paths drift apart. If this call never reaches
 * Nylas (network drop, tab closed before it fires), the transaction is simply never confirmed and
 * sits at "payment received" - a known gap for the reconciliation/abandoned-booking work in
 * CLAUDE.md's Phase 3, not something this endpoint tries to paper over.
 */

const { createCookieTokenStore, getSdk, handleError } = require('../../api-util/sdk');
const { createBooking } = require('./availability');
const { isConfigured } = require('./config');
const { TRANSACTION_FIELD } = require('./bookingSync');
const { loadCalendarBookingTransaction } = require('./manageBookingShared');

module.exports = async (req, res) => {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Calendar integration is not configured' });
    return;
  }

  const { transactionId } = req.body || {};
  if (!transactionId) {
    res.status(400).json({ error: 'transactionId is required' });
    return;
  }

  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);

  try {
    const [{ tx, configurationId, booking }, userResponse] = await Promise.all([
      loadCalendarBookingTransaction(sdk, transactionId),
      sdk.currentUser.show(),
    ]);

    const hasConfirmedPayment = (tx.attributes.transitions || []).some(
      t => t.transition === 'transition/confirm-payment'
    );
    if (!hasConfirmedPayment) {
      // Guards against a client calling this before paying, which would create a calendar hold
      // with no money behind it.
      res.status(409).json({ error: 'Transaction has not confirmed payment yet' });
      return;
    }

    if (!configurationId) {
      res.status(422).json({ error: 'Listing is not set up for calendar booking' });
      return;
    }

    if (!booking?.attributes?.start || !booking?.attributes?.end) {
      res.status(422).json({ error: 'Transaction has no booking period' });
      return;
    }

    const profile = userResponse.data.data.attributes.profile || {};
    const email = userResponse.data.data.attributes.email;

    const created = await createBooking({
      configurationId,
      start: booking.attributes.start,
      end: booking.attributes.end,
      guest: { name: profile.displayName || email, email },
      additionalFields: { [TRANSACTION_FIELD]: transactionId },
    });

    res.status(200).json({ bookingId: created?.booking_id || created?.id || null });
  } catch (e) {
    if (e.status) {
      handleError(res, e);
      return;
    }
    console.error(`[nylas] Booking creation failed for transaction ${transactionId}: ${e.message}`);
    res.status(502).json({ error: 'Could not create calendar booking' });
  }
};
