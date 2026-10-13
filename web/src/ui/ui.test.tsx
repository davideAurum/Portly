/**
 * The UI-kit patterns wave-2 widgets build on (§10.4, §10.7): error mapping, query states with
 * stale data, safe external links, Undo toasts, hex-only colors and modal dialogs.
 */
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import { isPageBusy } from '../localServer/page.ts';
import { account } from '../test/fixtures.ts';
import { renderWithProviders } from '../test/render.tsx';
import { ColorPicker, normalizeHexInput } from './ColorPicker.tsx';
import { ConfirmDialog, Dialog } from './Dialog.tsx';
import { ErrorState, QueryView, StaleIndicator } from './ErrorState.tsx';
import { ExternalLink } from './ExternalLink.tsx';
import { toastUndo } from './toast.ts';

function query<T>(state: { data?: T; error?: unknown; isPending?: boolean; dataUpdatedAt?: number }, refetch = vi.fn()) {
  return {
    data: state.data,
    error: state.error ?? null,
    isPending: state.isPending ?? state.data === undefined,
    isError: state.error !== undefined,
    dataUpdatedAt: state.dataUpdatedAt ?? 0,
    refetch,
  } as never;
}

describe('ErrorState', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reauth_required names the account and reconnects it through OAuth in the same tab', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hash: '#/', assign } as Location);
    const { requestsTo } = renderWithProviders(
      <ErrorState error={new ApiError(409, 'reauth_required', 'Reconnect', undefined, 'acc-1')} onRetry={() => {}} />,
      {
        apiMocks: {
          'GET /api/accounts': [account({ id: 'acc-1', label: 'Work Gmail', status: 'reauth' })],
          'POST /api/oauth/google/start': { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
        },
      },
    );
    expect(await screen.findByText('Reconnect Work Gmail')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(requestsTo('POST /api/oauth/google/start')[0]!.body).toEqual({ accountId: 'acc-1', returnTo: '#/' });
  });

  it('not_configured links to setup; only in-app routes or http(s) URLs become links', () => {
    const error = new ApiError(409, 'not_configured', 'Add your Todoist token first.');
    const { rerender } = renderWithProviders(<ErrorState error={error} setupHref="#/settings/todoist" />);
    expect(screen.getByText('Add your Todoist token first.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up' })).toHaveAttribute('href', '#/settings/todoist');
    rerender(<ErrorState error={error} setupHref="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('other errors show the server message and Retry; network errors say the server is unreachable', async () => {
    const onRetry = vi.fn();
    const { rerender } = renderWithProviders(<ErrorState error={new ApiError(502, 'provider_error', 'Google is down')} onRetry={onRetry} />);
    expect(screen.getByText('Google is down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<ErrorState error={new ApiError(0, 'network_error', 'x')} onRetry={onRetry} />);
    expect(screen.getByText('Portly is not reachable')).toBeInTheDocument();
  });
});

describe('QueryView', () => {
  it('shows a skeleton first, then ErrorState when there is no data', () => {
    const { rerender } = renderWithProviders(<QueryView query={query({ isPending: true })}>{() => 'content'}</QueryView>);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    rerender(<QueryView query={query({ error: new ApiError(500, 'internal', 'Boom') })}>{() => 'content'}</QueryView>);
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('keeps showing data when a refresh fails and reports it as stale', () => {
    const children = vi.fn((data: string[], meta: { stale: boolean }) => `${data.join(',')} stale=${meta.stale}`);
    const { rerender } = renderWithProviders(<QueryView query={query({ data: ['a'], dataUpdatedAt: 1 })}>{children}</QueryView>);
    expect(screen.getByText('a stale=false')).toBeInTheDocument();
    rerender(<QueryView query={query({ data: ['a'], error: new ApiError(502, 'provider_error', 'x'), dataUpdatedAt: 1 })}>{children}</QueryView>);
    expect(screen.getByText('a stale=true')).toBeInTheDocument();
  });

  it('renders the empty state for empty data', () => {
    renderWithProviders(
      <QueryView<string[]> query={query({ data: [] as string[] })} isEmpty={(d) => d.length === 0} empty={<p>Nothing here</p>}>
        {() => 'content'}
      </QueryView>,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });
});

describe('StaleIndicator', () => {
  it('is silent while fresh and warns with a retry after a failed refresh', async () => {
    const updatedAt = Date.now() - 5 * 60_000;
    const { rerender, container } = renderWithProviders(<StaleIndicator updatedAt={updatedAt} />, { toaster: false });
    expect(container).toBeEmptyDOMElement();
    const onRetry = vi.fn();
    rerender(<StaleIndicator updatedAt={updatedAt} error={new ApiError(502, 'provider_error', 'Upstream failed')} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Updated 5 min. ago');
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed: Upstream failed');
    await userEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('ExternalLink', () => {
  it('renders unsafe URLs as plain text and safe ones as new-tab links', () => {
    renderWithProviders(
      <>
        <ExternalLink href="javascript:alert(1)">Evil</ExternalLink>
        <ExternalLink href="data:text/html,x">Data</ExternalLink>
        <ExternalLink href="https://example.com/a">Good</ExternalLink>
        <ExternalLink href="https://example.com/b" newTab={false}>
          Same tab
        </ExternalLink>
      </>,
      { toaster: false },
    );
    expect(screen.getByText('Evil').closest('a')).toBeNull();
    expect(screen.getByText('Data').closest('a')).toBeNull();
    const good = screen.getByRole('link', { name: /Good/ });
    expect(good).toHaveAttribute('href', 'https://example.com/a');
    expect(good).toHaveAttribute('target', '_blank');
    expect(good).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Same tab' })).not.toHaveAttribute('target');
  });
});

describe('toastUndo', () => {
  it('runs the undo action from the toast', async () => {
    const onUndo = vi.fn();
    renderWithProviders(<button type="button" onClick={() => toastUndo('Task completed.', { onUndo })}>go</button>);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    const toast = (await screen.findByText('Task completed.')).closest('[data-sonner-toast]') as HTMLElement;
    // fireEvent: sonner's focus restoration trips over jsdom's focus events under userEvent.
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });
});

describe('ColorPicker', () => {
  it('normalizes hex input and rejects everything else', () => {
    expect(normalizeHexInput('#ABC')).toBe('#aabbcc');
    expect(normalizeHexInput(' 12ab9F ')).toBe('#12ab9f');
    expect(normalizeHexInput('#11223344')).toBe('#11223344');
    for (const bad of ['red', '#12345', 'url(x)', 'rgb(0,0,0)', '#gggggg', '']) expect(normalizeHexInput(bad)).toBeNull();
  });

  it('emits only valid hex colors', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string | null>('#3b82f6');
      return (
        <ColorPicker
          value={value}
          aria-label="Accent"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    renderWithProviders(<Harness />, { toaster: false });
    const hex = screen.getByRole('textbox', { name: 'Hex color' });
    await userEvent.clear(hex);
    await userEvent.type(hex, 'red; background:url(x){Enter}');
    expect(hex).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(hex);
    await userEvent.type(hex, 'F0A{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('#ff00aa');
    await userEvent.click(screen.getByRole('radio', { name: 'Green' }));
    expect(onChange).toHaveBeenLastCalledWith('#22c55e');
    // Swatches are announced by name, with the hex code as their description (A11Y-1).
    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Red', 'Orange', 'Amber', 'Lime', 'Green', 'Teal', 'Cyan', 'Blue', 'Indigo', 'Violet', 'Fuchsia', 'Slate']);
    expect(screen.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-description', '#22c55e');
  });
});

describe('Dialog', () => {
  it('is announced as modal, so hybrid mode never reloads the page under an open dialog', () => {
    const { unmount } = renderWithProviders(
      <Dialog open onOpenChange={() => {}} title="Edit bookmark">
        <p>Body</p>
      </Dialog>,
      { toaster: false },
    );
    expect(screen.getByRole('dialog', { name: 'Edit bookmark' })).toHaveAttribute('aria-modal', 'true');
    expect(isPageBusy(document)).toBe(true);
    unmount();
    expect(isPageBusy(document)).toBe(false);
  });

  it('marks a confirmation dialog as modal too', () => {
    renderWithProviders(<ConfirmDialog open onOpenChange={() => {}} title="Remove?" onConfirm={() => {}} />, { toaster: false });
    expect(screen.getByRole('dialog', { name: 'Remove?' })).toHaveAttribute('aria-modal', 'true');
    expect(isPageBusy(document)).toBe(true);
  });
});
