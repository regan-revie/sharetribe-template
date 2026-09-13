import React, { useEffect, useMemo, useState } from 'react';
import { Form as FinalForm } from 'react-final-form';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { getDefaultTimeZoneOnBrowser, getTimeZoneNames } from '../../../util/dates';
import { nylasAvailability } from '../../../util/api';

import { Form, H6, PrimaryButton } from '../../../components';
import { DatePicker } from '../../DatePicker/DatePickers';
import { getISODateString } from '../../DatePicker/DatePickers/DatePicker.helpers';
import { BOOKING_PROCESS_NAME } from '../../../transactions/transaction';

import EstimatedCustomerBreakdownMaybe from '../EstimatedCustomerBreakdownMaybe';
import FetchLineItemsError from '../FetchLineItemsError/FetchLineItemsError.js';

import {
  groupSlotsByDay,
  dayKeyOf,
  formatDayLabel,
  formatSlotTime,
  slotMatchesVariant,
} from './nylasSlots';
import css from './NylasBookingForm.module.css';

/**
 * Booking form driven by the coach's connected calendar rather than a Sharetribe availability plan.
 *
 * Replaces BookingFixedDurationForm for listings with calendar booking enabled. It emits the same
 * values that form does - bookingStartTime, bookingEndTime and priceVariantName - so everything
 * downstream of ListingPage.shared.js handleSubmit is untouched.
 *
 * Times are shown in the **viewer's** timezone, not the coach's, so a client never has to work out
 * what "15:00 America/Los_Angeles" means for them. The zone is detected from the browser and shown
 * explicitly, and can be changed - a client booking while travelling wants their home zone, not
 * wherever they happen to be.
 *
 * Slots come from our own server rather than Nylas directly, because the coach's notice period is
 * enforced there and a filter applied in the browser would be one devtools edit away from bypass.
 *
 * There is no sign-in gate here: CheckoutPage is declared with `auth: true`, so the router redirects
 * a logged-out visitor to sign in and returns them, which matters because the live marketplace is
 * public.
 */
const NylasBookingForm = props => {
  const {
    rootClassName,
    className,
    listingId,
    isOwnListing,
    price,
    onFetchTransactionLineItems,
    lineItems,
    fetchLineItemsInProgress,
    fetchLineItemsError,
    isPriceVariationsInUse,
    priceVariants = [],
    priceVariantFieldComponent: PriceVariantField,
    preselectedPriceVariant,
    marketplaceName,
    payoutDetailsWarning,
    ...rest
  } = props;

  const intl = useIntl();
  const [availability, setAvailability] = useState({
    status: 'loading',
    slots: [],
    connected: true,
  });
  const [timeZone, setTimeZone] = useState(() => getDefaultTimeZoneOnBrowser());
  const [selectedDayKey, setSelectedDayKey] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const listingIdString = listingId?.uuid || listingId;

  // getISODateString is the calendar's own key for a cell: local Y/M/D, not an instant formatted in
  // another zone. Formatting local midnight in a zone behind the browser would roll it to the
  // previous day and block the wrong cells, so reuse the calendar's convention rather than
  // reimplementing it and hoping the two agree.
  const localDayKey = getISODateString;
  const timeZoneNames = useMemo(() => getTimeZoneNames(), []);

  useEffect(() => {
    let cancelled = false;
    setAvailability({ status: 'loading', slots: [], connected: true });

    nylasAvailability({ listingId: listingIdString })
      .then(response => {
        if (cancelled) return;
        setAvailability({
          status: 'ready',
          slots: response.slots || [],
          connected: response.connected !== false,
        });
      })
      .catch(e => {
        if (cancelled) return;
        // Swallowing this leaves the client staring at "try again shortly" and whoever is debugging
        // with nothing. The status separates the causes: 403 is the session, 502 the calendar
        // provider, 400 the request itself.
        console.error(
          `[nylas] Could not load availability for listing ${listingIdString}: ` +
            `status=${e?.status || 'none'} ${e?.message || e}`,
          e?.data || ''
        );
        setAvailability({ status: 'error', slots: [], connected: true });
      });

    // Guards against a slower earlier request landing after a newer one and overwriting it.
    return () => {
      cancelled = true;
    };
  }, [listingIdString]);

  const initialPriceVariant = preselectedPriceVariant || priceVariants[0] || null;

  const clearSelection = form => {
    setSelectedSlot(null);
    form.change('bookingStartTime', null);
    form.change('bookingEndTime', null);
  };

  const handleSlotSelect = (slot, priceVariantName, form) => {
    setSelectedSlot(slot);
    form.change('bookingStartTime', String(slot.start));
    form.change('bookingEndTime', String(slot.end));

    if (isOwnListing) return;

    onFetchTransactionLineItems({
      orderData: {
        bookingStart: new Date(slot.start),
        bookingEnd: new Date(slot.end),
        ...(priceVariantName ? { priceVariantName } : {}),
      },
      listingId,
      isOwnListing,
    });
  };

  const classes = classNames(rootClassName || css.root, className);

  return (
    <FinalForm
      {...rest}
      initialValues={initialPriceVariant ? { priceVariantName: initialPriceVariant.name } : {}}
      render={formRenderProps => {
        const { handleSubmit, form, values } = formRenderProps;

        const chosenVariant =
          priceVariants.find(v => v.name === values.priceVariantName) || initialPriceVariant;

        // Nylas returns slots at the configuration's duration, so a slot that does not match the
        // chosen variant would charge for one length and book another.
        const matching = availability.slots.filter(s => slotMatchesVariant(s, chosenVariant));
        const days = groupSlotsByDay(matching, timeZone);
        const availableDayKeys = new Set(days.map(d => d.dayKey));
        const activeDay = days.find(d => d.dayKey === selectedDayKey) || days[0];

        const showBreakdown = selectedSlot && lineItems && !fetchLineItemsInProgress;

        const notReady =
          availability.status === 'loading' ? (
            <p className={css.notice}>
              <FormattedMessage
                id="NylasBookingForm.loading"
                defaultMessage="Loading available times…"
              />
            </p>
          ) : availability.status === 'error' ? (
            <p className={css.error}>
              <FormattedMessage
                id="NylasBookingForm.error"
                defaultMessage="We couldn't load available times. Please try again shortly."
              />
            </p>
          ) : !availability.connected ? (
            <p className={css.notice}>
              <FormattedMessage
                id="NylasBookingForm.notConnected"
                defaultMessage="This coach hasn't connected their calendar yet, so online booking isn't available."
              />
            </p>
          ) : days.length === 0 ? (
            <p className={css.notice}>
              <FormattedMessage
                id="NylasBookingForm.noSlots"
                defaultMessage="No times are available at the moment. Please check back soon."
              />
            </p>
          ) : null;

        return (
          <Form onSubmit={handleSubmit} className={classes} enforcePagePreloadFor="CheckoutPage">
            {isPriceVariationsInUse && PriceVariantField ? (
              <PriceVariantField
                priceVariants={priceVariants}
                // Changing duration invalidates the pick, so clear it rather than leave a selection
                // that no longer matches what is being bought.
                onChange={() => clearSelection(form)}
                {...formRenderProps}
              />
            ) : null}

            {notReady || (
              <div className={css.picker}>
                <div className={css.dayColumn}>
                  <DatePicker
                    range={false}
                    showMonthStepper={true}
                    // A Date or null, never an array: for range={false} the calendar ignores
                    // anything else, and the selection then cannot move off the first day.
                    // Midday avoids a midnight value landing on the previous day.
                    value={activeDay ? new Date(`${activeDay.dayKey}T12:00:00`) : null}
                    // A day with no slots is not selectable, so the shape of a coach's availability
                    // is visible at a glance rather than discovered by clicking through empty days.
                    isDayBlocked={day => !availableDayKeys.has(localDayKey(day))}
                    onChange={value => {
                      const picked = Array.isArray(value) ? value[0] : value;
                      if (!picked) return;
                      setSelectedDayKey(localDayKey(picked));
                      clearSelection(form);
                    }}
                  />
                </div>

                <div className={css.timeColumn}>
                  <H6 as="h3" className={css.heading}>
                    {activeDay
                      ? formatDayLabel(activeDay.dayKey, timeZone, intl.locale)
                      : intl.formatMessage({
                          id: 'NylasBookingForm.pickTime',
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
                            onClick={() => handleSlotSelect(slot, values.priceVariantName, form)}
                          >
                            {formatSlotTime(slot.start, timeZone, intl.locale)}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </div>
            )}

            {/* Stated and changeable rather than assumed. A client booking while travelling wants
                their home zone, not wherever the laptop currently is. */}
            <label className={css.timeZoneRow}>
              <span className={css.timeZoneLabel}>
                <FormattedMessage
                  id="NylasBookingForm.timeZoneLabel"
                  defaultMessage="Times shown in"
                />
              </span>
              <select
                className={css.timeZoneSelect}
                value={timeZone}
                onChange={e => {
                  setTimeZone(e.target.value);
                  // Day boundaries move with the zone, so a previously chosen day may no longer
                  // exist and the selected slot may now sit on a different date.
                  setSelectedDayKey(null);
                  clearSelection(form);
                }}
              >
                {timeZoneNames.map(zone => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>

            {showBreakdown ? (
              <EstimatedCustomerBreakdownMaybe
                lineItems={lineItems}
                timeZone={timeZone}
                currency={price?.currency}
                marketplaceName={marketplaceName}
                processName={BOOKING_PROCESS_NAME}
              />
            ) : null}

            <FetchLineItemsError error={fetchLineItemsError} />

            <div className={css.submitButton}>
              <PrimaryButton type="submit" disabled={!selectedSlot || fetchLineItemsInProgress}>
                <FormattedMessage
                  id="NylasBookingForm.requestToBook"
                  defaultMessage="Request to book"
                />
              </PrimaryButton>
            </div>
            {payoutDetailsWarning}
          </Form>
        );
      }}
    />
  );
};

export default NylasBookingForm;
