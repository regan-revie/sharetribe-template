import React, { useEffect, useState } from 'react';
import { Form as FinalForm } from 'react-final-form';
import classNames from 'classnames';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { nylasAvailability } from '../../../util/api';

import { Form, H6, PrimaryButton } from '../../../components';

import EstimatedCustomerBreakdownMaybe from '../EstimatedCustomerBreakdownMaybe';
import FetchLineItemsError from '../FetchLineItemsError/FetchLineItemsError.js';

import { groupSlotsByDay, formatDayLabel, formatSlotTime, slotMatchesVariant } from './nylasSlots';
import css from './NylasBookingForm.module.css';

/**
 * Booking form driven by the coach's connected calendar rather than a Sharetribe availability plan.
 *
 * Replaces BookingFixedDurationForm for listings with calendar booking enabled. It deliberately
 * emits the same values that form does - bookingStartTime, bookingEndTime and priceVariantName - so
 * everything downstream of ListingPage.shared.js handleSubmit (line items, checkout, Stripe) is
 * untouched.
 *
 * Slots come from our own server rather than from Nylas directly: the coach's notice period is
 * applied there, and a filter applied in the browser would be one devtools edit away from being
 * bypassed.
 *
 * Note there is no sign-in gate here. CheckoutPage is declared with `auth: true`, so the router
 * redirects a logged-out visitor to sign in and returns them afterwards - which matters because the
 * live marketplace is public and a client can reach a listing page with no session.
 */
const NylasBookingForm = props => {
  const {
    rootClassName,
    className,
    listingId,
    timeZone,
    isOwnListing,
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
  const [selectedDayKey, setSelectedDayKey] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const listingIdString = listingId?.uuid || listingId;

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
      .catch(() => {
        if (cancelled) return;
        setAvailability({ status: 'error', slots: [], connected: true });
      });

    // Guards against a slower earlier request landing after a newer one and overwriting it.
    return () => {
      cancelled = true;
    };
  }, [listingIdString]);

  const initialPriceVariant = preselectedPriceVariant || priceVariants[0] || null;

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

        // A listing may sell several durations while Nylas returns slots at the configuration's
        // duration, so a slot that does not match the chosen variant would charge for one length
        // and book another.
        const matching = availability.slots.filter(s => slotMatchesVariant(s, chosenVariant));
        const days = groupSlotsByDay(matching, timeZone);
        const activeDay = days.find(d => d.dayKey === selectedDayKey) || days[0];

        const showBreakdown = selectedSlot && lineItems && !fetchLineItemsInProgress;

        return (
          <Form onSubmit={handleSubmit} className={classes} enforcePagePreloadFor="CheckoutPage">
            {isPriceVariationsInUse && PriceVariantField ? (
              <PriceVariantField
                priceVariants={priceVariants}
                // Changing duration invalidates whatever was picked, so clear it rather than leave
                // a selection that no longer matches what is being bought.
                onChange={() => {
                  setSelectedSlot(null);
                  form.change('bookingStartTime', null);
                  form.change('bookingEndTime', null);
                }}
                {...formRenderProps}
              />
            ) : null}

            {availability.status === 'loading' ? (
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
            ) : (
              <>
                <H6 as="h3" className={css.heading}>
                  <FormattedMessage id="NylasBookingForm.pickDay" defaultMessage="Choose a day" />
                </H6>
                <div className={css.days}>
                  {days.map(day => (
                    <button
                      key={day.dayKey}
                      type="button"
                      className={classNames(css.day, {
                        [css.daySelected]: activeDay && day.dayKey === activeDay.dayKey,
                      })}
                      onClick={() => {
                        setSelectedDayKey(day.dayKey);
                        setSelectedSlot(null);
                        form.change('bookingStartTime', null);
                        form.change('bookingEndTime', null);
                      }}
                    >
                      {formatDayLabel(day.dayKey, timeZone, intl.locale)}
                    </button>
                  ))}
                </div>

                <H6 as="h3" className={css.heading}>
                  <FormattedMessage id="NylasBookingForm.pickTime" defaultMessage="Choose a time" />
                </H6>
                <div className={css.slots}>
                  {(activeDay ? activeDay.slots : []).map(slot => (
                    <button
                      key={slot.start}
                      type="button"
                      className={classNames(css.slot, {
                        [css.slotSelected]: selectedSlot && slot.start === selectedSlot.start,
                      })}
                      onClick={() => handleSlotSelect(slot, values.priceVariantName, form)}
                    >
                      {formatSlotTime(slot.start, timeZone, intl.locale)}
                    </button>
                  ))}
                </div>

                {/* The coach's timezone, stated plainly. Without it a client in another country
                    silently reads these times as their own and turns up at the wrong hour. */}
                <p className={css.timeZoneNote}>
                  <FormattedMessage
                    id="NylasBookingForm.timeZoneNote"
                    defaultMessage="Times shown in {timeZone}"
                    values={{ timeZone }}
                  />
                </p>
              </>
            )}

            {showBreakdown ? (
              <EstimatedCustomerBreakdownMaybe
                lineItems={lineItems}
                timeZone={timeZone}
                marketplaceName={marketplaceName}
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
