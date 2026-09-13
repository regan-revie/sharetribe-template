import React, { useState } from 'react';
import classNames from 'classnames';

import { useIntl } from '../../../util/reactIntl';
import { DatePicker } from '../../DatePicker/DatePickers';
import { getISODateString } from '../../DatePicker/DatePickers/DatePicker.helpers';

import { H6 } from '../../../components';

import { formatDayLabel, formatSlotTime, groupSlotsByDay } from './nylasSlots';

import css from './NylasSlotPicker.module.css';

/**
 * The calendar + time-list picker for a coach's available slots.
 *
 * Shared between the initial booking form and the reschedule panel on a customer's order page
 * (src/containers/TransactionPage/ManageCalendarBooking/), so a client picks a new time the same
 * way in both places rather than learning two different pickers for what is, to them, the same
 * action.
 *
 * Deliberately has no opinion on loading/error/empty states - a caller with its own copy for
 * "loading", "no slots available" etc. renders that instead of this component; `slots` is assumed
 * non-empty when this is rendered at all.
 *
 * @param {object} props
 * @param {Array<{start: number, end: number}>} props.slots epoch milliseconds, already filtered to
 *   whatever duration/notice/working-hours rules apply
 * @param {string} props.timeZone IANA zone to display in
 * @param {{start: number}} [props.selectedSlot] highlights the matching slot button
 * @param {(slot: {start: number, end: number}) => void} props.onSelectSlot
 * @param {() => void} [props.onDayChange] called when the calendar's active day changes, so a
 *   caller holding its own "selected slot" state can clear a pick that no longer applies
 */
const NylasSlotPicker = ({ slots, timeZone, selectedSlot, onSelectSlot, onDayChange }) => {
  const intl = useIntl();
  const [selectedDayKey, setSelectedDayKey] = useState(null);

  const days = groupSlotsByDay(slots, timeZone);
  const availableDayKeys = new Set(days.map(d => d.dayKey));
  const activeDay = days.find(d => d.dayKey === selectedDayKey) || days[0];

  return (
    <div className={css.picker}>
      <div className={css.dayColumn}>
        <DatePicker
          range={false}
          showMonthStepper={true}
          // A Date or null, never an array: for range={false} the calendar ignores anything else,
          // and the selection then cannot move off the first day. Midday avoids a midnight value
          // landing on the previous day.
          value={activeDay ? new Date(`${activeDay.dayKey}T12:00:00`) : null}
          // A day with no slots is not selectable, so the shape of a coach's availability is
          // visible at a glance rather than discovered by clicking through empty days.
          isDayBlocked={day => !availableDayKeys.has(getISODateString(day))}
          onChange={value => {
            const picked = Array.isArray(value) ? value[0] : value;
            if (!picked) return;
            setSelectedDayKey(getISODateString(picked));
            onDayChange?.();
          }}
        />
      </div>

      <div className={css.timeColumn}>
        <H6 as="h3" className={css.heading}>
          {activeDay
            ? formatDayLabel(activeDay.dayKey, timeZone, intl.locale)
            : intl.formatMessage({
                id: 'NylasSlotPicker.pickTime',
                defaultMessage: 'Choose a time',
              })}
        </H6>
        <ol className={css.timeList}>
          {(activeDay ? activeDay.slots : []).map(slot => {
            const isActive = selectedSlot && slot.start === selectedSlot.start;
            return (
              <li key={slot.start}>
                <button
                  type="button"
                  className={classNames(css.slot, { [css.slotSelected]: isActive })}
                  aria-pressed={isActive}
                  onClick={() => onSelectSlot(slot)}
                >
                  {formatSlotTime(slot.start, timeZone, intl.locale)}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
};

export default NylasSlotPicker;
