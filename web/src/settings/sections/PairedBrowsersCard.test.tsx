/**
 * Paired browsers card (Settings → About, server build): the setup hint while pairing is off, the
 * configured Pages address, the list (most recently used first, "Old address" for pairings made for
 * another Pages address) and Revoke behind a confirmation, with the list refreshed afterwards.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PairingSummary, PairingsResponse } from '@portly/shared';
import { settings } from '../../test/fixtures.ts';
import { mockError, mockResponse, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import PairedBrowsersCardDefault, { PairedBrowsersCard } from './PairedBrowsersCard.tsx';

const PAGES_URL = 'https://user.github.io/portly/';

function pairing(overrides: Partial<PairingSummary> = {}): PairingSummary {
  return {
    id: 'p1',
    label: 'Edge on Windows',
    origin: 'https://user.github.io',
    createdAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: '2026-10-10T09:00:00.000Z',
    current: true,
    ...overrides,
  };
}

function response(overrides: Partial<PairingsResponse> = {}): PairingsResponse {
  return { pagesUrl: PAGES_URL, instanceId: 'instance-1', pairings: [], ...overrides };
}

function renderCard(mocks: Record<string, ApiMock>) {
  const result = renderWithProviders(<PairedBrowsersCard />, { apiMocks: { 'GET /api/settings': settings(), ...mocks } });
  return { ...result, user: userEvent.setup() };
}

describe('PairedBrowsersCard', () => {
  it('is also the default export', () => {
    expect(PairedBrowsersCardDefault).toBe(PairedBrowsersCard);
  });

  it('explains how to turn pairing on while no Pages address is configured', async () => {
    renderCard({ 'GET /api/pairings': response({ pagesUrl: null }) });
    const card = await screen.findByRole('region', { name: 'Paired browsers' });
    expect(await within(card).findByText('PORTLY_PAGES_URL')).toBeInTheDocument();
    expect(within(card).getByText(/Pairing is off/)).toBeInTheDocument();
    expect(within(card).getByText('docs/setup/pages-local-server.md')).toBeInTheDocument();
    expect(within(card).queryByRole('list', { name: 'Paired browsers' })).not.toBeInTheDocument();
  });

  it('shows the Pages address and says when no browser is paired yet', async () => {
    renderCard({ 'GET /api/pairings': response() });
    expect(await screen.findByRole('link', { name: /https:\/\/user\.github\.io\/portly\// })).toHaveAttribute('href', PAGES_URL);
    expect(screen.getByText(/No browser is paired yet/)).toBeInTheDocument();
  });

  it('lists the pairings, most recently used first, marking ones made for an old address', async () => {
    renderCard({
      'GET /api/pairings': response({
        pairings: [
          pairing({ id: 'old', label: 'Chrome on Windows', origin: 'https://old.example', lastUsedAt: null, current: false }),
          pairing(),
          pairing({ id: 'p2', label: 'Firefox on Windows', createdAt: '2026-10-05T10:00:00.000Z', lastUsedAt: null }),
        ],
      }),
    });
    const list = await screen.findByRole('list', { name: 'Paired browsers' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/on Windows$/).textContent)).toEqual(['Edge on Windows', 'Firefox on Windows', 'Chrome on Windows']);

    expect(within(rows[0]!).getByText(/last used/)).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Old address')).not.toBeInTheDocument();
    expect(rows[0]!.querySelectorAll('time')).toHaveLength(2);

    expect(within(rows[1]!).getByText(/never used/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Old address')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/https:\/\/old\.example/)).toBeInTheDocument();
  });

  it('revokes a pairing after confirmation and refreshes the list', async () => {
    let pairings = [pairing(), pairing({ id: 'p2', label: 'Firefox on Windows' })];
    const { user, requestsTo } = renderCard({
      'GET /api/pairings': () => response({ pairings }),
      'DELETE /api/pairings/:id': (req: MockRequest) => {
        pairings = pairings.filter((p) => p.id !== req.params.id);
        return mockResponse(204);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke Edge on Windows' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke Edge on Windows?' });
    expect(requestsTo('DELETE /api/pairings/p1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Edge on Windows' })).not.toBeInTheDocument());
    expect(requestsTo('DELETE /api/pairings/p1')).toHaveLength(1);
    expect(requestsTo('GET /api/pairings').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Revoke Firefox on Windows' })).toBeInTheDocument();
    expect(await screen.findByText('Edge on Windows was unpaired.')).toBeInTheDocument();
  });

  it('treats an already removed pairing as revoked', async () => {
    let pairings = [pairing()];
    const { user } = renderCard({
      'GET /api/pairings': () => response({ pairings }),
      'DELETE /api/pairings/:id': () => {
        pairings = [];
        return mockError(404, 'not_found', 'Pairing not found');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke Edge on Windows' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/No browser is paired yet/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and reports a failed revoke', async () => {
    const { user } = renderCard({
      'GET /api/pairings': response({ pairings: [pairing()] }),
      'DELETE /api/pairings/:id': mockError(500, 'internal', 'Database is busy'),
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke Edge on Windows' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Database is busy')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows an error with Retry when the list cannot be read', async () => {
    renderCard({ 'GET /api/pairings': mockError(500, 'internal', 'Boom') });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
