import React, { useEffect, useMemo, useState } from 'react';
import { Form as FinalForm } from 'react-final-form';
import classNames from 'classnames';

import { FormattedMessage } from '../../../util/reactIntl';
import { getDefaultTimeZoneOnBrowser, getTimeZoneNames } from '../../../util/dates';
import { nylasAvailability } from '../../../util/api';

import { Form, PrimaryButton } from '../../../components';
import { BOOKING_PROCESS_NAME } from '../../../transactions/transaction';

import EstimatedCustomerBreakdownMaybe from '../EstimatedCustomerBreakdownMaybe';
import FetchLineItemsError from '../FetchLineItemsError/FetchLineItemsError.js';
import NylasSlotPicker from './NylasSlotPicker';

import { groupSlotsByDay, slotMatchesVariant } from './nylasSlots';
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

  const [availability, setAvailability] = useState({
    status: 'loading',
    slots: [],
    connected: true,
  });
  const [timeZone, setTimeZone] = useState(() => getDefaultTimeZoneOnBrowser());
  const [selectedSlot, setSelectedSlot] = useState(null);

  const listingIdString = listingId?.uuid || listingId;

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
              // Remounts on a timezone change (via key), which resets its internally-held day
              // selection - day boundaries move with the zone, so a previously chosen day may no
              // longer exist. clearSelection below only needs to clear the *slot*.
              <NylasSlotPicker
                key={timeZone}
                slots={matching}
                timeZone={timeZone}
                selectedSlot={selectedSlot}
                onSelectSlot={slot => handleSlotSelect(slot, values.priceVariantName, form)}
                onDayChange={() => clearSelection(form)}
              />
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
                  // The selected slot may no longer make sense on the new zone's day boundaries.
                  // NylasSlotPicker's own day selection resets itself, via its key={timeZone}.
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
