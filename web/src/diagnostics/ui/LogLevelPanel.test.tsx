/**
 * Logging level: the switch turns verbose on for the chosen duration and areas (`PUT
 * /api/diagnostics/level`) or off; "until turned off" ends at the next restart; while verbose is
 * on, a changed duration or area choice waits for Apply; the state reads "Verbose until 14:32".
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { LogLevelState } from '@portly/shared';
import { mockError, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { LogLevelPanel } from './LogLevelPanel.tsx';

const NORMAL: LogLevelState = { level: 'info', verbose: false, until: null, areas: null, bootLevel: 'info', persisted: false };
const UNTIL = '2026-10-11T14:32:00.000Z';

function renderPanel(state: LogLevelState, answer: unknown = (req: MockRequest) => ({ ...NORMAL, verbose: (req.body as { verbose: boolean }).verbose, level: 'debug' })) {
  return renderWithProviders(<LogLevelPanel state={state} />, { apiMocks: { 'PUT /api/diagnostics/level': answer } });
}

describe('LogLevelPanel', () => {
  it('turns verbose on for 2 hours, all areas, by default', async () => {
    const { requestsTo } = renderPanel(NORMAL);
    expect(screen.getByText(/^Normal: state changes, failures and recoveries/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '2 h' })).toBeChecked();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Verbose logging' }));
    await waitFor(() => expect(requestsTo('PUT /api/diagnostics/level')).toHaveLength(1));
    expect(requestsTo('PUT /api/diagnostics/level')[0]!.body).toEqual({ verbose: true, minutes: 120, areas: null });
  });

  it('sends the chosen duration and areas; "until turned off" has no end', async () => {
    const { requestsTo } = renderPanel(NORMAL);
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Until turned off' }));
    expect(screen.getByText('“Until turned off” ends at the next restart of Portly.')).toBeInTheDocument();
    const areas = screen.getByRole('group', { name: 'Areas' });
    await user.click(within(areas).getByRole('checkbox', { name: 'Mail' }));
    await user.click(within(areas).getByRole('checkbox', { name: 'Calendar' }));
    await user.click(screen.getByRole('switch', { name: 'Verbose logging' }));
    await waitFor(() => expect(requestsTo('PUT /api/diagnostics/level')).toHaveLength(1));
    // Areas in their canonical order.
    expect(requestsTo('PUT /api/diagnostics/level')[0]!.body).toEqual({ verbose: true, minutes: null, areas: ['calendar', 'mail'] });
  });

  it('shows "Verbose until …", turns it off, and applies a changed duration only on Apply', async () => {
    const { requestsTo } = renderPanel({ level: 'debug', verbose: true, until: UNTIL, areas: ['calendar'], bootLevel: 'info', persisted: true });
    expect(screen.getByText(/^Verbose for Calendar until .+, also after a restart\.$/)).toBeInTheDocument();
    expect(screen.getAllByText(/^Verbose until /).length).toBeGreaterThan(0);
    expect(within(screen.getByRole('group', { name: 'Areas' })).getByRole('checkbox', { name: 'Calendar' })).toBeChecked();
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '30 min' }));
    expect(requestsTo('PUT /api/diagnostics/level')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(requestsTo('PUT /api/diagnostics/level')).toHaveLength(1));
    expect(requestsTo('PUT /api/diagnostics/level')[0]!.body).toEqual({ verbose: true, minutes: 30, areas: ['calendar'] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('switch', { name: 'Verbose logging' }));
    await waitFor(() => expect(requestsTo('PUT /api/diagnostics/level')).toHaveLength(2));
    expect(requestsTo('PUT /api/diagnostics/level')[1]!.body).toEqual({ verbose: false });
  });

  it('says that "until turned off" ends at the next restart, and names a non-default start level', () => {
    renderPanel({ level: 'debug', verbose: true, until: null, areas: null, bootLevel: 'debug', persisted: false });
    expect(screen.getByText('Verbose until turned off. Ends at the next restart of Portly.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Until turned off' })).toBeChecked();
    expect(screen.getByText(/Portly starts at level/)).toHaveTextContent('Portly starts at level debug (PORTLY_LOG_LEVEL); Normal means that level.');
  });

  it('tells when the level could not be changed', async () => {
    renderPanel(NORMAL, mockError(403, 'local_only', 'Only on Portly itself'));
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Verbose logging' }));
    expect(await screen.findByText('Only on Portly itself')).toBeInTheDocument();
  });
});
