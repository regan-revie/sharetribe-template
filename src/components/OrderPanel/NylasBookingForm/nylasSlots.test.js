import { groupSlotsByDay, formatDayLabel, formatSlotTime, slotMatchesVariant } from './nylasSlots';

const LA = 'America/Los_Angeles';
const slot = (iso, minutes = 60) => {
  const start = Date.parse(iso);
  return { start, end: start + minutes * 60000 };
};

describe('groupSlotsByDay()', () => {
  it('groups by the day the coach sees, not the day UTC sees', () => {
    // 2026-09-12T02:30Z is still Friday the 11th in Los Angeles. Grouping in UTC - or in the
    // viewer's own zone - would file a coach's Friday evening under Saturday.
    const groups = groupSlotsByDay([slot('2026-09-12T02:30:00Z')], LA);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe('2026-09-11');
  });

  it('puts slots from the same local day together', () => {
    const groups = groupSlotsByDay(
      [slot('2026-09-11T16:00:00Z'), slot('2026-09-11T20:00:00Z'), slot('2026-09-13T16:00:00Z')],
      LA
    );
    expect(groups.map(g => g.slots.length)).toEqual([2, 1]);
  });

  it('returns days in chronological order', () => {
    const groups = groupSlotsByDay(
      [slot('2026-09-20T16:00:00Z'), slot('2026-09-11T16:00:00Z'), slot('2026-09-15T16:00:00Z')],
      LA
    );
    expect(groups.map(g => g.dayKey)).toEqual(['2026-09-11', '2026-09-15', '2026-09-20']);
  });

  it('orders slots within a day by start time', () => {
    const groups = groupSlotsByDay(
      [slot('2026-09-11T20:00:00Z'), slot('2026-09-11T16:00:00Z')],
      LA
    );
    expect(groups[0].slots.map(s => s.start)).toEqual([
      Date.parse('2026-09-11T16:00:00Z'),
      Date.parse('2026-09-11T20:00:00Z'),
    ]);
  });

  it('handles an empty or missing list', () => {
    expect(groupSlotsByDay([], LA)).toEqual([]);
    expect(groupSlotsByDay(undefined, LA)).toEqual([]);
  });
});

describe('formatDayLabel()', () => {
  it('labels the day in the coach timezone', () => {
    expect(formatDayLabel('2026-09-11', LA)).toMatch(/Fri/);
  });

  it('does not slip to the previous day in a behind-UTC zone', () => {
    // Formatting a bare midnight timestamp in Los Angeles would render the 10th.
    expect(formatDayLabel('2026-09-11', LA)).toMatch(/11/);
  });
});

describe('formatSlotTime()', () => {
  it('shows the time as the coach sees it', () => {
    // 22:30 UTC is 15:30 in Los Angeles during PDT.
    expect(formatSlotTime(Date.parse('2026-09-11T22:30:00Z'), LA)).toBe('15:30');
  });

  it('uses a 24-hour clock so 12 and 00 cannot be confused', () => {
    expect(formatSlotTime(Date.parse('2026-09-11T19:00:00Z'), LA)).toBe('12:00');
  });
});

describe('slotMatchesVariant()', () => {
  it('keeps a slot whose length matches the chosen variant', () => {
    expect(
      slotMatchesVariant(slot('2026-09-11T16:00:00Z', 60), { bookingLengthInMinutes: 60 })
    ).toBe(true);
  });

  it('rejects a slot of a different length', () => {
    // Booking a 60-minute slot against a 30-minute variant would charge for one and book the other.
    expect(
      slotMatchesVariant(slot('2026-09-11T16:00:00Z', 60), { bookingLengthInMinutes: 30 })
    ).toBe(false);
  });

  it('keeps everything when the variant carries no duration', () => {
    expect(slotMatchesVariant(slot('2026-09-11T16:00:00Z'), {})).toBe(true);
    expect(slotMatchesVariant(slot('2026-09-11T16:00:00Z'), null)).toBe(true);
  });
});
