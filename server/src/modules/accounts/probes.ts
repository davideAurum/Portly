/**
 * Capability probes (§6): feature modules register a probe per capability for the account kinds
 * they can verify (calendar: CalDAV for yahoo/caldav; mail: IMAP for yahoo/imap). Creating or
 * testing an app-password account runs the probes for its kind in parallel; capabilities are the
 * passing probes plus capabilities no probe is registered for yet (saved as "not verified").
 * Each failure is also diagnosed from the original error (`outcomeFromError`: health code and
 * upstream status), so a connection test can tell a rejected password from other failures.
 */
import {
  ACCOUNT_CONFIG_SCHEMAS,
  ACCOUNT_KINDS,
  CAPABILITIES,
  type AccountDraft,
  type AccountKind,
  type Capability,
  type ProbeResult,
  type ValidationIssue,
} from '@homebase/shared';
import type { AccountProbe } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError } from '../../lib/health.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { orderCapabilities } from './store.ts';

/** Capabilities each app-password kind can offer. */
export const KIND_CAPABILITIES: Readonly<Record<AccountKind, readonly Capability[]>> = Object.freeze({
  google: ['calendar', 'mail'],
  microsoft: ['calendar', 'mail'],
  yahoo: ['calendar', 'mail'],
  caldav: ['calendar'],
  imap: ['mail'],
});

export const NOT_VERIFIED = 'not verified';
export const PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_MESSAGE = 300;

const CAPABILITY_LABEL: Readonly<Record<Capability, string>> = Object.freeze({ calendar: 'Calendar', mail: 'Mail' });

export function capabilityLabel(capability: Capability): string {
  return CAPABILITY_LABEL[capability];
}

export class ProbeRegistry {
  readonly #probes = new Map<string, AccountProbe>();

  /** Registers `probe` for `capability` on `kinds`; a later registration for the same pair replaces it. */
  register(capability: Capability, kinds: readonly AccountKind[], probe: AccountProbe): void {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new TypeError(`Unknown capability "${String(capability)}"`);
    if (typeof probe !== 'function') throw new TypeError('A probe must be a function');
    for (const kind of kinds) {
      if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new TypeError(`Unknown account kind "${String(kind)}"`);
      this.#probes.set(`${capability}:${kind}`, probe);
    }
  }

  get(capability: Capability, kind: AccountKind): AccountProbe | undefined {
    return this.#probes.get(`${capability}:${kind}`);
  }
}

/** What a failed probe's original error says (diagnostics; the API result keeps the HttpError code). */
export interface ProbeDiagnosis {
  /** Health code (`auth_failed` for a CalDAV 401, `timeout`, `dns`, a probe's `details.reason` …). */
  code: string;
  /** Upstream HTTP status, when the error names one. */
  status: number | null;
}

export interface ProbeRun {
  /** Result of every probe that ran. */
  results: Partial<Record<Capability, ProbeResult>>;
  /** Diagnosis of every failed probe. */
  diagnoses: Partial<Record<Capability, ProbeDiagnosis>>;
  passed: Capability[];
  failed: Capability[];
  /** Capabilities of the kind that have no registered probe. */
  unprobed: Capability[];
  /** Draft config with the passing probes' `configPatch`es merged (validated for the kind). */
  config: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Shallow merge; plain-object values merge one level deep (so `{caldav: {principalUrl}}` extends `caldav`). */
export function mergeConfigPatch(config: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
  }
  return out;
}

/**
 * A failed probe as a result. Logged with `errorFields` only (never a raw server text): an
 * HttpError is our own verdict (debug), anything else an unexpected failure (warn).
 */
function failure(err: unknown, log: Logger, capability: Capability, kind: AccountKind): ProbeResult {
  if (err instanceof HttpError) {
    log.debug('account probe failed', { ...errorFields(err), capability, kind });
    return { ok: false, code: err.code, message: err.message.slice(0, MAX_PROBE_MESSAGE) };
  }
  log.warn('account probe failed', { ...errorFields(err), capability, kind });
  return { ok: false, code: 'provider_error', message: `${capabilityLabel(capability)} connection test failed` };
}

/** Health code and upstream status of a probe's error (the API code alone hides e.g. a CalDAV 401). */
function diagnose(err: unknown): ProbeDiagnosis {
  const outcome = outcomeFromError(err);
  return { code: outcome.code ?? 'internal', status: outcome.status ?? null };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, 'upstream_timeout', 'The connection test timed out')), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs the registered probes for `capabilities` (default: every capability of the kind).
 * Probe errors never escape: HttpError messages (authored by our modules) are reported, anything
 * else becomes a generic message.
 */
export async function runProbes(
  registry: ProbeRegistry,
  draft: AccountDraft,
  opts: { log: Logger; timeoutMs?: number; capabilities?: readonly Capability[] },
): Promise<ProbeRun> {
  const capabilities = opts.capabilities ?? KIND_CAPABILITIES[draft.kind];
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const startedAt = Date.now();
  const unprobed: Capability[] = [];
  const running: { capability: Capability; promise: Promise<{ configPatch?: Record<string, unknown> }> }[] = [];

  for (const capability of orderCapabilities(capabilities)) {
    const probe = registry.get(capability, draft.kind);
    if (!probe) {
      unprobed.push(capability);
      continue;
    }
    // Each probe gets its own copy so one probe cannot alter what another sees.
    const copy: AccountDraft = structuredClone(draft);
    running.push({ capability, promise: withTimeout(Promise.resolve().then(() => probe(copy)), timeoutMs) });
  }

  const settled = await Promise.allSettled(running.map((r) => r.promise));
  const results: Partial<Record<Capability, ProbeResult>> = {};
  const diagnoses: Partial<Record<Capability, ProbeDiagnosis>> = {};
  const passed: Capability[] = [];
  const failed: Capability[] = [];
  const schema = ACCOUNT_CONFIG_SCHEMAS[draft.kind];
  let config = draft.config;

  settled.forEach((outcome, i) => {
    const { capability } = running[i] as (typeof running)[number];
    if (outcome.status === 'rejected') {
      results[capability] = failure(outcome.reason, opts.log, capability, draft.kind);
      diagnoses[capability] = diagnose(outcome.reason);
      failed.push(capability);
      return;
    }
    const patch = outcome.value?.configPatch;
    if (patch !== undefined) {
      const merged = isPlainObject(patch) ? mergeConfigPatch(config, patch) : null;
      if (merged === null || !schema.safeParse(merged).success) {
        opts.log.warn('account probe returned an invalid config patch', { capability, kind: draft.kind });
        results[capability] = { ok: false, code: 'internal', message: `${capabilityLabel(capability)} check returned invalid settings` };
        diagnoses[capability] = { code: 'internal', status: null };
        failed.push(capability);
        return;
      }
      config = merged;
    }
    results[capability] = { ok: true };
    passed.push(capability);
  });

  opts.log.debug('account probes finished', { kind: draft.kind, passed, failed, unprobed, ms: Date.now() - startedAt });
  return { results, diagnoses, passed, failed, unprobed, config };
}

/** Per-capability errors as `validation_failed` details (`path` = capability). */
export function probeIssues(results: Partial<Record<Capability, ProbeResult>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const capability of CAPABILITIES) {
    const result = results[capability];
    if (result && !result.ok) issues.push({ path: capability, message: result.message, code: result.code });
  }
  return issues;
}
