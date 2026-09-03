const { computeSignature, verifySignature } = require('./signature');

const SECRET = 'a-webhook-secret';
const BODY = Buffer.from(JSON.stringify({ type: 'booking.created', data: { id: 'bk_1' } }));

describe('verifySignature()', () => {
  it('accepts a signature computed with the same secret and body', () => {
    expect(verifySignature(BODY, computeSignature(BODY, SECRET), SECRET)).toBe(true);
  });

  it('accepts an equivalent string body', () => {
    const asString = BODY.toString('utf8');
    expect(verifySignature(asString, computeSignature(asString, SECRET), SECRET)).toBe(true);
  });

  it('is case-insensitive about the hex digest', () => {
    const upper = computeSignature(BODY, SECRET).toUpperCase();
    expect(verifySignature(BODY, upper, SECRET)).toBe(true);
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(verifySignature(BODY, `  ${computeSignature(BODY, SECRET)}  `, SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(BODY, computeSignature(BODY, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a body that was tampered with after signing', () => {
    const signature = computeSignature(BODY, SECRET);
    const tampered = Buffer.from(JSON.stringify({ type: 'booking.cancelled' }));
    expect(verifySignature(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects a body that was reserialised rather than kept raw', () => {
    // Same data, different byte order: this is exactly what happens if the parsed object is
    // re-stringified instead of the raw buffer being kept.
    const reserialised = Buffer.from(
      JSON.stringify({ data: { id: 'bk_1' }, type: 'booking.created' })
    );
    expect(verifySignature(reserialised, computeSignature(BODY, SECRET), SECRET)).toBe(false);
  });

  it('rejects a missing, empty or wrong-length signature header', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
    expect(verifySignature(BODY, 'deadbeef', SECRET)).toBe(false);
  });

  it('rejects when no secret is configured', () => {
    expect(verifySignature(BODY, computeSignature(BODY, SECRET), undefined)).toBe(false);
    expect(verifySignature(BODY, computeSignature(BODY, SECRET), '')).toBe(false);
  });

  it('rejects a body that is neither a Buffer nor a string', () => {
    expect(
      verifySignature({ type: 'booking.created' }, computeSignature(BODY, SECRET), SECRET)
    ).toBe(false);
    expect(verifySignature(undefined, computeSignature(BODY, SECRET), SECRET)).toBe(false);
  });
});
