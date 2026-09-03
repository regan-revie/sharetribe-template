const { computeSignature } = require('./signature');

const SECRET = 'a-webhook-secret';

// config.js reads process.env at module load, so each test loads a fresh copy of the module graph
// with the environment it needs.
const loadWebhooks = secret => {
  let mod;
  jest.isolateModules(() => {
    const original = process.env.NYLAS_WEBHOOK_SECRET;
    if (secret === undefined) {
      delete process.env.NYLAS_WEBHOOK_SECRET;
    } else {
      process.env.NYLAS_WEBHOOK_SECRET = secret;
    }
    mod = require('./webhooks');
    if (original === undefined) {
      delete process.env.NYLAS_WEBHOOK_SECRET;
    } else {
      process.env.NYLAS_WEBHOOK_SECRET = original;
    }
  });
  return mod;
};

const mockRes = () => {
  const res = { statusCode: null, body: null, contentType: null };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.type = t => {
    res.contentType = t;
    return res;
  };
  res.send = b => {
    res.body = b;
    return res;
  };
  res.json = b => {
    res.body = b;
    return res;
  };
  return res;
};

const mockReq = ({ query = {}, body = {}, rawBody, headers = {} } = {}) => ({
  query,
  body,
  rawBody,
  get: name => headers[String(name).toLowerCase()],
});

const signedRequest = (payload, secret) => {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return mockReq({
    body: payload,
    rawBody,
    headers: { 'x-nylas-signature': computeSignature(rawBody, secret) },
  });
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('challenge()', () => {
  it('echoes the challenge value verbatim as plain text', () => {
    const { challenge } = loadWebhooks(SECRET);
    const res = mockRes();
    challenge(mockReq({ query: { challenge: 'abc123' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('text/plain');
    // Exactly the value: no JSON wrapper, no quotes, no trailing newline.
    expect(res.body).toBe('abc123');
  });

  it('answers the challenge even with no webhook secret configured', () => {
    // The secret does not exist until this check has already been passed once.
    const { challenge } = loadWebhooks(undefined);
    const res = mockRes();
    challenge(mockReq({ query: { challenge: 'xyz' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('xyz');
  });

  it('rejects a request with no challenge parameter', () => {
    const { challenge } = loadWebhooks(SECRET);
    const res = mockRes();
    challenge(mockReq({ query: {} }), res);

    expect(res.statusCode).toBe(400);
  });
});

describe('receive()', () => {
  const booking = { type: 'booking.created', data: { object: { booking_id: 'bk_1' } } };

  it('refuses to process anything when no secret is configured', () => {
    const { receive } = loadWebhooks(undefined);
    const res = mockRes();
    receive(signedRequest(booking, SECRET), res);

    expect(res.statusCode).toBe(503);
  });

  it('rejects a request with an invalid signature', () => {
    const { receive } = loadWebhooks(SECRET);
    const res = mockRes();
    receive(signedRequest(booking, 'the-wrong-secret'), res);

    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no signature header at all', () => {
    const { receive } = loadWebhooks(SECRET);
    const res = mockRes();
    receive(mockReq({ body: booking, rawBody: Buffer.from(JSON.stringify(booking)) }), res);

    expect(res.statusCode).toBe(401);
  });

  it('accepts and handles a correctly signed booking notification', () => {
    const { receive } = loadWebhooks(SECRET);
    const res = mockRes();
    receive(signedRequest(booking, SECRET), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true, handled: true });
  });

  it.each(['booking.pending', 'booking.rescheduled', 'booking.cancelled'])(
    'handles the %s trigger',
    type => {
      const { receive } = loadWebhooks(SECRET);
      const res = mockRes();
      receive(signedRequest({ ...booking, type }, SECRET), res);

      expect(res.body).toEqual({ received: true, handled: true });
    }
  );

  it('acknowledges but does not handle an unrecognised trigger', () => {
    const { receive } = loadWebhooks(SECRET);
    const res = mockRes();
    receive(signedRequest({ type: 'message.created', data: {} }, SECRET), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true, handled: false });
  });

  it('does not log participant details from the payload', () => {
    const { receive } = loadWebhooks(SECRET);
    const withPii = {
      type: 'booking.created',
      data: { object: { booking_id: 'bk_9', guest: { email: 'coach@example.com' } } },
    };
    receive(signedRequest(withPii, SECRET), mockRes());

    const logged = console.log.mock.calls.flat().join(' ');
    expect(logged).toContain('bk_9');
    expect(logged).not.toContain('coach@example.com');
  });
});
