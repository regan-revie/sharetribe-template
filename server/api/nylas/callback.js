/**
 * Handles the coach's return from Nylas Hosted Authentication.
 *
 * Modelled on server/api/login-as.js. Two protections matter here and both come from that file:
 * the state parameter is compared in constant time against the cookie set when the flow started,
 * and the final redirect is forced back onto the marketplace origin so a crafted return path
 * cannot be used as an open redirect.
 */

const crypto = require('crypto');

const { getSdk, getTrustedSdk, createCookieTokenStore } = require('../../api-util/sdk');
const { buildMarketplaceRedirectUrl } = require('../../api-util/url');
const { exchangeCodeForGrant } = require('./client');
const { STATE_COOKIE, RETURN_PATH_COOKIE, callbackUri } = require('./connect');

const ROOT_URL = process.env.REACT_APP_MARKETPLACE_ROOT_URL;
const USING_SSL = process.env.REACT_APP_SHARETRIBE_USING_SSL === 'true';

// Where the coach lands when the flow did not start from a known page.
const DEFAULT_RETURN_PATH = '/';

const isValidState = (state, storedState) => {
  if (typeof state !== 'string' || typeof storedState !== 'string') return false;
  if (state.length === 0 || state.length !== storedState.length) return false;
  return crypto.timingSafeEqual(Buffer.from(state), Buffer.from(storedState));
};

const clearFlowCookies = res => {
  res.clearCookie(STATE_COOKIE, { secure: USING_SSL });
  res.clearCookie(RETURN_PATH_COOKIE, { secure: USING_SSL });
};

// Send the coach back into the app with a result flag the UI can render a message from. Errors are
// deliberately coarse: the coach can only retry, and finer detail would leak flow internals.
const redirectBack = (res, returnPathRaw, status) => {
  const base = buildMarketplaceRedirectUrl(ROOT_URL, returnPathRaw, DEFAULT_RETURN_PATH);
  const separator = base.includes('?') ? '&' : '?';
  res.redirect(`${base}${separator}calendarConnect=${status}`);
};

module.exports = (req, res) => {
  const { code, state, error } = req.query || {};
  const storedState = (req.cookies || {})[STATE_COOKIE];
  const returnPathRaw = (req.cookies || {})[RETURN_PATH_COOKIE];

  if (!isValidState(state, storedState)) {
    clearFlowCookies(res);
    console.error('[nylas] Calendar callback rejected: state did not match.');
    res
      .status(401)
      .type('text/plain')
      .send('Invalid state parameter.');
    return;
  }

  // The coach declined consent, or the provider refused. Not an error on our side.
  if (error) {
    clearFlowCookies(res);
    console.log(`[nylas] Coach did not complete calendar connect: ${error}`);
    redirectBack(res, returnPathRaw, 'declined');
    return;
  }

  if (!code) {
    clearFlowCookies(res);
    redirectBack(res, returnPathRaw, 'failed');
    return;
  }

  clearFlowCookies(res);

  // Share one token store between both SDK instances so a token refresh during the first call is
  // not lost by the second - same reason server/api/delete-account.js does this.
  const tokenStore = createCookieTokenStore(req, res);
  const sdk = getSdk(req, res, tokenStore);

  // Re-check the session: the state cookie proves the flow started here, not who is finishing it.
  sdk.currentUser
    .show()
    .then(() => exchangeCodeForGrant({ code, redirectUri: callbackUri() }))
    .then(grant =>
      getTrustedSdk(req, res, tokenStore).then(trustedSdk =>
        trustedSdk.currentUser.updateProfile({
          // privateData is readable only by this user and by the Integration API, so the grant id
          // never reaches another marketplace user. The Nylas API key, which is what actually
          // grants access to the calendar, stays on the server regardless.
          privateData: {
            nylasGrantId: grant.grantId,
            nylasGrantProvider: grant.provider,
            nylasGrantEmail: grant.email,
          },
          // A public flag so listing and profile UI can show connection state without exposing
          // the grant id itself.
          publicData: {
            calendarConnected: true,
            calendarProvider: grant.provider,
          },
        })
      )
    )
    .then(() => redirectBack(res, returnPathRaw, 'connected'))
    .catch(e => {
      // The authorization code is single use, so there is nothing to retry here - the coach has to
      // start the flow again.
      console.error(`[nylas] Calendar connect failed: ${e.message}`);
      redirectBack(res, returnPathRaw, 'failed');
    });
};
