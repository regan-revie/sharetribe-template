/**
 * Verification of Nylas webhook signatures.
 *
 * Every Nylas notification carries an `x-nylas-signature` header holding a hex-encoded HMAC-SHA256
 * of the request body, signed with the destination's own `webhook_secret`.
 *
 * The signature covers the exact bytes Nylas sent, so it must be checked against the RAW body.
 * A parsed-and-reserialised object will not match: reordered keys or changed whitespace produce a
 * different digest. See apiRouter.js, where bodyParser's `verify` hook stashes the raw buffer.
 */

const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-nylas-signature';

/**
 * Compute the signature Nylas should have sent for this body.
 *
 * @param {Buffer|string} rawBody exact bytes of the request body
 * @param {string} secret the destination's webhook_secret
 * @returns {string} hex-encoded HMAC-SHA256
 */
const computeSignature = (rawBody, secret) =>
  crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

/**
 * Constant-time check of an inbound signature.
 *
 * Returns false rather than throwing for every failure mode, so a malformed or hostile request is
 * indistinguishable from a wrong signature to the caller.
 *
 * @param {Buffer|string} rawBody exact bytes of the request body
 * @param {string} signatureHeader value of the x-nylas-signature header
 * @param {string} secret the destination's webhook_secret
 * @returns {boolean}
 */
const verifySignature = (rawBody, signatureHeader, secret) => {
  const bodyIsUsable = Buffer.isBuffer(rawBody) || typeof rawBody === 'string';
  if (!secret || typeof secret !== 'string') return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) return false;
  if (!bodyIsUsable) return false;

  const expected = computeSignature(rawBody, secret);
  const provided = signatureHeader.trim().toLowerCase();

  // timingSafeEqual throws on length mismatch, so compare lengths first. The length of a hex
  // SHA-256 digest is not secret, so leaking it through an early return costs nothing.
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
};

module.exports = { SIGNATURE_HEADER, computeSignature, verifySignature };
