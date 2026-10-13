/**
 * Pages-build copy on the in-browser backend (`setCapabilitiesForTests(capabilitiesFor(true,
 * 'browser'))`): About describes browser storage instead of a data folder, log file and vault;
 * Import & export promises the in-browser backup and no longer mentions accounts; the
 * empty-profile hint and the Add-widget example name only widgets this page load has. On the
 * Portly server (hybrid mode) the same page load reads like the server's own page: no in-browser
 * backup, server-made backups, every widget.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreviewResponse } from '@portly/shared';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { AddWidgetDialog } from '../grid/AddWidgetDialog.tsx';
import { Grid } from '../grid/Grid.tsx';
import { saveBlob } from '../lib/download.ts';
import AboutSettings from '../settings/sections/About.tsx';
import ImportExportSettings from '../settings/sections/ImportExport.tsx';
import { renderWithProviders } from './render.tsx';

vi.mock('../lib/download.ts', () => ({ saveBlob: vi.fn() }));

const PREVIEW: ImportPreviewResponse = {
  previewId: 'prev-1',
  summary: {
    exportedAt: '2026-09-20T08:30:00.000Z',
    counts: { profiles: 1, widgets: 2, bookmarkGroups: 0, bookmarks: 0, uploads: 0, customIcons: 0 },
    searchEngines: [],
    dropped: { unknownWidgets: 0, notes: [] },
  },
};

describe('static build copy', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'browser')));

  it('About describes browser storage and drops the log file and vault rows', async () => {
    renderWithProviders(<AboutSettings />, {
      apiMocks: { 'GET /api/about': { version: '0.0.0-test', dataDir: 'This browser (IndexedDB)', logPath: 'Browser console', vault: 'ready' } },
    });
    expect(await screen.findByText('Storage')).toBeInTheDocument();
    expect(screen.getByText('Your personal start page, stored in this browser.')).toBeInTheDocument();
    expect(screen.getByText('0.0.0-test')).toBeInTheDocument();
    // The backend's storage kind is unknown under the server-build test define, so the about text is shown.
    expect(screen.getByText('This browser (IndexedDB)')).toBeInTheDocument();
    expect(screen.queryByText('Data folder')).not.toBeInTheDocument();
    expect(screen.queryByText('Log file')).not.toBeInTheDocument();
    expect(screen.queryByText('Credential vault')).not.toBeInTheDocument();
    expect(screen.queryByText('Unlocked and ready')).not.toBeInTheDocument();
    expect(screen.queryByText(/reload/)).not.toBeInTheDocument();
  });

  it('Import & export promises the in-browser backup and does not mention accounts', async () => {
    renderWithProviders(<ImportExportSettings />, { apiMocks: { 'POST /api/import/preview': PREVIEW } });
    expect(screen.getByText(/a backup is kept in this browser\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/a backup is made first/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Portly export file'), new File(['{}'], 'portly-export.json', { type: 'application/json' }));
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    await user.click(within(preview).getByRole('button', { name: 'Import…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replace your configuration?' });
    expect(confirm).toHaveTextContent('A backup of the current data is kept in this browser.');
    expect(confirm).not.toHaveTextContent('Accounts are not affected');
    // No import yet, no backup to offer.
    expect(screen.queryByText('Backup before the last import')).not.toBeInTheDocument();
  });

  it('offers the backup taken before the last import for download', async () => {
    const backup = { id: 'b1', at: '2026-09-20T12:00:00.000Z', bytes: 1234 };
    const { requestsTo } = renderWithProviders(<ImportExportSettings />, {
      apiMocks: { 'GET /api/backups': [backup, { ...backup, id: 'b0', at: '2026-09-01T12:00:00.000Z' }], 'GET /api/backups/b1': { format: 'portly-export' } },
    });
    expect(await screen.findByText('Backup before the last import')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download backup' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveBlob).mock.calls[0]?.[1]).toBe('portly-backup-2026-09-20.json');
    expect(requestsTo('GET /api/backups/b1')).toHaveLength(1);
    expect(await screen.findByText('Backup downloaded.')).toBeInTheDocument();
  });

  it('names only available widgets in the empty-profile hint and the Add-widget example', async () => {
    renderWithProviders(<Grid layout={{ version: 1, items: [] }} profileId="p1" />);
    expect(screen.getByText('Add a search box, bookmarks, your calendar, weather and more.')).toBeInTheDocument();

    renderWithProviders(<AddWidgetDialog open onOpenChange={() => {}} onAdd={async () => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Add a widget' });
    // The calendar is offered (Outlook.com from the browser), mail and feeds are not.
    expect(dialog).toHaveTextContent('Widgets can be added more than once — for example two calendars with different views.');
    // Buttons are named by their whole content (title, description, hidden "Add <title>").
    expect(within(dialog).getByRole('button', { name: /Add Calendar/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Add Mail/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Add RSS feeds/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Add Clock/ })).toBeInTheDocument();
  });
});

describe('Pages build copy on the Portly server on this PC', () => {
  beforeEach(() => setCapabilitiesForTests(capabilitiesFor(true, 'server')));

  it('Import & export: the server backs up, accounts are left alone, and there is no in-browser backup card', async () => {
    const { requestsTo } = renderWithProviders(<ImportExportSettings />, { apiMocks: { 'POST /api/import/preview': PREVIEW } });
    expect(screen.getByText(/a backup is made first\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/kept in this browser/)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Portly export file'), new File(['{}'], 'portly-export.json', { type: 'application/json' }));
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    await user.click(within(preview).getByRole('button', { name: 'Import…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replace your configuration?' });
    expect(confirm).toHaveTextContent('Portly saves a backup of the current data first. Accounts are not affected.');
    // The in-browser backups are never asked for (the server mode transport answers them 404 anyway).
    expect(screen.queryByText('Backup before the last import')).not.toBeInTheDocument();
    expect(requestsTo('GET /api/backups')).toHaveLength(0);
  });

  it('names calendar and mail in the empty-profile hint and the Add-widget example, and offers them', async () => {
    renderWithProviders(<Grid layout={{ version: 1, items: [] }} profileId="p1" />);
    expect(screen.getByText('Add a search box, bookmarks, your calendar, mail and more.')).toBeInTheDocument();

    renderWithProviders(<AddWidgetDialog open onOpenChange={() => {}} onAdd={async () => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Add a widget' });
    expect(dialog).toHaveTextContent('Widgets can be added more than once — for example two calendars with different views.');
    for (const name of [/Add Calendar/, /Add Mail/, /Add RSS feeds/]) expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
  });
});
