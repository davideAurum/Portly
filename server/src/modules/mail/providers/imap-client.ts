/**
 * Real imapflow connections (§8 Generic IMAP): implicit TLS (`security: 'tls'`, `secure: true`)
 * or mandatory STARTTLS (`doSTARTTLS: true`) — never plaintext or opportunistic TLS; certificate
 * verification always on, TLS ≥ 1.2; `logger: false`; 15 s connect/greeting/socket timeouts; no
 * auto-IDLE (connections are short-lived); response size bounds against hostile servers.
 *
 * The bounds are deliberately small: Homebase never fetches bodies (ENVELOPE + FLAGS only), and
 * imapflow's tokenizer cost grows super-linearly with a line's length (e.g. runs of `[`), summed
 * over every line of one response. 64 KiB lines × a 256 KiB response bound one parse to about a
 * second of CPU — on the IMAP worker thread (imap-runner.ts), never on the main thread.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { ImapClientFactory, ImapClientLike, ImapConnectionParams } from './imap-session.ts';

export const IMAP_TIMEOUT_MS = 15_000;
export const IMAP_MAX_LINE_LENGTH = 64 * 1024;
export const IMAP_MAX_LITERAL_SIZE = 64 * 1024;
export const IMAP_MAX_RESPONSE_SIZE = 256 * 1024;

export function imapFlowOptions(params: ImapConnectionParams): ImapFlowOptions {
  const tls = params.security === 'tls';
  return {
    host: params.host,
    port: params.port,
    secure: tls,
    // STARTTLS is required (not opportunistic) for 'starttls'; implicit TLS otherwise.
    doSTARTTLS: tls ? undefined : true,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: params.username, pass: params.password },
    logger: false,
    emitLogs: false,
    logRaw: false,
    disableAutoIdle: true,
    connectionTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    socketTimeout: IMAP_TIMEOUT_MS,
    maxLineLength: IMAP_MAX_LINE_LENGTH,
    maxLiteralSize: IMAP_MAX_LITERAL_SIZE,
    maxResponseSize: IMAP_MAX_RESPONSE_SIZE,
  };
}

export const createImapClient: ImapClientFactory = (params): ImapClientLike => new ImapFlow(imapFlowOptions(params));
