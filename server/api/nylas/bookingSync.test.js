jest.mock('./db', () => ({
  isAvailable: jest.fn(() => true),
  recordBooking: jest.fn(async () => ({})),
  findByBookingId: jest.fn(async () => null),
  setStatus: jest.fn(async () => ({})),
}));
jest.mock('./integration', () => ({
  isConfigured: jest.fn(() => true),
  applyTransition: jest.fn(async () => ({ ok: true, transaction: {} })),
}));

const db = require('./db');
const { applyTransition } = require('./integration');
const {
  TRANSACTION_FIELD,
  extractTransactionId,
  extractBookingStart,
  handleBookingWebhook,
} = require('./bookingSync');

const TX = 'tx-abc';
const BOOKING = 'bk-1';

beforeEach(() => {
  jest.clearAllMocks();
  db.isAvailable.mockReturnValue(true);
  require('./integration').isConfigured.mockReturnValue(true);
  applyTransition.mockResolvedValue({ ok: true, transaction: {} });
});

describe('extractTransactionId()', () => {
  it('reads the confirmed shape: nested under booking_info', () => {
    // Confirmed against Nylas's own mock-payload endpoint and a real webhook delivery - the
    // top-level customFields/custom_fields shapes below were the pre-launch best guess and are
    // kept only as a fallback.
    expect(
      extractTransactionId({ booking_info: { additional_fields: { [TRANSACTION_FIELD]: TX } } })
    ).toBe(TX);
  });

  it('reads the array-of-pairs shape', () => {
    expect(extractTransactionId({ customFields: [{ name: TRANSACTION_FIELD, value: TX }] })).toBe(
      TX
    );
  });

  it('reads the plain-object shape', () => {
    expect(extractTransactionId({ customFields: { [TRANSACTION_FIELD]: TX } })).toBe(TX);
  });

  it('reads the snake_case key Nylas sometimes uses', () => {
    // Their docs and forum posts disagree on this, so both are accepted rather than guessed.
    expect(extractTransactionId({ custom_fields: { [TRANSACTION_FIELD]: TX } })).toBe(TX);
  });

  it('returns null when absent rather than undefined', () => {
    expect(extractTransactionId({})).toBeNull();
    expect(extractTransactionId({ customFields: [{ name: 'other', value: 'x' }] })).toBeNull();
  });
});

describe('extractBookingStart()', () => {
  it('reads the confirmed shape: nested under booking_info', () => {
    const seconds = 1780000000;
    expect(extractBookingStart({ booking_info: { start_time: seconds } }).getTime()).toBe(
      seconds * 1000
    );
  });

  it('treats a number as epoch SECONDS, not milliseconds', () => {
    // Getting this wrong puts the session fifty years out and makes every cancellation look free.
    const seconds = 1780000000;
    expect(extractBookingStart({ start_time: seconds }).getTime()).toBe(seconds * 1000);
  });

  it('accepts an ISO string', () => {
    expect(extractBookingStart({ start: '2026-06-01T12:00:00Z' }).toISOString()).toBe(
      '2026-06-01T12:00:00.000Z'
    );
  });

  it('returns null for missing or unparseable values', () => {
    expect(extractBookingStart({})).toBeNull();
    expect(extractBookingStart({ start: 'nonsense' })).toBeNull();
  });
});

describe('booking.created', () => {
  const created = {
    trigger: 'booking.created',
    grantId: 'g1',
    data: {
      booking_id: BOOKING,
      start_time: 1780000000,
      customFields: { [TRANSACTION_FIELD]: TX },
    },
  };

  it('records the mapping and confirms the transaction', async () => {
    const result = await handleBookingWebhook(created);
    expect(db.recordBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        nylasBookingId: BOOKING,
        sharetribeTransactionId: TX,
        nylasGrantId: 'g1',
        status: 'created',
      })
    );
    expect(applyTransition).toHaveBeenCalledWith(TX, 'transition/operator-accept');
    expect(result).toEqual({ handled: true, action: 'accepted' });
  });

  it('does nothing for a booking made outside Revie checkout', async () => {
    // The Nylas scheduling page is publicly reachable, so a booking can arrive with no transaction
    // and no payment behind it. There is nothing to confirm.
    const result = await handleBookingWebhook({ ...created, data: { booking_id: BOOKING } });
    expect(applyTransition).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false, reason: 'no-transaction-id' });
  });

  it('treats an already-applied transition as success, not failure', async () => {
    // Nylas redelivers webhooks; Sharetribe rejects a transition it has already made.
    applyTransition.mockResolvedValue({ ok: false, alreadyApplied: true });
    await expect(handleBookingWebhook(created)).resolves.toEqual({
      handled: true,
      action: 'already-accepted',
    });
  });

  it('throws on a real transition failure so Nylas retries', async () => {
    applyTransition.mockResolvedValue({ ok: false, error: new Error('boom') });
    await expect(handleBookingWebhook(created)).rejects.toThrow('boom');
  });

  it('refuses to act with no database', async () => {
    db.isAvailable.mockReturnValue(false);
    await expect(handleBookingWebhook(created)).resolves.toEqual({
      handled: false,
      reason: 'no-database',
    });
  });
});

describe('booking.cancelled', () => {
  const cancelled = { trigger: 'booking.cancelled', grantId: 'g1', data: { booking_id: BOOKING } };
  const startingIn = hours => new Date(Date.now() + hours * 3600000);

  it('refunds a cancellation more than 48 hours out', async () => {
    db.findByBookingId.mockResolvedValue({
      sharetribe_transaction_id: TX,
      booking_start: startingIn(72),
    });
    const result = await handleBookingWebhook(cancelled);
    expect(applyTransition).toHaveBeenCalledWith(TX, 'transition/cancel');
    expect(result).toEqual({ handled: true, action: 'refunded' });
  });

  it('charges a cancellation inside 48 hours by doing nothing at all', async () => {
    // The transaction completes by itself at booking-end + 2 days, so the client keeps their charge
    // and the coach is paid. Calling any transition here would undo that.
    db.findByBookingId.mockResolvedValue({
      sharetribe_transaction_id: TX,
      booking_start: startingIn(12),
    });
    const result = await handleBookingWebhook(cancelled);
    expect(applyTransition).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, action: 'charged-late-cancellation' });
  });

  it('always marks the booking cancelled, whichever side of the window', async () => {
    db.findByBookingId.mockResolvedValue({
      sharetribe_transaction_id: TX,
      booking_start: startingIn(12),
    });
    await handleBookingWebhook(cancelled);
    expect(db.setStatus).toHaveBeenCalledWith(BOOKING, 'cancelled');
  });

  it('does nothing for a booking it has never seen', async () => {
    db.findByBookingId.mockResolvedValue(null);
    await expect(handleBookingWebhook(cancelled)).resolves.toEqual({
      handled: false,
      reason: 'unknown-booking',
    });
  });

  it('throws rather than guessing when there is no start time', async () => {
    // Without it there is no way to tell a free cancellation from a chargeable one.
    db.findByBookingId.mockResolvedValue({ sharetribe_transaction_id: TX, booking_start: null });
    await expect(handleBookingWebhook(cancelled)).rejects.toThrow(/no booking start time/);
  });
});

describe('booking.rescheduled', () => {
  const rescheduled = {
    trigger: 'booking.rescheduled',
    grantId: 'g1',
    data: {
      booking_id: BOOKING,
      booking_info: { start_time: 1790000000, end_time: 1790003600 },
    },
  };

  it('updates the stored time and status, without touching Sharetribe', async () => {
    db.findByBookingId.mockResolvedValue({
      sharetribe_transaction_id: TX,
      nylas_grant_id: 'g1',
      booking_start: new Date('2026-06-01T12:00:00Z'),
      booking_end: new Date('2026-06-01T13:00:00Z'),
    });
    const result = await handleBookingWebhook(rescheduled);
    expect(db.recordBooking).toHaveBeenCalledWith({
      nylasBookingId: BOOKING,
      sharetribeTransactionId: TX,
      nylasGrantId: 'g1',
      bookingStart: new Date(1790000000 * 1000),
      bookingEnd: new Date(1790003600 * 1000),
      status: 'rescheduled',
    });
    expect(applyTransition).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, action: 'rescheduled' });
  });

  it('falls back to the previously stored time if the payload carries none', async () => {
    const existingStart = new Date('2026-06-01T12:00:00Z');
    const existingEnd = new Date('2026-06-01T13:00:00Z');
    db.findByBookingId.mockResolvedValue({
      sharetribe_transaction_id: TX,
      nylas_grant_id: 'g1',
      booking_start: existingStart,
      booking_end: existingEnd,
    });
    await handleBookingWebhook({ ...rescheduled, data: { booking_id: BOOKING } });
    expect(db.recordBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingStart: existingStart, bookingEnd: existingEnd })
    );
  });

  it('does nothing for a booking it has never seen', async () => {
    db.findByBookingId.mockResolvedValue(null);
    await expect(handleBookingWebhook(rescheduled)).resolves.toEqual({
      handled: false,
      reason: 'unknown-booking',
    });
    expect(db.recordBooking).not.toHaveBeenCalled();
  });
});
