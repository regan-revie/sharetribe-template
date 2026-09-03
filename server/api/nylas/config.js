/**
 * Configuration for the Nylas integration.
 *
 * These variables deliberately have no REACT_APP_ prefix. That prefix is what copies a value into
 * the public browser bundle, so applying it to the API key would publish the key on the next
 * deploy. Everything here is server-only.
 *
 * NYLAS_WEBHOOK_SECRET is intentionally allowed to be absent. Nylas mints it per webhook
 * destination at the moment that destination is created, and creating one requires this server to
 * already be answering the challenge request over public HTTPS. The secret is therefore an output
 * of deploying this endpoint, not an input to it.
 */

const API_KEY = process.env.NYLAS_API_KEY;
const CLIENT_ID = process.env.NYLAS_CLIENT_ID;
const API_BASE_URL = process.env.NYLAS_API_BASE_URL || 'https://api.us.nylas.com';
const WEBHOOK_SECRET = process.env.NYLAS_WEBHOOK_SECRET;

// True once the credentials needed to call the Nylas API are present.
const isConfigured = () => Boolean(API_KEY && CLIENT_ID);

// True once we can verify inbound webhook signatures. Until this is true, webhook POSTs must be
// rejected rather than trusted - see webhooks.js.
const canVerifyWebhooks = () => Boolean(WEBHOOK_SECRET);

module.exports = {
  API_KEY,
  CLIENT_ID,
  API_BASE_URL,
  WEBHOOK_SECRET,
  isConfigured,
  canVerifyWebhooks,
};
