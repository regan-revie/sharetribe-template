jest.mock('./client', () => ({ nylasRequest: jest.fn() }));
const { nylasRequest } = require('./client');
const {
  getEventType,
  defaultCalendarFor,
  buildConfigurationBody,
  syncConfiguration,
} = require('./scheduler');

const CAL = 'coach@example.com';
const GRANT = 'grant-1';

beforeEach(() => jest.clearAllMocks());

describe('getEventType()', () => {
  it('returns the Revie template keyed by Sharetribe listing type id', () => {
    // The keys are deliberately the Sharetribe listing type ids, so a listing maps to its Nylas
    // configuration without a separate lookup table.
    expect(getEventType('signature-session')).toMatchObject({ title: 'Signature Session' });
  });

  it('returns undefined for an unknown type', () => {
    expect(getEventType('not-a-real-type')).toBeUndefined();
  });
});

describe('defaultCalendarFor()', () => {
  it('prefers the primary calendar', () => {
    const cals = [
      { id: 'other', read_only: false },
      { id: CAL, read_only: false, is_primary: true },
    ];
    expect(defaultCalendarFor(cals).id).toBe(CAL);
  });

  it('never chooses a read-only calendar', () => {
    // A subscribed holiday calendar is read-only and would pass a naive "first result" check,
    // then fail only at booking time when Nylas tried to write the event.
    const cals = [
      { id: 'holidays', read_only: true, is_primary: true },
      { id: CAL, read_only: false },
    ];
    expect(defaultCalendarFor(cals).id).toBe(CAL);
  });

  it('falls back to the first writable calendar when none is primary', () => {
    expect(
      defaultCalendarFor([{ id: 'a', read_only: false }, { id: 'b', read_only: false }]).id
    ).toBe('a');
  });

  it('returns null when there is nothing writable', () => {
    expect(defaultCalendarFor([{ id: 'holidays', read_only: true }])).toBeNull();
    expect(defaultCalendarFor([])).toBeNull();
  });
});

describe('buildConfigurationBody()', () => {
  const body = buildConfigurationBody({
    eventType: { title: 'Signature Session', description: 'desc', durationMinutes: 60 },
    coachName: 'A Coach',
    coachEmail: CAL,
    calendarId: CAL,
  });

  it('makes the coach the organizer', () => {
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0]).toMatchObject({ name: 'A Coach', email: CAL, is_organizer: true });
  });

  it('reads availability from and writes bookings to the same calendar', () => {
    expect(body.participants[0].availability.calendar_ids).toEqual([CAL]);
    expect(body.participants[0].booking.calendar_id).toBe(CAL);
  });

  it('takes duration and title from the Revie template', () => {
    expect(body.availability.duration_minutes).toBe(60);
    expect(body.event_booking.title).toBe('Signature Session');
  });

  it('creates a public configuration', () => {
    // Clients booking a session authenticate against Sharetribe, not Nylas; requiring session auth
    // would mean minting a Nylas session per booker.
    expect(body.requires_session_auth).toBe(false);
  });
});

describe('syncConfiguration()', () => {
  it('rejects an event type Revie does not define', async () => {
    await expect(
      syncConfiguration({
        grantId: GRANT,
        eventTypeKey: 'invented',
        coachEmail: CAL,
        calendarId: CAL,
      })
    ).rejects.toThrow(/Unknown Revie event type/);
    expect(nylasRequest).not.toHaveBeenCalled();
  });

  it('creates a configuration when the coach has none', async () => {
    nylasRequest.mockResolvedValueOnce([]).mockResolvedValueOnce({ id: 'cfg-1' });
    const { created, configuration } = await syncConfiguration({
      grantId: GRANT,
      eventTypeKey: 'signature-session',
      coachName: 'A',
      coachEmail: CAL,
      calendarId: CAL,
    });
    expect(created).toBe(true);
    expect(configuration.id).toBe('cfg-1');
    expect(nylasRequest).toHaveBeenLastCalledWith(
      `/v3/grants/${GRANT}/scheduling/configurations`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('updates in place rather than duplicating when one already exists', async () => {
    // A coach re-opting-in must not end up selling the same session twice.
    nylasRequest
      .mockResolvedValueOnce([
        { id: 'cfg-existing', event_booking: { title: 'Signature Session' } },
      ])
      .mockResolvedValueOnce({ id: 'cfg-existing' });
    const { created, configuration } = await syncConfiguration({
      grantId: GRANT,
      eventTypeKey: 'signature-session',
      coachName: 'A',
      coachEmail: CAL,
      calendarId: CAL,
    });
    expect(created).toBe(false);
    expect(configuration.id).toBe('cfg-existing');
    expect(nylasRequest).toHaveBeenLastCalledWith(
      `/v3/grants/${GRANT}/scheduling/configurations/cfg-existing`,
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('ignores a configuration for a different event type', async () => {
    nylasRequest
      .mockResolvedValueOnce([{ id: 'cfg-other', event_booking: { title: 'Something Else' } }])
      .mockResolvedValueOnce({ id: 'cfg-new' });
    const { created } = await syncConfiguration({
      grantId: GRANT,
      eventTypeKey: 'signature-session',
      coachName: 'A',
      coachEmail: CAL,
      calendarId: CAL,
    });
    expect(created).toBe(true);
  });
});

describe('scheduling settings', () => {
  const {
    SCHEDULING_DEFAULTS,
    STRIPE_MAX_BOOKING_DAYS,
    clampBookingWindow,
    resolveMinBookingNotice,
  } = require('./scheduler');

  it('converts a coach notice period into the minutes Nylas expects', () => {
    expect(resolveMinBookingNotice(72 * 60)).toBe(4320);
    expect(resolveMinBookingNotice(0)).toBe(0);
  });

  it('falls back to the Revie default when a coach has set nothing', () => {
    // Nylas's own default is 60 minutes, far too little for a session someone must prepare for.
    expect(resolveMinBookingNotice(undefined)).toBe(SCHEDULING_DEFAULTS.minBookingNoticeMinutes);
    expect(resolveMinBookingNotice('nonsense')).toBe(SCHEDULING_DEFAULTS.minBookingNoticeMinutes);
    expect(resolveMinBookingNotice(-5)).toBe(SCHEDULING_DEFAULTS.minBookingNoticeMinutes);
  });

  it('never lets the booking window exceed the Stripe authorisation limit', () => {
    // A booking further out than Stripe will hold the card authorisation would have its payment
    // expire before the session happened.
    expect(clampBookingWindow(365)).toBe(STRIPE_MAX_BOOKING_DAYS);
    expect(clampBookingWindow(45)).toBe(45);
    expect(clampBookingWindow(0)).toBe(1);
    expect(clampBookingWindow(undefined)).toBe(SCHEDULING_DEFAULTS.availableDaysInFuture);
  });

  it('puts both settings in the scheduler block Nylas reads', () => {
    const body = buildConfigurationBody({
      eventType: { title: 'T', description: 'd', durationMinutes: 60 },
      coachName: 'C',
      coachEmail: 'c@e.com',
      calendarId: 'c@e.com',
      minBookingNoticeMinutes: 72 * 60,
      availableDaysInFuture: 120,
    });
    expect(body.scheduler.min_booking_notice).toBe(4320);
    expect(body.scheduler.available_days_in_future).toBe(90);
  });
});

describe('cancellation notice', () => {
  const { SCHEDULING_DEFAULTS } = require('./scheduler');

  it('applies a global 24 hour cancellation notice, not a per-coach one', () => {
    const body = buildConfigurationBody({
      eventType: { title: 'T', description: 'd', durationMinutes: 60 },
      coachName: 'C',
      coachEmail: 'c@e.com',
      calendarId: 'c@e.com',
      minBookingNoticeMinutes: 72 * 60,
    });
    expect(body.scheduler.min_cancellation_notice).toBe(24 * 60);
    expect(SCHEDULING_DEFAULTS.minCancellationNoticeMinutes).toBe(1440);
  });
});
