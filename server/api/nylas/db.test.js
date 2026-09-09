// The pg Pool is mocked: these tests assert the SQL shape and the availability behaviour, not
// Postgres itself. Anything needing a real database is verified against the Render instance.
const mockQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery, on: jest.fn(), end: jest.fn() })),
}));

const loadDb = url => {
  let db;
  jest.isolateModules(() => {
    const original = process.env.DATABASE_URL;
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    db = require('./db');
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });
  return db;
};

const URL = 'postgres://user:pw@localhost:5432/revie_dev';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('availability', () => {
  it('reports unavailable with no DATABASE_URL', () => {
    expect(loadDb(undefined).isAvailable()).toBe(false);
  });

  it('reports available once DATABASE_URL is set', () => {
    expect(loadDb(URL).isAvailable()).toBe(true);
  });

  it('refuses to run a query rather than pretending to succeed', async () => {
    // Losing a booking mapping silently would break cancellation with no visible cause.
    await expect(loadDb(undefined).findByBookingId('bk_1')).rejects.toThrow(/DATABASE_URL/);
  });

  it('initSchema reports failure instead of throwing when there is no database', async () => {
    await expect(loadDb(undefined).initSchema()).resolves.toBe(false);
  });
});

describe('schema', () => {
  it('creates the table and the reverse-lookup index idempotently', async () => {
    await loadDb(URL).initSchema();
    const sql = mockQuery.mock.calls.map(c => c[0]).join('\n');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS nylas_bookings/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS nylas_bookings_transaction_idx/);
    // Safe to run on every boot, which is why there is no migration framework.
    expect(sql).not.toMatch(/DROP /);
  });
});

describe('recordBooking()', () => {
  it('upserts, so a redelivered webhook does not fail on a duplicate key', async () => {
    // Nylas can deliver the same booking.created more than once.
    mockQuery.mockResolvedValue({ rows: [{ nylas_booking_id: 'bk_1' }] });
    await loadDb(URL).recordBooking({
      nylasBookingId: 'bk_1',
      sharetribeTransactionId: 'tx_1',
      nylasGrantId: 'grant_1',
      bookingStart: '2026-06-01T12:00:00Z',
      status: 'created',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO nylas_bookings/);
    expect(sql).toMatch(/ON CONFLICT \(nylas_booking_id\) DO UPDATE/);
    expect(params).toEqual(['bk_1', 'tx_1', 'grant_1', '2026-06-01T12:00:00Z', 'created']);
  });

  it('stores a null booking_start rather than undefined', async () => {
    mockQuery.mockResolvedValue({ rows: [{}] });
    await loadDb(URL).recordBooking({
      nylasBookingId: 'bk_2',
      sharetribeTransactionId: 'tx_2',
      nylasGrantId: 'g',
      status: 'created',
    });
    expect(mockQuery.mock.calls[0][1][3]).toBeNull();
  });
});

describe('lookups', () => {
  it('finds by Nylas booking id, the direction webhooks need', async () => {
    mockQuery.mockResolvedValue({ rows: [{ nylas_booking_id: 'bk_1' }] });
    const row = await loadDb(URL).findByBookingId('bk_1');
    expect(row.nylas_booking_id).toBe('bk_1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['bk_1']);
  });

  it('returns null rather than undefined when a booking is unknown', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(loadDb(URL).findByBookingId('nope')).resolves.toBeNull();
  });

  it('finds by transaction id for reconciling from the Sharetribe side', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    const rows = await loadDb(URL).findByTransactionId('tx_1');
    expect(rows).toHaveLength(2);
    expect(mockQuery.mock.calls[0][0]).toMatch(/WHERE sharetribe_transaction_id = \$1/);
  });
});
