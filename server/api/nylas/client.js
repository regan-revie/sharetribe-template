/**
 * Thin client for the Nylas v3 API.
 *
 * Kept deliberately small: it builds the Hosted Authentication URL and exchanges an authorization
 * code for a grant. Nothing here touches Sharetribe, so this module stays useful if the Nylas code
 * is ever extracted into its own service.
 */

const { API_KEY, CLIENT_ID, API_BASE_URL } = require('./config');

// Nylas's API-key token exchange expects this literal. The flow has no PKCE code verifier, but the
// field is still required, so a fixed value is what their documented request sends.
const API_KEY_CODE_VERIFIER = 'nylas';

/**
 * Build the Hosted Authentication URL to send a coach to.
 *
 * Passing `provider` skips Nylas's provider-picker screen and goes straight to that provider's
 * consent page, which is how the flow stays as close to Revie-branded as the plan allows.
 *
 * @param {object} params
 * @param {string} params.redirectUri must match a Callback URI registered on the Nylas application
 * @param {string} params.state opaque value echoed back, checked against a cookie on return
 * @param {string} [params.provider] e.g. 'google', 'microsoft', 'icloud'
 * @param {string[]} [params.scope] provider scopes to request
 * @param {string} [params.loginHint] pre-fills the account, usually the coach's email
 * @returns {string} absolute URL
 */
const buildAuthUrl = ({ redirectUri, state, provider, scope, loginHint }) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    // 'offline' so Nylas keeps a refresh token and the grant survives the access token expiring.
    // Without it a coach's calendar would silently disconnect within the hour.
    access_type: 'offline',
    state,
  });

  if (provider) params.set('provider', provider);
  if (loginHint) params.set('login_hint', loginHint);
  if (Array.isArray(scope) && scope.length > 0) params.set('scope', scope.join(' '));

  return `${API_BASE_URL}/v3/connect/auth?${params.toString()}`;
};

/**
 * Exchange a one-time authorization code for a grant.
 *
 * The code is single use: if this call fails the whole flow has to restart, so callers should
 * surface a retry rather than assume the coach can refresh the page.
 *
 * @param {object} params
 * @param {string} params.code authorization code from the callback query
 * @param {string} params.redirectUri must match the one used to start the flow
 * @returns {Promise<{grantId: string, email: string|undefined, provider: string|undefined}>}
 */
const exchangeCodeForGrant = async ({ code, redirectUri }) => {
  const response = await fetch(`${API_BASE_URL}/v3/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      // Nylas accepts the API key in place of a client secret for this flow.
      client_secret: API_KEY,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: API_KEY_CODE_VERIFIER,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Never include the payload verbatim: error bodies from token endpoints can echo request
    // fields, and this request carries the API key.
    const err = new Error(`Nylas token exchange failed with status ${response.status}`);
    err.status = response.status;
    err.nylasError = payload && payload.error;
    throw err;
  }

  const grantId = payload.grant_id;
  if (!grantId) {
    throw new Error('Nylas token exchange succeeded but returned no grant_id');
  }

  return { grantId, email: payload.email, provider: payload.provider };
};

module.exports = { buildAuthUrl, exchangeCodeForGrant, API_KEY_CODE_VERIFIER };
