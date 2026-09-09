const { permissiveAvailabilityPlan, WEEKDAYS } = require('./enableListing');

describe('permissiveAvailabilityPlan()', () => {
  const plan = permissiveAvailabilityPlan('Europe/London');

  it('carries the calendar timezone, without which no booking form renders at all', () => {
    // OrderPanel derives timeZone from availabilityPlan.timezone and renders nothing without it,
    // so a plan missing this makes the booking UI silently disappear.
    expect(plan.timezone).toBe('Europe/London');
    expect(plan.type).toBe('availability-plan/time');
  });

  it('opens every day fully, so Sharetribe never second-guesses Nylas', () => {
    // create-pending-booking validates the requested time against this plan. Nylas is the real
    // authority on availability, so anything narrower would reject bookings Nylas had just offered.
    expect(plan.entries).toHaveLength(7);
    expect(new Set(plan.entries.map(e => e.dayOfWeek))).toEqual(new Set(WEEKDAYS));
    plan.entries.forEach(e => {
      expect(e.startTime).toBe('00:00');
      expect(e.endTime).toBe('24:00');
      expect(e.seats).toBe(1);
    });
  });

  it('keeps one seat per slot, matching the listing type', () => {
    // The listing type is availabilityType oneSeat; more would let two clients book one session.
    plan.entries.forEach(e => expect(e.seats).toBe(1));
  });
});
