/**
 * Report: "Download diagnostic report" saves the server's report with this browser's section
 * (`redact=0`, or `redact=1` and a redacted browser section when "Hide hosts, emails and names" is
 * ticked — off by default); "Copy summary" copies the plain-text digest (≤ 40 lines, the server's
 * recent warnings included), redacted the same way when ticked.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordClientEvent } from '../clientLog.ts';
import { settings } from '../../test/fixtures.ts';
import { mockError, renderWithProviders, type MockRequest } from '../../test/render.tsx';
import { ReportPanel } from './ReportPanel.tsx';
import { diagnosticsSummary, healthEntry, logRecord, logsResponse } from './testing.ts';

const captured = vi.hoisted(() => ({ files: [] as { blob: Blob; name: string }[], copied: [] as string[], copyOk: true }));

vi.mock('../../lib/download.ts', () => ({
  saveBlob: (blob: Blob, name: string) => {
    captured.files.push({ blob, name });
  },
}));

vi.mock('../../lib/clipboard.ts', () => ({
  copyText: async (text: string) => {
    captured.copied.push(text);
    return captured.copyOk;
  },
}));

afterEach(() => {
  captured.files = [];
  captured.copied = [];
  captured.copyOk = true;
});

const SUMMARY = diagnosticsSummary({
  health: [healthEntry('account:acc-1', { accountId: 'acc-1', label: 'Dana Work', status: 'failing', lastCode: 'invalid_grant', lastMessage: 'Sign-in expired' })],
});
const ACCOUNTS = [{ label: 'Dana Work', email: 'dana@example.com' }];

function mocks(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/settings': settings(),
    'GET /api/diagnostics/report': (req: MockRequest) => ({ generatedAt: '2026-10-11T12:00:00.000Z', redacted: req.search === '?redact=1', summary: { server: { version: '0.0.0-test' } } }),
    'GET /api/diagnostics/logs': logsResponse([logRecord({ level: 'warn', area: 'accounts', msg: 'accounts failing', fields: { code: 'invalid_grant' } })]),
    ...extra,
  };
}

describe('ReportPanel', () => {
  it('downloads the server’s report with this browser’s section, full detail by default', async () => {
    recordClientEvent('warn', 'widget', 'mail summary failed', { accountId: 'acc-1', code: 'reauth_required' });
    const { requestsTo } = renderWithProviders(<ReportPanel summary={SUMMARY} accounts={ACCOUNTS} />, { apiMocks: mocks() });
    expect(screen.getByRole('checkbox', { name: 'Hide hosts, emails and names (for sharing publicly)' })).not.toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download diagnostic report' }));
    expect(await screen.findByText('Saved homebase-diagnostics.json.')).toBeInTheDocument();
    expect(requestsTo('GET /api/diagnostics/report')[0]!.search).toBe('?redact=0');
    const report = JSON.parse(await captured.files[0]!.blob.text());
    expect(report.redacted).toBe(false);
    expect(report.browser).toMatchObject({ build: 'server', backend: 'server', version: '0.0.0-test', hybrid: null, pagesOrigin: null });
    expect(report.browser.events.map((e: { msg: string }) => e.msg)).toContain('mail summary failed');
  });

  it('asks for the redacted report and redacts the browser section when the box is ticked', async () => {
    recordClientEvent('error', 'app', 'uncaught error', { errName: 'TypeError', errMessage: 'failed for dana@example.com' });
    const { requestsTo } = renderWithProviders(<ReportPanel summary={SUMMARY} accounts={ACCOUNTS} />, { apiMocks: mocks() });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Hide hosts, emails and names (for sharing publicly)' }));
    await user.click(screen.getByRole('button', { name: 'Download diagnostic report' }));
    await waitFor(() => expect(captured.files).toHaveLength(1));
    expect(requestsTo('GET /api/diagnostics/report')[0]!.search).toBe('?redact=1');
    const text = await captured.files[0]!.blob.text();
    expect(text).not.toContain('dana@example.com');
    expect(text).toContain('email#b1');
  });

  it('tells when the report could not be downloaded', async () => {
    renderWithProviders(<ReportPanel summary={SUMMARY} accounts={ACCOUNTS} />, { apiMocks: mocks({ 'GET /api/diagnostics/report': mockError(403, 'local_only', 'Only on Homebase itself') }) });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download diagnostic report' }));
    expect(await screen.findByText('Only on Homebase itself')).toBeInTheDocument();
    expect(captured.files).toHaveLength(0);
  });

  it('copies the summary with the server’s recent warnings, redacted when ticked', async () => {
    const { requestsTo } = renderWithProviders(<ReportPanel summary={SUMMARY} accounts={ACCOUNTS} />, { apiMocks: mocks() });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    expect(await screen.findByText('Summary copied.')).toBeInTheDocument();
    const full = captured.copied[0]!;
    expect(full.split('\n').length).toBeLessThanOrEqual(40);
    expect(full).toMatch(/^Homebase diagnostics, /);
    expect(full).toContain('- failing account:acc-1 (Dana Work): invalid_grant — Sign-in expired');
    expect(full).toContain('- 1× warn [accounts] accounts failing (invalid_grant)');
    expect(new URLSearchParams(requestsTo('GET /api/diagnostics/logs')[0]!.search).get('level')).toBe('warn');

    await user.click(screen.getByRole('checkbox', { name: 'Hide hosts, emails and names (for sharing publicly)' }));
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(captured.copied).toHaveLength(2));
    expect(captured.copied[1]).not.toContain('Dana Work');
    expect(captured.copied[1]).toContain('label#1');
  });

  it('hides a mail server named only in a message when the box is ticked', async () => {
    recordClientEvent('error', 'api', 'request failed', { method: 'POST', status: 502, code: 'dns', errMessage: 'The mail server mail.hollis-home.net could not be found' });
    const summary = diagnosticsSummary({
      health: [healthEntry('mail:a1b2', { label: 'Family mail', status: 'failing', lastCode: 'dns', lastMessage: 'The mail server mail.hollis-home.net could not be found' })],
    });
    renderWithProviders(<ReportPanel summary={summary} accounts={[]} />, { apiMocks: mocks() });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Hide hosts, emails and names (for sharing publicly)' }));
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(captured.copied).toHaveLength(1));
    expect(captured.copied[0]).toContain('- failing mail:a1b2 (label#1): dns — The mail server host#1 could not be found');
    expect(captured.copied[0]).not.toContain('hollis');
    await user.click(screen.getByRole('button', { name: 'Download diagnostic report' }));
    await waitFor(() => expect(captured.files).toHaveLength(1));
    expect(await captured.files[0]!.blob.text()).not.toContain('hollis');
  });

  it('copies the summary without the server part when there is none, and says when copying failed', async () => {
    captured.copyOk = false;
    const { requestsTo } = renderWithProviders(<ReportPanel summary={null} summaryProblem="Update Homebase on this PC to see its diagnostics" accounts={[]} />, { apiMocks: mocks() });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy summary' }));
    expect(await screen.findByText('Copy failed — your browser did not allow it.')).toBeInTheDocument();
    expect(captured.copied[0]).toContain('Server: Update Homebase on this PC to see its diagnostics');
    expect(requestsTo('GET /api/diagnostics/logs')).toHaveLength(0);
  });
});
