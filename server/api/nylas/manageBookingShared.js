/**
 * Shared setup for the endpoints that manage a Nylas booking tied to a Sharetribe transaction:
 * create, cancel, reschedule. Factored out so the same checks (who is this, is this listing even
 * calendar-booking-enabled) cannot quietly drift apart between the three.
 */

/** Sharetribe's own pattern for reading a relationship out of an `include`d response (see
 * server/api/transition-privileged.js's getListingRelationShip) - relationships only carry a
 * {id, type} reference, and the real resource lives alongside it in `included`. */
const findIncluded = (included, ref) =>
  ref ? (included || []).find(i => i.id.uuid === ref.id.uuid && i.type === ref.type) : null;

/**
 * Fetch a transaction together with its listing and booking, and resolve the listing's Nylas
 * configuration id if it has one.
 *
 * sdk.transactions.show already refuses (403) a transaction the caller is not a party to, so
 * calling this at all proves they are the customer or provider on it. OrderPanel already refuses
 * to let a provider book their own listing, so in practice this is always the customer.
 *
 * @param {object} sdk a request-scoped Marketplace SDK instance (from getSdk)
 * @param {string} transactionId
 */
const loadCalendarBookingTransaction = async (sdk, transactionId) => {
  const response = await sdk.transactions.show({
    id: transactionId,
    include: ['listing', 'booking'],
  });
  const tx = response.data.data;
  const included = response.data.included;
  const listing = findIncluded(included, tx.relationships?.listing?.data);
  const booking = findIncluded(included, tx.relationships?.booking?.data);

  const publicData = listing?.attributes?.publicData || {};
  const configurationId = publicData.calendarBookingEnabled
    ? publicData.nylasConfigurationId
    : null;

  return { tx, listing, booking, configurationId };
};

module.exports = { findIncluded, loadCalendarBookingTransaction };
