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

  it('renders slots in the coach timezone and states which timezone that is', async () => {
    // 22:30 UTC is 15:30 in Los Angeles. Without the note, a client elsewhere reads it as local
    // time and turns up at the wrong hour.
    jest.spyOn(api, 'nylasAvailability').mockResolvedValue({
      slots: [slot('2026-09-11T22:30:00Z')],
      connected: true,
    });
    render(<NylasBookingForm {...baseProps} />);
    await waitFor(() => expect(screen.getByText('15:30')).toBeInTheDocument());
    expect(screen.getByText(/America\/Los_Angeles/)).toBeInTheDocument();
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
