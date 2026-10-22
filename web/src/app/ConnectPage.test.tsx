/**
 * The connect screen another PC sees: picking up an earlier request, asking with a name, the code
 * while waiting, the reload once approved, denied/expired/gone with Ask again, the refusals the
 * server can answer, and the misrouted page.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceRequestCreateResponse, DeviceRequestStatusResponse } from '@portly/shared';
import { mockError, renderWithProviders, type ApiMock } from '../test/render.tsx';
import { ConnectPage, MisroutedPage } from './ConnectPage.tsx';

const EXPIRES = new Date(Date.now() + 9 * 60_000).toISOString();

function created(): DeviceRequestCreateResponse {
  return { id: 'req-1', code: 'K7Q-4MP', expiresAt: EXPIRES };
}

function status(state: DeviceRequestStatusResponse['status'], device: DeviceRequestStatusResponse['device'] = null): DeviceRequestStatusResponse {
  return { status: state, id: 'req-1', code: 'K7Q-4MP', expiresAt: EXPIRES, device };
}

/** A status mock that answers each poll in turn (the last answer repeats). */
function polls(...answers: (DeviceRequestStatusResponse | ReturnType<typeof mockError>)[]): ApiMock {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
}

describe('ConnectPage', () => {
  it('shows the form when there is no request yet, asks with the name, then waits with the code', async () => {
    const user = userEvent.setup();
    const t = renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': polls(mockError(404, 'not_found'), status('pending')),
        'POST /api/devices/requests': created(),
      },
    });
    const name = await screen.findByLabelText('Name of this PC');
    expect(name).toHaveValue('This PC');
    await user.clear(name);
    await user.type(name, 'Laptop');
    await user.click(screen.getByRole('button', { name: 'Ask to connect' }));
    expect(await screen.findByText('K7Q-4MP')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting for approval on the main PC' })).toBeInTheDocument();
    expect(t.requestsTo('POST /api/devices/requests')[0]?.body).toEqual({ label: 'Laptop' });
    expect(t.requestsTo('POST /api/devices/requests')[0]?.headers.get('X-Portly')).toBe('1');
  });

  it('fills the name in with what the main PC suggests', async () => {
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': mockError(404, 'not_found'),
        'GET /api/devices/requests/suggestion': { label: 'STUDY-LAPTOP' },
      },
    });
    expect(await screen.findByDisplayValue('STUDY-LAPTOP')).toHaveAccessibleName('Name of this PC');
  });

  it('still gets the suggestion when the first try could not reach Portly and Retry did', async () => {
    const user = userEvent.setup();
    let down = true;
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': () => {
          if (down) throw new TypeError('Failed to fetch');
          return mockError(404, 'not_found');
        },
        'GET /api/devices/requests/suggestion': { label: 'STUDY-LAPTOP' },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Portly can’t be reached' })).toBeInTheDocument();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByDisplayValue('STUDY-LAPTOP')).toBeInTheDocument();
  });

  it('drops a suggestion that arrives after the user started typing', async () => {
    const user = userEvent.setup();
    let answer: (value: { label: string | null }) => void = () => {};
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': mockError(404, 'not_found'),
        'GET /api/devices/requests/suggestion': () => new Promise((resolve) => (answer = resolve)),
      },
    });
    const name = await screen.findByLabelText('Name of this PC');
    await user.clear(name);
    await user.type(name, 'Mine');
    answer({ label: 'STUDY-LAPTOP' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(name).toHaveValue('Mine');
  });

  it.each([
    ['has none', { label: null }],
    ['cannot be asked', mockError(500, 'internal', '')],
  ] as const)('keeps the default name when the main PC %s', async (_case, answer) => {
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': mockError(404, 'not_found'),
        'GET /api/devices/requests/suggestion': answer,
      },
    });
    const name = await screen.findByLabelText('Name of this PC');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(name).toHaveValue('This PC');
  });

  it('picks up a request made earlier in this browser and reloads once it is approved', async () => {
    const reload = vi.fn();
    renderWithProviders(<ConnectPage reload={reload} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': polls(status('pending'), status('pending'), status('approved', { id: 'd1', label: 'Laptop', createdAt: EXPIRES })),
      },
    });
    expect(await screen.findByText('K7Q-4MP')).toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    // Reloads once, however many answers arrive after that.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['denied', 'The request was denied on the main PC'],
    ['expired', 'The request expired'],
  ] as const)('explains a %s request and offers to ask again', async (state, title) => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: { 'GET /api/devices/requests/current': polls(status('pending'), status(state)) },
    });
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(await screen.findByLabelText('Name of this PC')).toBeInTheDocument();
  });

  it('says so when the server no longer knows the request it was waiting for', async () => {
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: { 'GET /api/devices/requests/current': polls(status('pending'), mockError(404, 'not_found')) },
    });
    expect(await screen.findByRole('heading', { name: 'The request is no longer there' })).toBeInTheDocument();
  });

  it('shows why a request was refused: too many waiting, or other PCs not set up', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': mockError(404, 'not_found'),
        'POST /api/devices/requests': mockError(429, 'rate_limited'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Ask to connect' }));
    expect(await screen.findByText(/Too many PCs are waiting/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name of this PC')).toBeInTheDocument();
  });

  it('offers Retry when Portly cannot be reached', async () => {
    const user = userEvent.setup();
    let down = true;
    renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: {
        'GET /api/devices/requests/current': () => {
          if (down) throw new TypeError('Failed to fetch');
          return mockError(404, 'not_found');
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Portly can’t be reached' })).toBeInTheDocument();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Name of this PC')).toBeInTheDocument();
  });
});

describe('ConnectPage while waiting', () => {
  it('polls slowly while the tab is hidden, at once when it is visible again, and never after the request ended', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    const t = renderWithProviders(<ConnectPage reload={vi.fn()} pollMs={20} />, {
      apiMocks: { 'GET /api/devices/requests/current': polls(status('pending'), status('pending'), status('denied')) },
    });
    expect(await screen.findByText('K7Q-4MP')).toBeInTheDocument();
    // Hidden: the next poll is 10 s away, not 20 ms.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(t.requestsTo('GET /api/devices/requests/current')).toHaveLength(1);
    // Visible again: one poll at once (still pending), then the pace resumes and the next answer ends it.
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByRole('heading', { name: 'The request was denied on the main PC' })).toBeInTheDocument();
    const polled = t.requestsTo('GET /api/devices/requests/current').length;
    expect(polled).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.requestsTo('GET /api/devices/requests/current')).toHaveLength(polled);
  });
});

describe('MisroutedPage', () => {
  it('names the remote port the proxy must point at', () => {
    renderWithProviders(<MisroutedPage />);
    expect(screen.getByRole('heading', { name: 'This address reaches Portly the wrong way' })).toBeInTheDocument();
    expect(screen.getByText('5758')).toBeInTheDocument();
  });
});
