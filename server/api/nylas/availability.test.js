const { filterSlotsByNotice, toBookableSlot, toUnixSeconds } = require('./availability');

const NOW = 1788960000; // fixed point so the tests do not depend on the clock
const hoursFromNow = h => NOW + h * 3600;
const slotAt = h => ({ start_time: hoursFromNow(h), end_time: hoursFromNow(h) + 3600 });

describe('filterSlotsByNotice()', () => {
  it('drops slots inside the notice period', () => {
    // The reason this module exists: Nylas returned a slot six minutes out despite a 72-hour
    // notice being configured, so the endpoint cannot be trusted to apply it.
    const slots = [slotAt(0.1), slotAt(24), slotAt(71), slotAt(80)];
    const kept = filterSlotsByNotice(slots, 72 * 60, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].start_time).toBe(hoursFromNow(80));
  });

  it('keeps a slot sitting exactly on the boundary', () => {
    // "No bookings within the next 72 hours" - one exactly 72 hours away is not within it.
    expect(filterSlotsByNotice([slotAt(72)], 72 * 60, NOW)).toHaveLength(1);
  });

  it('keeps everything when no notice is configured', () => {
    expect(filterSlotsByNotice([slotAt(0.1), slotAt(5)], 0, NOW)).toHaveLength(2);
  });

  it('does not silently disable itself on a nonsensical notice', () => {
    // A filter that quietly stops filtering fails invisibly - bookings just start appearing too
    // soon - so garbage must not be read as "no notice".
    expect(filterSlotsByNotice([slotAt(1)], undefined, NOW)).toHaveLength(1);
    expect(filterSlotsByNotice([slotAt(1)], 'soon', NOW)).toHaveLength(1);
    expect(filterSlotsByNotice([slotAt(1)], -5, NOW)).toHaveLength(1);
  });

  it('handles an empty or missing slot list', () => {
    expect(filterSlotsByNotice([], 60, NOW)).toEqual([]);
    expect(filterSlotsByNotice(undefined, 60, NOW)).toEqual([]);
  });

  it('drops every slot when the whole window is inside the notice period', () => {
    expect(filterSlotsByNotice([slotAt(1), slotAt(2)], 72 * 60, NOW)).toEqual([]);
  });
});

describe('toBookableSlot()', () => {
  it('converts Nylas seconds into the milliseconds Sharetribe and the form use', () => {
    // Nylas speaks Unix seconds, JavaScript speaks milliseconds; mixing them silently produces
    // dates in 1970.
    expect(toBookableSlot({ start_time: 1788960000, end_time: 1788963600 })).toEqual({
      start: 1788960000000,
      end: 1788963600000,
    });
  });
});

describe('toUnixSeconds()', () => {
  it('accepts Dates, ISO strings and epoch milliseconds alike', () => {
    const iso = '2026-09-09T12:00:00.000Z';
    expect(toUnixSeconds(new Date(iso))).toBe(1788955200);
    expect(toUnixSeconds(iso)).toBe(1788955200);
    expect(toUnixSeconds(Date.parse(iso))).toBe(1788955200);
  });
});

jest.mock('./client', () => ({ nylasRequest: jest.fn() }));
const { nylasRequest } = require('./client');
const { createSession, SESSION_TTL_MINUTES } = require('./availability');

describe('createSession()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks Nylas for a session scoped to one configuration', async () => {
    nylasRequest.mockResolvedValueOnce({ session_id: 'sess-1' });
    await expect(createSession('cfg-1')).resolves.toBe('sess-1');
    expect(nylasRequest).toHaveBeenCalledWith('/v3/scheduling/sessions', {
      method: 'POST',
      body: { configuration_id: 'cfg-1', time_to_live_in_minutes: SESSION_TTL_MINUTES },
    });
  });

  it('keeps the session short-lived', () => {
    // A session is the capability to see availability and to book, so it should not outlive the
    // page view that needs it.
    expect(SESSION_TTL_MINUTES).toBeLessThanOrEqual(60);
  });

  it('throws rather than returning undefined when Nylas sends no session id', async () => {
    // Returning undefined would surface much later as an unauthenticated availability call, which
    // now 404s in a way that looks like a missing configuration rather than a missing session.
    nylasRequest.mockResolvedValueOnce({});
    await expect(createSession('cfg-1')).rejects.toThrow(/no session_id/);
  });
});
