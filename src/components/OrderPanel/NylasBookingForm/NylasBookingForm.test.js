import React from 'react';
import '@testing-library/jest-dom';

import { renderWithProviders as render, testingLibrary } from '../../../util/testHelpers';
import * as api from '../../../util/api';
import NylasBookingForm from './NylasBookingForm';

const { screen, waitFor, userEvent } = testingLibrary;

const LA = 'America/Los_Angeles';
const slot = (iso, minutes = 60) => {
  const start = Date.parse(iso);
  return { start, end: start + minutes * 60000 };
};

const baseProps = {
  listingId: 'listing-1',
  timeZone: LA,
  isOwnListing: false,
  onSubmit: jest.fn(),
  onFetchTransactionLineItems: jest.fn(),
  marketplaceName: 'Revie',
  priceVariants: [{ name: 'test', bookingLengthInMinutes: 60, priceInSubunits: 5000 }],
};

afterEach(() => jest.restoreAllMocks());

describe('NylasBookingForm', () => {
  it('tells the client when the coach has not connected a calendar', async () => {
    // A normal state, not an error - an empty calendar with no explanation looks broken.
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({ slots: [], connected: false });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByText(/hasn't connected their calendar/i)).toBeInTheDocument()
    );
  });

  it('explains an empty calendar differently from a missing one', async () => {
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({ slots: [], connected: true });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/No times are available/i)).toBeInTheDocument());
  });

  it('surfaces a failure rather than showing an empty calendar', async () => {
    jest.spyOn(api, 'nylasAvailability').mockRejectedValue(new Error('boom'));
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() =>
      expect(screen.getByText(/couldn't load available times/i)).toBeInTheDocument()
    );
  });

  it('renders slots in the viewer timezone, not the coach timezone', async () => {
    // The client should never do timezone arithmetic. Expected time is computed in the browser's
    // own zone so the assertion holds wherever the suite runs, rather than pinning one zone.
    const start = Date.parse('2026-09-11T22:30:00Z');
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = new Intl.DateTimeFormat('en-GB', {
      timeZone: viewerZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(start));

    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [{ start, end: start + 3600000 }],
      connected: true,
    });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText(expected)).toBeInTheDocument());
  });

  it('shows which timezone the times are in, and lets the client change it', async () => {
    // Stated rather than assumed: a client booking while travelling wants their home zone, not
    // wherever the laptop currently is.
    const start = Date.parse('2026-09-11T22:30:00Z');
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [{ start, end: start + 3600000 }],
      connected: true,
    });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Times shown in/i)).toBeInTheDocument());

    const select = screen.getByRole('combobox');
    expect(select).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('cannot be submitted until a slot is chosen', async () => {
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [slot('2026-09-11T22:30:00Z')],
      connected: true,
    });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText('15:30')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /request to book/i })).toBeDisabled();
    await userEvent.click(screen.getByText('15:30'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /request to book/i })).toBeEnabled()
    );
  });

  it('asks for a price breakdown when a slot is picked', async () => {
    const onFetchTransactionLineItems = jest.fn();
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [slot('2026-09-11T22:30:00Z')],
      connected: true,
    });
    render(
      <NylasBookingForm {...baseProps} onFetchTransactionLineItems={onFetchTransactionLineItems} />
    );
    await waitFor(() => expect(screen.getByText('15:30')).toBeInTheDocument());
    await userEvent.click(screen.getByText('15:30'));

    expect(onFetchTransactionLineItems).toHaveBeenCalledWith(
      expect.objectContaining({
        orderData: expect.objectContaining({
          bookingStart: new Date(Date.parse('2026-09-11T22:30:00Z')),
          bookingEnd: new Date(Date.parse('2026-09-11T23:30:00Z')),
          priceVariantName: 'test',
        }),
      })
    );
  });

  it('hides slots that do not match the chosen variant duration', async () => {
    // Booking a 60-minute slot against a 30-minute variant would charge for one and book the other.
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [slot('2026-09-11T22:30:00Z', 60)],
      connected: true,
    });
    render(
      <NylasBookingForm
        {...baseProps}
        priceVariants={[{ name: 'short', bookingLengthInMinutes: 30, priceInSubunits: 2500 }]}
      />
    );
    await waitFor(() => expect(screen.getByText(/No times are available/i)).toBeInTheDocument());
    expect(screen.queryByText('15:30')).not.toBeInTheDocument();
  });
});

describe('the calendar', () => {
  // Regression: the calendar was given `value` as an array. For range={false} it accepts only a
  // Date or null, so its internal value never synced and the selection could not move off the
  // first available day - every other day looked selectable but did nothing.
  const threeDays = () => {
    const base = Date.parse('2026-09-14T16:00:00Z');
    return [0, 1, 2].map(d => {
      const start = base + d * 86400000;
      return { start, end: start + 3600000 };
    });
  };

  it('leaves every day with availability selectable, not just the first', async () => {
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({ slots: threeDays(), connected: true });
    const { container } = render(<NylasBookingForm {...baseProps} />);

    await waitFor(() => expect(container.querySelector('[aria-disabled="false"]')).toBeTruthy());
    const selectable = container.querySelectorAll('[aria-disabled="false"]');
    expect(selectable.length).toBeGreaterThanOrEqual(3);
  });

  it('blocks days with no availability', async () => {
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({ slots: threeDays(), connected: true });
    const { container } = render(<NylasBookingForm {...baseProps} />);

    await waitFor(() => expect(container.querySelector('[aria-disabled="false"]')).toBeTruthy());
    // A month has far more days than the three with slots, so most cells must be blocked -
    // otherwise the client discovers empty days by clicking through them.
    const blocked = container.querySelectorAll('[aria-disabled="true"]');
    expect(blocked.length).toBeGreaterThan(20);
  });
});
