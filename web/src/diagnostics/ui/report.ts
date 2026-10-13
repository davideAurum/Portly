/**
 * The diagnostic report download and the sharing dictionary (Settings → Diagnostics, Report;
 * ARCHITECTURE §17). The server builds the report (`GET /api/diagnostics/report`, already redacted
 * when `redact=1`); this page adds a `browser` section — build, version, user agent, the hybrid
 * state and this browser's events — and saves the result as the file the server named.
 *
 * Redaction ("Hide hosts, emails and names"): the server redacts its part with what it knows (host
 * name, Windows user name, IMAP/CalDAV hosts, …). The browser section is redacted here with the
 * same `redactForSharing` and the names this page knows; its placeholders are renamed `host#b1`,
 * `email#b1`, … so that they never read as the server's `host#1` (each part numbers its own).
 */
import { redactForSharing, type ClientEvent, type DiagnosticsSummary, type RedactionDictionary } from '@homebase/shared';
import { downloadReport } from '../../api/diagnostics.ts';
import type { Capabilities } from '../../capabilities.ts';
import { saveBlob } from '../../lib/download.ts';
import type { LocalServerState } from '../../localServer/types.ts';
import type { ClientLogEntry } from '../clientLog.ts';
import { escapeUnsafeJson } from './format.ts';

export interface BrowserReportSection {
  build: 'server' | 'pages';
  version: string;
  backend: 'server' | 'browser';
  /** This site's origin (the Pages build; the server build's page is Homebase on this PC). */
  pagesOrigin: string | null;
  userAgent: string;
  session: string;
  /** The Pages build's local server state (null in the server build). */
  hybrid: {
    status: string;
    permission: string | null;
    paired: boolean;
    checkedAt: string | null;
    pendingSwitch: { target: string; reason: string } | null;
    server: { version: string; apiVersion: number | null; vault: string } | null;
  } | null;
  events: (ClientEvent & { uploaded: boolean })[];
}

export interface BrowserSectionInput {
  caps: Pick<Capabilities, 'pagesBuild' | 'backend'>;
  version: string;
  origin: string;
  userAgent: string;
  session: string;
  localServer: LocalServerState | null;
  events: readonly ClientLogEntry[];
}

export function browserReportSection(input: BrowserSectionInput): BrowserReportSection {
  const state = input.localServer;
  return {
    build: input.caps.pagesBuild ? 'pages' : 'server',
    version: input.version,
    backend: input.caps.backend,
    pagesOrigin: input.caps.pagesBuild ? input.origin : null,
    userAgent: input.userAgent.slice(0, 300),
    session: input.session,
    hybrid:
      state === null || state.status === 'disabled'
        ? null
        : {
            status: state.status,
            permission: state.permission,
            paired: state.paired,
            checkedAt: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
            pendingSwitch: state.pendingSwitch === null ? null : { target: state.pendingSwitch.target, reason: state.pendingSwitch.reason },
            server: state.server === null ? null : { version: state.server.version, apiVersion: state.server.apiVersion, vault: state.server.vault },
          },
    events: input.events.map((entry) => ({ ...entry.event, uploaded: entry.uploaded })),
  };
}

function hostOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A bare DNS name in free text: two or more labels and a top label of letters, not inside a longer
 * word, an email, a path or another name.
 */
const BARE_HOST = /(?<![\p{L}\p{N}_.@/\\-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\p{L}\p{N}_@-])/giu;
/** Endings that make a dotted word a file name (`server.log`) or a product (`Node.js`), not a host. */
const FILE_ENDINGS: ReadonlySet<string> = new Set(
  'log json js mjs cjs ts tsx jsx txt md html htm css xml exe dll cmd bat sqlite db zip gz yml yaml ini cfg conf lock map pem key crt cer pfx tmp bak png jpg jpeg gif svg ico webp ics csv pdf sh py'.split(' '),
);

/**
 * The hosts a message names in its text: the server writes some only there ("The mail server
 * mail.example.net could not be found" — a custom IMAP server this page knows nothing else about).
 */
export function hostsInText(text: string): string[] {
  if (!text.includes('.')) return [];
  const hosts: string[] = [];
  for (const match of text.matchAll(BARE_HOST)) {
    const host = match[0].toLowerCase();
    if (!FILE_ENDINGS.has(host.slice(host.lastIndexOf('.') + 1))) hosts.push(host);
  }
  return hosts;
}

export interface DictionarySources {
  summary: DiagnosticsSummary | null;
  accounts: readonly { label: string; email: string | null }[];
  /** This site's origin (the Pages build). */
  pagesOrigin: string | null;
  /** This browser's events (the hosts the server's error messages in them name). */
  events?: readonly ClientLogEntry[];
}

/**
 * What "Hide hosts, emails and names" replaces besides the patterns `redactForSharing` finds by
 * itself: account labels and emails, calendar names (health labels of calendars), the hosts of
 * feeds, ICS calendars and search suggestions (their labels), every host in health details, the
 * hosts named in the text of health messages and of the server's error messages this browser kept
 * (a custom IMAP server's name is only there), the Pages origin (and its first DNS label: often
 * the GitHub user name) and the foreign origins.
 */
export function sharingDictionary({ summary, accounts, pagesOrigin, events = [] }: DictionarySources): RedactionDictionary {
  const hosts = new Set<string>();
  const labels = new Set<string>();
  const names = new Set<string>();
  const emails = new Set<string>();
  const addHost = (value: string | null | undefined) => {
    const host = hostOf(value);
    if (host !== null) hosts.add(host);
  };
  const addPagesOrigin = (value: string | null | undefined) => {
    const host = hostOf(value);
    if (host === null) return;
    hosts.add(host);
    const first = host.split('.')[0] ?? '';
    if (host.includes('.') && !/^\d+$/.test(first)) names.add(first);
  };
  for (const account of accounts) {
    labels.add(account.label);
    if (account.email !== null) emails.add(account.email);
  }
  addPagesOrigin(pagesOrigin);
  if (summary !== null) {
    addPagesOrigin(summary.hybrid.pagesOrigin);
    for (const foreign of summary.hybrid.foreignOrigins) addPagesOrigin(foreign.origin);
    for (const entry of summary.health) {
      const label = entry.label;
      if (label !== null) {
        if (/^(?:account|mail|calendar-list):/.test(entry.key)) labels.add(label);
        else if (/^(?:calendar|ics):/.test(entry.key)) names.add(label);
        else if (/^(?:feed|suggest):/.test(entry.key)) addHost(label);
      }
      for (const key of ['host', 'finalHost', 'blockedHost']) {
        const value = entry.detail?.[key];
        if (typeof value === 'string') addHost(value);
      }
      for (const host of hostsInText(entry.lastMessage ?? '')) hosts.add(host);
    }
  }
  // The server's error messages this browser kept (5xx answers); not script errors, whose dotted
  // words are code (`event.target.value`).
  for (const { event } of events) {
    const message = event.cat === 'api' ? event.fields.errMessage : undefined;
    if (typeof message === 'string') for (const host of hostsInText(message)) hosts.add(host);
  }
  return { hosts, labels, names, emails };
}

const PLACEHOLDER = /\b(host|email|label|name|ip)#(\d+)\b/g;

function renamePlaceholders(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, '$1#b$2');
  if (Array.isArray(value)) return value.map(renamePlaceholders);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[renamePlaceholders(key) as string] = renamePlaceholders(item);
  return out;
}

/** The browser section redacted for sharing, its placeholders numbered apart from the server's (`host#b1`). */
export function redactBrowserSection(section: BrowserReportSection, dict: RedactionDictionary): unknown {
  return renamePlaceholders(redactForSharing(section, dict));
}

/**
 * Downloads the server's report, adds the browser section (redacted when `redact`) and saves it.
 * A report that is not a JSON object (it always is) is saved as it came.
 */
export async function saveDiagnosticReport(options: { redact: boolean; browser: BrowserReportSection; dict: RedactionDictionary }): Promise<string> {
  const file = await downloadReport({ redact: options.redact });
  let report: unknown;
  try {
    report = JSON.parse(await file.blob.text());
  } catch {
    saveBlob(file.blob, file.filename);
    return file.filename;
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    saveBlob(file.blob, file.filename);
    return file.filename;
  }
  const browser = options.redact ? redactBrowserSection(options.browser, options.dict) : options.browser;
  const combined = { ...(report as Record<string, unknown>), browser };
  saveBlob(new Blob([escapeUnsafeJson(JSON.stringify(combined, null, 2))], { type: 'application/json' }), file.filename);
  return file.filename;
}
