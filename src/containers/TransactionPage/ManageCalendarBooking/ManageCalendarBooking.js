import React, { useEffect, useState } from 'react';

import { FormattedMessage, useIntl } from '../../../util/reactIntl';
import { getDefaultTimeZoneOnBrowser } from '../../../util/dates';
import {
  nylasAvailability,
  nylasBookingStatus,
  nylasCancelBooking,
  nylasRescheduleBooking,
} from '../../../util/api';
import NylasSlotPicker from '../../../components/OrderPanel/NylasBookingForm/NylasSlotPicker';

import { H4, PrimaryButton, SecondaryButton, InlineTextButton } from '../../../components';

import css from './ManageCalendarBooking.module.css';

/**
 * Cancel/reschedule for a calendar-booking session, on the customer's own transaction page.
 *
 * Exists as a self-contained component with its own local state rather than threading into
 * TransactionPage's Redux duck and generic transition-button machinery, because neither cancel nor
 * reschedule here is a Sharetribe transition: both call our own server, which talks to Nylas, and
 * the actual Sharetribe-side effect (a refund, or nothing) happens later via the booking.cancelled
 * webhook - see server/api/nylas/cancelBookingEndpoint.js for why Nylas's own hosted cancel/
 * reschedule links cannot be used instead.
 *
 * The displayed time comes from GET /api/nylas/booking-status, not from the transaction's own
 * booking dates: a reschedule updates our database, never Sharetribe's immutable booking record,
 * so that is the only place the current time can be read from once one has happened.
 */
const ManageCalendarBooking = ({ transactionId: transactionIdMaybe, listingId: listingIdMaybe }) => {
  // Callers pass the SDK entities' own .id (transaction.id, listing.id), which may be a UUID
  // object or already a plain string - normalised here rather than pushed onto every caller.
  const transactionId = transactionIdMaybe?.uuid || transactionIdMaybe;
  const listingId = listingIdMaybe?.uuid || listingIdMaybe;
  const intl = useIntl();
  const [status, setStatus] = useState({ state: 'loading' });
  const [mode, setMode] = useState('idle'); // 'idle' | 'confirm-cancel' | 'reschedule'
  const [availability, setAvailability] = useState({ state: 'idle', slots: [] });
  const [actionInProgress, setActionInProgress] = useState(false);
  const [actionError, setActionError] = useState(null);

  const loadStatus = () => {
    setStatus({ state: 'loading' });
    nylasBookingStatus({ transactionId })
      .then(data => setStatus({ state: 'loaded', ...data }))
      .catch(() => setStatus({ state: 'error' }));
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  const durationMinutes =
    status.state === 'loaded' && status.bookingStart && status.bookingEnd
      ? Math.round((new Date(status.bookingEnd) - new Date(status.bookingStart)) / 60000)
      : null;

  const startReschedule = () => {
    setMode('reschedule');
    setActionError(null);
    setAvailability({ state: 'loading', slots: [] });
    nylasAvailability({ listingId })
      .then(data => {
        const slots = (data.slots || []).filter(
          s => !durationMinutes || Math.round((s.end - s.start) / 60000) === durationMinutes
        );
        setAvailability({ state: 'loaded', slots });
      })
      .catch(() => setAvailability({ state: 'error', slots: [] }));
  };

  const handleCancel = () => {
    setActionInProgress(true);
    setActionError(null);
    nylasCancelBooking({ transactionId })
      .then(() => {
        setActionInProgress(false);
        setMode('idle');
        loadStatus();
      })
      .catch(e => {
        setActionInProgress(false);
        setActionError(e);
      });
  };

  const handleReschedule = slot => {
    setActionInProgress(true);
    setActionError(null);
    nylasRescheduleBooking({
      transactionId,
      start: new Date(slot.start).toISOString(),
      end: new Date(slot.end).toISOString(),
    })
      .then(() => {
        setActionInProgress(false);
        setMode('idle');
        loadStatus();
      })
      .catch(e => {
        setActionInProgress(false);
        setActionError(e);
      });
  };

  if (status.state === 'loading' || status.state === 'error') {
    return null;
  }

  const timeZone = getDefaultTimeZoneOnBrowser();
  const formattedTime =
    status.bookingStart && status.bookingEnd
      ? `${intl.formatDate(new Date(status.bookingStart), {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}, ${intl.formatTime(new Date(status.bookingStart))} – ${intl.formatTime(
          new Date(status.bookingEnd)
        )}`
      : null;

  return (
    <div className={css.root}>
      <H4 as="h2" className={css.heading}>
        <FormattedMessage id="ManageCalendarBooking.heading" />
      </H4>

      {formattedTime ? <p className={css.time}>{formattedTime}</p> : null}

      {actionError ? (
        <p className={css.error}>
          <FormattedMessage id="ManageCalendarBooking.genericError" />
        </p>
      ) : null}

      {mode === 'idle' ? (
        <div className={css.actions}>
          <SecondaryButton onClick={startReschedule}>
            <FormattedMessage id="ManageCalendarBooking.rescheduleButton" />
          </SecondaryButton>
          <InlineTextButton
            className={css.cancelLink}
            onClick={() => {
              setActionError(null);
              setMode('confirm-cancel');
            }}
          >
            <FormattedMessage id="ManageCalendarBooking.cancelButton" />
          </InlineTextButton>
        </div>
      ) : null}

      {mode === 'confirm-cancel' ? (
        <div className={css.confirmCancel}>
          <p><FormattedMessage id="ManageCalendarBooking.confirmCancelText" /></p>
          <div className={css.actions}>
            <PrimaryButton inProgress={actionInProgress} onClick={handleCancel}>
              <FormattedMessage id="ManageCalendarBooking.confirmCancelButton" />
            </PrimaryButton>
            <SecondaryButton disabled={actionInProgress} onClick={() => setMode('idle')}>
              <FormattedMessage id="ManageCalendarBooking.keepBookingButton" />
            </SecondaryButton>
          </div>
        </div>
      ) : null}

      {mode === 'reschedule' ? (
        <div className={css.reschedule}>
          {availability.state === 'loading' ? (
            <p><FormattedMessage id="ManageCalendarBooking.loadingSlots" /></p>
          ) : availability.state === 'error' || availability.slots.length === 0 ? (
            <p className={css.error}>
              <FormattedMessage id="ManageCalendarBooking.noSlots" />
            </p>
          ) : (
            // Same calendar + time-list picker as the original booking flow (NylasBookingForm),
            // so a client picks a new time the same way they picked the first one.
            <NylasSlotPicker
              slots={availability.slots}
              timeZone={timeZone}
              onSelectSlot={handleReschedule}
            />
          )}
          <SecondaryButton disabled={actionInProgress} onClick={() => setMode('idle')}>
            <FormattedMessage id="ManageCalendarBooking.cancelRescheduleButton" />
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
};

export default ManageCalendarBooking;
