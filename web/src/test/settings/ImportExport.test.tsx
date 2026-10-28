import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreviewResponse } from '@portly/shared';
import { expectNewIcons } from '../../api/bookmarks.ts';
import { capabilitiesFor, setCapabilitiesForTests } from '../../capabilities.ts';
import ImportExportSettings from '../../settings/sections/ImportExport.tsx';
import { mockError, mockResponse, renderWithProviders, type ApiMock } from '../render.tsx';

vi.mock('../../api/bookmarks.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/bookmarks.ts')>()),
  expectNewIcons: vi.fn(),
}));

const PREVIEW: ImportPreviewResponse = {
  previewId: 'prev-123',
  summary: {
    exportedAt: '2026-09-20T08:30:00.000Z',
    counts: { profiles: 2, widgets: 11, bookmarkGroups: 3, bookmarks: 42, uploads: 1, customIcons: 4 },
    searchEngines: [
      { name: 'DuckDuckGo', host: 'duckduckgo.com' },
      { name: 'Sketchy', host: 'search.evil.example' },
    ],
    dropped: { unknownWidgets: 2, notes: ["2 widgets of unknown type 'stocks'"] },
  },
};

function exportFile(name = 'portly-export-2026-09-20.json', content = '{"format":"portly-export"}') {
  return new File([content], name, { type: 'application/json' });
}

function renderImportExport(mocks: Record<string, ApiMock> = {}) {
  const result = renderWithProviders(<ImportExportSettings />, {
    apiMocks: { 'POST /api/import/preview': PREVIEW, 'POST /api/import/commit': mockResponse(204), ...mocks },
  });
  return { ...result, user: userEvent.setup() };
}

function fileInput(): HTMLInputElement {
  // Labelled for assistive tech, but not a second tab stop next to the "Choose" button.
  const input = screen.getByLabelText<HTMLInputElement>('Portly export file');
  expect(input).toHaveAttribute('type', 'file');
  expect(input).toHaveAttribute('tabindex', '-1');
  return input;
}

describe('Import & export', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uploads the file for a preview, shows the summary, and commits only after confirmation', async () => {
    const { user, requestsTo, queryClient } = renderImportExport();
    queryClient.setQueryData(['settings'], { stale: true });
    await user.upload(fileInput(), exportFile());

    await waitFor(() => expect(requestsTo('POST /api/import/preview')).toHaveLength(1));
    const body = requestsTo('POST /api/import/preview')[0]!.body;
    expect(body).toBeInstanceOf(FormData);
    expect(((body as FormData).get('file') as File).name).toBe('portly-export-2026-09-20.json');

    const preview = await screen.findByRole('region', { name: 'Import preview' });
    const counts = within(preview).getAllByRole('definition').map((d) => d.textContent);
    expect(counts).toEqual(['2', '11', '3', '42', '1', '4']);
    // Search engines are listed with their hosts so hijacked templates are visible.
    expect(within(preview).getByText('search.evil.example')).toBeInTheDocument();
    expect(within(preview).getByText("2 widgets of unknown type 'stocks'")).toBeInTheDocument();
    expect(requestsTo('POST /api/import/commit')).toHaveLength(0);

    await user.click(within(preview).getByRole('button', { name: 'Import…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replace your configuration?' });
    await user.click(within(confirm).getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(requestsTo('POST /api/import/commit')).toHaveLength(1));
    expect(requestsTo('POST /api/import/commit')[0]!.body).toEqual({ previewId: 'prev-123' });
    expect(await screen.findByText('Import complete.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Import preview' })).not.toBeInTheDocument();
    expect(queryClient.getQueryState(['settings'])?.isInvalidated).toBe(true);
    // Bookmark icons the server fetches after the import appear without a reload (FUNC-1).
    expect(expectNewIcons).toHaveBeenCalledWith(queryClient);
  });

  it('cancelling the confirmation or the preview commits nothing', async () => {
    const { user, requestsTo } = renderImportExport();
    await user.upload(fileInput(), exportFile());
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    await user.click(within(preview).getByRole('button', { name: 'Import…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await user.click(within(preview).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Import preview' })).not.toBeInTheDocument();
    expect(requestsTo('POST /api/import/commit')).toHaveLength(0);
  });

  it('rejects files that are not exports or too large before uploading', async () => {
    const { requestsTo } = renderImportExport();
    // Bypass the picker's accept filter, as drag-and-drop or 'All files' would.
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(fileInput(), new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByText('Choose a Portly export file (.json).')).toBeInTheDocument();
    const huge = exportFile();
    Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 });
    await user.upload(fileInput(), huge);
    expect(await screen.findByText('Export files must be 25 MB or smaller.')).toBeInTheDocument();
    expect(requestsTo('POST /api/import/preview')).toHaveLength(0);
  });

  it('shows the server validation error for an invalid export', async () => {
    const { user } = renderImportExport({ 'POST /api/import/preview': mockError(422, 'validation_failed', 'This is not a Portly export (version 7).') });
    await user.upload(fileInput(), exportFile());
    expect(await screen.findByText('This is not a Portly export (version 7).')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Import preview' })).not.toBeInTheDocument();
  });

  it('keeps the preview when the commit fails', async () => {
    const { user } = renderImportExport({ 'POST /api/import/commit': mockError(409, 'conflict', 'Preview expired') });
    await user.upload(fileInput(), exportFile());
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    await user.click(within(preview).getByRole('button', { name: 'Import…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Preview expired')).toBeInTheDocument();
    // The confirmation stays open for a retry; the preview is kept behind it.
    expect(screen.getByRole('dialog', { name: 'Replace your configuration?' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import preview', hidden: true })).toBeInTheDocument();
  });

  it('downloads the export as a JSON file', async () => {
    // jsdom has no object URLs; install stand-ins for this test only.
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock');
    const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const { user, requestsTo } = renderImportExport({ 'GET /api/export': { format: 'portly-export', version: 1 } });
      await user.click(screen.getByRole('button', { name: 'Download export' }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(requestsTo('GET /api/export')[0]!.headers.get('X-Portly')).toBe('1');
      const blob = createObjectURL.mock.calls[0]![0];
      expect(JSON.parse(await blob.text())).toEqual({ format: 'portly-export', version: 1 });
      expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toMatch(/^portly-export-\d{4}-\d{2}-\d{2}\.json$/);
    } finally {
      URL.createObjectURL = saved.create;
      URL.revokeObjectURL = saved.revoke;
    }
  });

  it('on the browser backend: warns that an import replaces the synced launch pad, and offers the backup taken before a sync', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const { user } = renderImportExport({
      'GET /api/backups': [
        { id: 'b-sync', at: '2026-10-26T09:00:00.000Z', bytes: 100, reason: 'sync' },
        { id: 'b-import', at: '2026-10-20T09:00:00.000Z', bytes: 100, reason: 'import' },
      ],
      'GET /api/sync/launchpad': {
        connection: { kind: 'github' },
        connections: 1,
        status: 'up_to_date',
        problem: null,
        running: false,
        waiting: false,
        syncedAt: null,
        receivedAt: null,
        sentAt: null,
        retryAt: null,
      },
    });
    expect(await screen.findByText('Backup before sync')).toBeInTheDocument();
    expect(screen.getByText('Backup before the last import')).toBeInTheDocument();
    await user.upload(fileInput(), exportFile());
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    expect(within(preview).getByText('This replaces the launch pad in every synced browser')).toBeInTheDocument();
    expect(within(preview).getByText(/Launch pad sync is on through your GitHub repository/)).toBeInTheDocument();
  });

  it('does not warn about sync where the launch pad does not sync', async () => {
    const { user, requestsTo } = renderImportExport();
    await user.upload(fileInput(), exportFile());
    await screen.findByRole('region', { name: 'Import preview' });
    expect(screen.queryByText('This replaces the launch pad in every synced browser')).not.toBeInTheDocument();
    expect(requestsTo('GET /api/sync/launchpad')).toHaveLength(0);
  });
});
