/**
 * The diagnostic report: this browser's section (build, version, user agent, hybrid state,
 * events), the sharing dictionary built from what this page knows, the browser section's
 * redaction with placeholders apart from the server's (`host#b1`), and the download: the server's
 * report (redact=0|1) plus the browser section, saved under the server's file name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactForSharing } from '@homebase/shared';
import { capabilitiesFor } from '../../capabilities.ts';
import type { LocalServerState } from '../../localServer/types.ts';
import { getClientEvents, recordClientEvent } from '../clientLog.ts';
import { browserReportSection, hostsInText, redactBrowserSection, saveDiagnosticReport, sharingDictionary, type BrowserReportSection } from './report.ts';
import { diagnosticsSummary, healthEntry } from './testing.ts';

const saved = vi.hoisted(() => ({ files: [] as { blob: Blob; name: string }[] }));

vi.mock('../../lib/download.ts', () => ({
  saveBlob: (blob: Blob, name: string) => {
    saved.files.push({ blob, name });
  },
}));

afterEach(() => {
  saved.files = [];
});

const LOCAL: LocalServerState = {
  backend: 'server',
  status: 'connected',
  server: { version: '0.1.0', instanceId: 'instance-1', appUrl: 'http://127.0.0.1:5757/', apiVersion: 1, vault: 'ready' },
  paired: true,
  checkedAt: Date.parse('2026-10-11T12:00:00.000Z'),
  pendingSwitch: null,
  permission: 'granted',
  manual: false,
};

function section(): BrowserReportSection {
  recordClientEvent('warn', 'provider', 'provider request failed', { provider: 'todoist', host: 'api.todoist.com', status: 502 });
  recordClientEvent('error', 'app', 'uncaught error', { errName: 'TypeError', errMessage: 'failed for dana@example.com at https://dana.github.io/x' });
  return browserReportSection({
    caps: capabilitiesFor(true, 'server'),
    version: '0.0.0-test',
    origin: 'https://dana.github.io',
    userAgent: 'Mozilla/5.0 Test',
    session: 'session-1',
    localServer: LOCAL,
    events: getClientEvents(),
  });
}

describe('browserReportSection', () => {
  it('describes this page, the hybrid state (never the instance id or page URL) and every event', () => {
    const s = section();
    expect(s).toMatchObject({
      build: 'pages',
      version: '0.0.0-test',
      backend: 'server',
      pagesOrigin: 'https://dana.github.io',
      userAgent: 'Mozilla/5.0 Test',
      session: 'session-1',
      hybrid: { status: 'connected', permission: 'granted', paired: true, checkedAt: '2026-10-11T12:00:00.000Z', pendingSwitch: null, server: { version: '0.1.0', apiVersion: 1, vault: 'ready' } },
    });
    expect(JSON.stringify(s)).not.toContain('instance-1');
    expect(s.events.map((e) => [e.cat, e.level, e.uploaded])).toEqual([
      ['provider', 'warn', false],
      ['app', 'error', false],
    ]);
  });

  it('has no hybrid part and no site origin in the server build', () => {
    const s = browserReportSection({ caps: capabilitiesFor(false, 'server'), version: 'v', origin: 'http://127.0.0.1:5757', userAgent: 'UA', session: 's', localServer: null, events: [] });
    expect(s.hybrid).toBeNull();
    expect(s.pagesOrigin).toBeNull();
  });
});

describe('sharing', () => {
  it('builds the dictionary from accounts, health labels and details, the Pages origin and foreign origins', () => {
    const summary = diagnosticsSummary({
      hybrid: { pagesOrigin: 'https://dana.github.io', pairings: 1, lastPairedRequestAt: null, foreignOrigins: [{ origin: 'https://evil.example', firstAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T10:00:00.000Z', count: 1 }], foreignOriginRequests: 0 },
      health: [
        healthEntry('account:acc-1', { label: 'Dana Work' }),
        healthEntry('calendar:cal-1', { label: 'Soccer Club' }),
        healthEntry('feed:abc', { label: 'blog.example.org' }),
        healthEntry('ics:cal-2', { label: 'Holidays', detail: { host: 'cal.example.net', finalHost: 'cdn.example.net' } }),
      ],
    });
    const dict = sharingDictionary({ summary, accounts: [{ label: 'Dana Work', email: 'dana@example.com' }], pagesOrigin: 'https://dana.github.io' });
    expect([...(dict.hosts as Set<string>)].sort()).toEqual(['blog.example.org', 'cal.example.net', 'cdn.example.net', 'dana.github.io', 'evil.example']);
    expect([...(dict.labels as Set<string>)]).toEqual(['Dana Work']);
    expect([...(dict.names as Set<string>)].sort()).toEqual(['Holidays', 'Soccer Club', 'dana', 'evil']);
    expect([...(dict.emails as Set<string>)]).toEqual(['dana@example.com']);
  });

  it('finds the hosts a message names only in its text (a custom IMAP server), not file names or script words', () => {
    expect(hostsInText('The mail server mail.hollis-home.net could not be found')).toEqual(['mail.hollis-home.net']);
    expect(hostsInText('A secure connection to IMAP.Contoso-Legal.com failed (TLS).')).toEqual(['imap.contoso-legal.com']);
    expect(hostsInText('Could not read server.log or settings.json; Node.js 24.1.0, e.g. v1.2.3')).toEqual([]);
    // Emails and URLs are redactForSharing's own patterns; paths name no host.
    expect(hostsInText('dana@example.com at https://x.example.org/feed.xml, C:\\logs\\a.b.org')).toEqual([]);
  });

  it('hides a host named only in a health message or a server error this browser kept (Copy summary and browser section)', () => {
    recordClientEvent('error', 'api', 'request failed', { method: 'POST', route: '/api/mail/:id/actions', status: 502, code: 'dns', errMessage: 'The mail server mail.hollis-home.net could not be found' });
    recordClientEvent('error', 'app', 'uncaught error', { errName: 'TypeError', errMessage: "Cannot read properties of null (reading 'event.target.value')" });
    const summary = diagnosticsSummary({
      health: [healthEntry('mail:a1b2', { label: 'Family mail', status: 'failing', lastCode: 'dns', lastMessage: 'Could not connect to the mail server imap.hollis-home.net' })],
    });
    const dict = sharingDictionary({ summary, accounts: [], pagesOrigin: null, events: getClientEvents() });
    expect([...(dict.hosts as Set<string>)].sort()).toEqual(['imap.hollis-home.net', 'mail.hollis-home.net']);
    const summaryText = String(redactForSharing('- failing mail:a1b2 (Family mail): dns — Could not connect to the mail server imap.hollis-home.net', dict));
    expect(summaryText).toBe('- failing mail:a1b2 (label#1): dns — Could not connect to the mail server host#1');
    const s = browserReportSection({ caps: capabilitiesFor(false, 'server'), version: 'v', origin: 'http://127.0.0.1:5757', userAgent: 'UA', session: 's', localServer: null, events: getClientEvents() });
    const redacted = JSON.stringify(redactBrowserSection(s, dict));
    expect(redacted).not.toContain('hollis');
    expect(redacted).toContain('The mail server host#b');
    // A script error keeps its words.
    expect(redacted).toContain('event.target.value');
  });

  it('redacts the browser section with placeholders of its own (host#b1), never the server’s numbering', () => {
    const s = section();
    const redacted = JSON.stringify(redactBrowserSection(s, sharingDictionary({ summary: null, accounts: [], pagesOrigin: s.pagesOrigin })));
    expect(redacted).not.toContain('dana');
    expect(redacted).toContain('host#b');
    expect(redacted).toContain('email#b1');
    expect(redacted).not.toMatch(/(host|email|name|label)#\d/);
  });
});

describe('saveDiagnosticReport', () => {
  function stubReport(body: string, disposition = 'attachment; filename="homebase-diagnostics-20261011-1432.json"') {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': disposition } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('adds the browser section to the server’s report and saves it under the server’s file name', async () => {
    const fetchMock = stubReport(JSON.stringify({ generatedAt: 'x', summary: { server: {} } }));
    const browser = section();
    expect(await saveDiagnosticReport({ redact: false, browser, dict: {} })).toBe('homebase-diagnostics-20261011-1432.json');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/diagnostics/report?redact=0');
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0]!.name).toBe('homebase-diagnostics-20261011-1432.json');
    const report = JSON.parse(await saved.files[0]!.blob.text());
    expect(report.generatedAt).toBe('x');
    expect(report.browser).toEqual(JSON.parse(JSON.stringify(browser)));
  });

  it('asks the server for its redacted report and redacts the browser section here', async () => {
    const fetchMock = stubReport(JSON.stringify({ generatedAt: 'x', summary: { hybrid: { pagesOrigin: 'https://host#1' } } }));
    const browser = section();
    await saveDiagnosticReport({ redact: true, browser, dict: sharingDictionary({ summary: null, accounts: [], pagesOrigin: browser.pagesOrigin }) });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/diagnostics/report?redact=1');
    const text = await saved.files[0]!.blob.text();
    expect(text).not.toContain('dana');
    expect(JSON.parse(text).summary.hybrid.pagesOrigin).toBe('https://host#1');
    expect(JSON.parse(text).browser.pagesOrigin).toBe('https://host#b1');
  });

  it('saves a report that is not a JSON object as it came', async () => {
    stubReport('not json', 'attachment');
    await saveDiagnosticReport({ redact: false, browser: section(), dict: {} });
    expect(saved.files[0]!.name).toBe('homebase-diagnostics.json');
    expect(await saved.files[0]!.blob.text()).toBe('not json');
  });
});
