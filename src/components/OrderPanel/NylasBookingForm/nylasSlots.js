/**
 * Pure helpers for turning the availability endpoint's flat slot list into something renderable.
 *
 * Kept separate from the component so the date handling - which is where booking UIs usually go
 * wrong - can be tested without rendering anything.
 */

/**
 * Group slots into days as seen from a given timezone.
 *
 * Callers pass the **viewer's** timezone, not the coach's. An earlier version grouped by the coach's
 * zone to stop a slot appearing under the wrong day, but that was the wrong way round: a client
 * choosing a session is picking a slot in their own week, so if a slot falls at 3am Saturday for
 * them then Saturday is genuinely where it belongs. Making the client do timezone arithmetic to
 * work out which of their days a "Friday" slot lands on is exactly the confusion to avoid.
 *
 * @param {Array<{start: number, end: number}>} slots epoch milliseconds
 * @param {string} timeZone IANA zone the viewer is reading times in
 * @returns {Array<{dayKey: string, slots: Array}>} ordered by day
 */
export const dayKeyOf = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date));

export const groupSlotsByDay = (slots, timeZone) => {
  const byDay = new Map();
  (slots || []).forEach(slot => {
    // en-CA gives YYYY-MM-DD, which sorts lexicographically and so needs no date parsing to order.
    const dayKey = dayKeyOf(slot.start, timeZone);
    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, []);
    }
    byDay.get(dayKey).push(slot);
  });

  return Array.from(byDay.entries())
    .map(([dayKey, daySlots]) => ({
      dayKey,
      slots: daySlots.slice().sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) => (a.dayKey < b.dayKey ? -1 : 1));
};

/** A day heading in the given timezone, e.g. "Fri 11 Sep". */
export const formatDayLabel = (dayKey, timeZone, locale = 'en-GB') => {
  // Midday avoids the edge where a midnight timestamp lands on the previous day in some zones.
  const date = new Date(`${dayKey}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
};

/** A slot's start time in the given timezone, e.g. "15:30". */
export const formatSlotTime = (startMs, timeZone, locale = 'en-GB') =>
  new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(startMs));

/**
 * Whether a slot matches the duration the chosen price variant is sold in.
 *
 * Nylas returns slots at the configuration's duration, but a listing may offer several variants of
 * different lengths. Showing a 60-minute slot to someone who selected a 30-minute variant would
 * charge them for one thing and book another.
 */
export const slotMatchesVariant = (slot, priceVariant) => {
  const wanted = priceVariant && priceVariant.bookingLengthInMinutes;
  if (!wanted) return true;
  return (slot.end - slot.start) / 60000 === wanted;
};
