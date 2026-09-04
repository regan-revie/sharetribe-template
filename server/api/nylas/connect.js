/**
 * Starts the Nylas Hosted Authentication flow for the logged-in coach.
 *
 * Modelled on server/api/initiate-login-as.js: mint an opaque state value, keep it in a
 * short-lived cookie, and redirect. The callback compares the returned state against that cookie,
 * which is what stops an attacker replaying someone else's authorization code.
 */

const crypto = require('crypto');

const { getSdk } = require('../../api-util/sdk');
const { isRelativePath } = require('../../api-util/url');
const { buildAuthUrl } = require('./client');
const { isConfigured } = require('./config');

const ROOT_URL = process.env.REACT_APP_MARKETPLACE_ROOT_URL;
const USING_SSL = process.env.REACT_APP_SHARETRIBE_USING_SSL === 'true';

const STATE_COOKIE = 'nylas-connect-state';
const RETURN_PATH_COOKIE = 'nylas-connect-return-path';

// Providers a coach may connect. Anything else is rejected rather than passed through, so this
// endpoint cannot be used to probe arbitrary values against Nylas.
const ALLOWED_PROVIDERS = ['google', 'microsoft', 'icloud'];

const callbackUri = () => `${(ROOT_URL || '').replace(/\/$/, '')}/api/nylas/callback`;

const cookieOptions = () => ({
  maxAge: 1000 * 60 * 10, // 10 minutes: long enough to sign in, short enough to be useless later
  httpOnly: true, // nothing in the browser needs to read this
  secure: USING_SSL,
  sameSite: 'Lax', // must survive the provider's cross-site redirect back to us
});

module.exports = (req, res) => {
  if (!isConfigured()) {
    console.error('[nylas] Connect attempted but NYLAS_API_KEY / NYLAS_CLIENT_ID are not set.');
    res.status(503).json({ error: 'Calendar connection is not configured' });
    return;
  }
  if (!ROOT_URL) {
    res.status(409).json({ error: 'Marketplace canonical root URL is missing' });
    return;
  }

  const { provider, returnPath } = req.query || {};

  if (provider && !ALLOWED_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: 'Unsupported calendar provider' });
    return;
  }

  // There is no CSRF protection anywhere in this codebase, so identify the caller before doing
  // anything. A request with no valid session cookie fails here rather than starting a flow that
  // would later attach a calendar to whoever happened to be logged in.
  const sdk = getSdk(req, res);

  sdk.currentUser
    .show()
    .then(response => {
      const currentUser = response.data.data;
      const email = currentUser && currentUser.attributes && currentUser.attributes.email;

      const state = crypto.randomBytes(32).toString('base64url');

      res.cookie(STATE_COOKIE, state, cookieOptions());
      if (returnPath && isRelativePath(returnPath)) {
        res.cookie(RETURN_PATH_COOKIE, returnPath, cookieOptions());
      }

      const authUrl = buildAuthUrl({
        redirectUri: callbackUri(),
        state,
        provider,
        // Pre-fill the account so a coach with several Google logins lands on the right one.
        loginHint: email,
      });

      res.redirect(authUrl);
    })
    .catch(() => {
      res.status(401).json({ error: 'You must be logged in to connect a calendar' });
    });
};

module.exports.STATE_COOKIE = STATE_COOKIE;
module.exports.RETURN_PATH_COOKIE = RETURN_PATH_COOKIE;
module.exports.ALLOWED_PROVIDERS = ALLOWED_PROVIDERS;
module.exports.callbackUri = callbackUri;
