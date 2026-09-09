const { parseWindow, MAX_WINDOW_DAYS } = require('./availabilityEndpoint');

const iso = d => new Date(d).toISOString();

describe('parseWindow()', () => {
  it('defaults to the next 30 days when given nothing', () => {
    const { start, end, error } = parseWindow(undefined, undefined);
    expect(error).toBeUndefined();
    expect((end - start) / 86400000).toBeCloseTo(30, 0);
  });

  it('never offers slots in the past, however the window was framed', () => {
    // A stale client, or a hand-edited URL, must not be able to ask for yesterday.
    const { start } = parseWindow(iso(Date.now() - 10 * 86400000), iso(Date.now() + 86400000));
    expect(start.getTime()).toBeGreaterThanOrEqual(Date.now() - 2000);
  });

  it('rejects an unparseable date rather than silently defaulting', () => {
    expect(parseWindow('not-a-date', iso(Date.now() + 86400000)).error).toMatch(/Invalid/);
    expect(parseWindow(iso(Date.now()), 'nonsense').error).toMatch(/Invalid/);
  });

  it('rejects a backwards window', () => {
    expect(parseWindow(iso(Date.now() + 86400000), iso(Date.now())).error).toMatch(/after start/);
  });

  it('rejects an absurdly long window', () => {
    const start = iso(Date.now());
    const end = iso(Date.now() + (MAX_WINDOW_DAYS + 5) * 86400000);
    expect(parseWindow(start, end).error).toMatch(/may not exceed/);
  });

  it('accepts a normal month-long window', () => {
    const start = iso(Date.now());
    const end = iso(Date.now() + 30 * 86400000);
    expect(parseWindow(start, end).error).toBeUndefined();
  });
});
