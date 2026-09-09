/**
 * Sharetribe Integration API client.
 *
 * Distinct from the Marketplace SDK in `server/api-util/sdk.js`, and needed for one specific
 * reason: `getTrustedSdk` works by exchanging the *logged-in user's* cookie token, so it can only
 * act on behalf of somebody with a live browser session. A Nylas webhook has no user attached, so
 * confirming a booking from one requires credentials that authenticate the application itself.
 *
 * These are separate credentials from the Marketplace API ones: an Integration API application must
 * be created in Sharetribe Console, and its client id and secret set as
 * SHARETRIBE_INTEGRATION_CLIENT_ID and SHARETRIBE_INTEGRATION_CLIENT_SECRET.
 *
 * This client can act as the operator on any transaction, so it is deliberately confined to
 * server/api/nylas/ and never reachable from anything a browser can call.
 */

const integrationSdk = require('sharetribe-flex-integration-sdk');

const CLIENT_ID = process.env.SHARETRIBE_INTEGRATION_CLIENT_ID;
const CLIENT_SECRET = process.env.SHARETRIBE_INTEGRATION_CLIENT_SECRET;

let instance = null;

const isConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/**
 * The shared Integration SDK instance, or null when credentials are absent.
 *
 * Returns null rather than throwing so callers can decide: the webhook handler turns it into a 503
 * and processes nothing, which is safer than half-completing a booking.
 */
const getIntegrationSdk = () => {
  if (!isConfigured()) return null;
  if (!instance) {
    instance = integrationSdk.createInstance({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  }
  return instance;
};

/**
 * Move a transaction with an operator transition.
 *
 * Sharetribe's state machine rejects a transition from a state the transaction has already left,
 * which is what makes redelivered webhooks safe without any de-duplication of our own. That
 * rejection is a normal outcome rather than a fault, so it is reported distinctly from a real
 * failure.
 *
 * @param {string} transactionId
 * @param {string} transition e.g. 'transition/operator-accept'
 * @param {object} [params]
 * @returns {Promise<{ok: boolean, alreadyApplied?: boolean, transaction?: object, error?: Error}>}
 */
const applyTransition = async (transactionId, transition, params = {}) => {
  const sdk = getIntegrationSdk();
  if (!sdk) {
    return { ok: false, error: new Error('Integration API credentials are not configured') };
  }

  try {
    const response = await sdk.transactions.transition({
      id: transactionId,
      transition,
      params,
    });
    return { ok: true, transaction: response.data.data };
  } catch (e) {
    const status = e.status || (e.data && e.data.errors && e.data.errors[0]?.status);
    // 409 is Sharetribe refusing a transition that is not valid from the current state - normally
    // because this webhook has already been processed. Not an error worth alerting on.
    if (status === 409) {
      return { ok: false, alreadyApplied: true };
    }
    return { ok: false, error: e };
  }
};

module.exports = { isConfigured, getIntegrationSdk, applyTransition };
