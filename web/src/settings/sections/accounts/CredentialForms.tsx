/**
 * Credential forms for the accounts that sign in with a password (§7 Accounts, §8): Yahoo (an app
 * password), a CalDAV calendar server and an IMAP mailbox. Each is validated before it is sent;
 * the server checks every service on its own (a probe per capability) and the results are shown
 * per service, whether the account was added or refused. Passwords are write-only.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import {
  CAPABILITIES,
  CaldavAccountCreateSchema,
  ImapAccountCreateSchema,
  YahooAccountCreateSchema,
  YAHOO_PRESET,
  type AccountCreateResult,
  type Capability,
  type ProbeResult,
} from '@portly/shared';
import type { z } from 'zod';
import { isApiError } from '../../../api/client.ts';
import { useCreateAccount, type AccountCreateKind, type AccountCreatePayloads } from '../../../api/accounts.ts';
import { ACCOUNT_KIND_LABELS, CAPABILITY_LABELS } from '../../../ui/accounts/accountKinds.ts';
import { Banner } from '../../../ui/Banner.tsx';
import { Button } from '../../../ui/Button.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field } from '../../../ui/Field.tsx';
import { Input, PasswordInput } from '../../../ui/Input.tsx';
import { FieldGrid, FormFooter } from '../../../ui/Section.tsx';
import { errorMessage, toast } from '../../../ui/toast.ts';
import { Checkbox, SegmentedControl } from '../../../ui/Toggles.tsx';
import styles from '../../../styles/settings.module.css';

// ---------------------------------------------------------------------------
// Probe results
// ---------------------------------------------------------------------------

/** One line per capability: ✓ OK or ✗ message. */
export function ProbeResults({ results }: { results: Partial<Record<Capability, ProbeResult>> }) {
  const entries = CAPABILITIES.filter((c) => results[c] !== undefined).map((c) => [c, results[c]!] as const);
  if (entries.length === 0) return null;
  return (
    <ul className={styles.probeList}>
      {entries.map(([capability, result]) => (
        <li key={capability} className={styles.probe} data-ok={result.ok ? 'true' : 'false'}>
          {result.ok ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}
          <span>
            <strong>{CAPABILITY_LABELS[capability]}:</strong> {result.ok ? 'working' : result.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** `checked: false` when no probe ran (nothing can be tested for this account yet). */
export function summarizeProbes(results: Partial<Record<Capability, ProbeResult>>): { checked: boolean; ok: boolean; text: string } {
  const entries = CAPABILITIES.filter((c) => results[c] !== undefined).map((c) => [c, results[c]!] as const);
  if (entries.length === 0) return { checked: false, ok: false, text: 'No checks are available for this account yet.' };
  const ok = entries.every(([, r]) => r.ok);
  const text = entries.map(([c, r]) => `${CAPABILITY_LABELS[c]}: ${r.ok ? 'OK' : r.message}`).join(' · ');
  return { checked: true, ok, text };
}

type FieldErrors = Record<string, string>;

/** Maps zod issues to the first message per top-level field. */
function zodFieldErrors(error: z.ZodError, messages: Record<string, string> = {}): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = messages[key] ?? issue.message;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Per-capability probe failures from a 422 `details`: the server's `ValidationIssue[]` with one
 * issue per failed capability (`{path: 'calendar', message, code}`), or an object
 * (`{probes: {...}}` / `{calendar, mail}`) of ProbeResults.
 */
export function probeResultsFromDetails(details: unknown): Partial<Record<Capability, ProbeResult>> | null {
  if (Array.isArray(details)) {
    const out: Partial<Record<Capability, ProbeResult>> = {};
    for (const issue of details) {
      if (!isRecord(issue) || typeof issue.message !== 'string') continue;
      const path = Array.isArray(issue.path) ? issue.path[0] : issue.path;
      if (!isCapability(path)) continue;
      out[path] = { ok: false, code: typeof issue.code === 'string' ? (issue.code as never) : 'provider_error', message: issue.message };
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (!isRecord(details)) return null;
  const source = isRecord(details.probes) ? details.probes : isRecord(details.results) ? details.results : details;
  const out: Partial<Record<Capability, ProbeResult>> = {};
  for (const capability of CAPABILITIES) {
    const raw = source[capability];
    if (!isRecord(raw)) continue;
    if (raw.ok === true) out[capability] = { ok: true };
    else if (typeof raw.message === 'string') {
      out[capability] = { ok: false, code: typeof raw.code === 'string' ? (raw.code as never) : 'provider_error', message: raw.message };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Field errors from a 422 `details` (an array of `{path, message}` issues, or `{issues: [...]}`). */
export function fieldErrorsFromDetails(details: unknown): FieldErrors {
  const issues = Array.isArray(details) ? details : isRecord(details) && Array.isArray(details.issues) ? details.issues : [];
  const out: FieldErrors = {};
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.message !== 'string') continue;
    const path = Array.isArray(issue.path) ? issue.path[0] : typeof issue.path === 'string' ? issue.path.split('.')[0] : undefined;
    // Capability paths are probe results, shown separately.
    if (typeof path === 'string' && path && !isCapability(path) && !(path in out)) out[path] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared submit flow
// ---------------------------------------------------------------------------

interface FailureState {
  fieldErrors: FieldErrors;
  probes: Partial<Record<Capability, ProbeResult>> | null;
  message: string | null;
}

const NO_FAILURE: FailureState = { fieldErrors: {}, probes: null, message: null };

/** Validate → POST → hand the created account on, or show per-capability/field errors. */
function useAccountForm(kind: AccountCreateKind, onCreated: (result: AccountCreateResult) => void) {
  const create = useCreateAccount(kind);
  const [state, setState] = useState<FailureState>(NO_FAILURE);

  const submit = async (body: AccountCreatePayloads[AccountCreateKind]) => {
    setState(NO_FAILURE);
    try {
      const result = await create.mutateAsync(body);
      const failed = CAPABILITIES.some((c) => result.probes[c]?.ok === false);
      const name = result.account?.label ?? ACCOUNT_KIND_LABELS[kind];
      if (failed) toast.warning(`${name} was added, but not everything is working.`);
      else toast.success(`${name} was added.`);
      onCreated(result);
    } catch (error) {
      if (isApiError(error)) {
        setState({
          fieldErrors: fieldErrorsFromDetails(error.details),
          probes: probeResultsFromDetails(error.details),
          message: error.message || 'The account could not be added.',
        });
      } else {
        setState({ ...NO_FAILURE, message: errorMessage(error, 'The account could not be added.') });
      }
    }
  };

  return { state, setState, submit, pending: create.isPending };
}

function FormFailure({ state }: { state: FailureState }) {
  if (!state.message && !state.probes) return null;
  return (
    <Banner tone="danger" title={state.message ?? 'The account could not be added.'}>
      {state.probes ? <ProbeResults results={state.probes} /> : null}
    </Banner>
  );
}

/** What an added account's checks found, per service. */
export function CreatedResult({ result, note }: { result: AccountCreateResult; note?: string }) {
  const failed = CAPABILITIES.some((c) => result.probes[c]?.ok === false);
  return (
    <Banner tone={failed ? 'warning' : 'success'} title={failed ? 'Added with problems' : 'Account added'}>
      <ProbeResults results={result.probes} />
      {note ? <p>{note}</p> : null}
    </Banner>
  );
}

export interface CredentialFormProps {
  onCreated(result: AccountCreateResult): void;
  /** Extra buttons before the submit button (e.g. Back). */
  extraActions?: ReactNode;
}

// ---------------------------------------------------------------------------
// Yahoo
// ---------------------------------------------------------------------------

export function YahooForm({ onCreated, extraActions }: CredentialFormProps) {
  const form = useAccountForm('yahoo', onCreated);
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const errors = form.state.fieldErrors;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = YahooAccountCreateSchema.safeParse({ email: email.trim(), appPassword });
    if (!parsed.success) {
      form.setState({
        ...NO_FAILURE,
        fieldErrors: zodFieldErrors(parsed.error, { email: 'Enter your Yahoo email address.', appPassword: 'Enter the app password.' }),
      });
      return;
    }
    void form.submit(parsed.data);
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add a Yahoo account">
      <p className={styles.intro}>
        Yahoo needs an <strong>app password</strong>, not your normal password. Create one under{' '}
        <ExternalLink href="https://login.yahoo.com/account/security" showIcon>
          Yahoo Account Security
        </ExternalLink>{' '}
        → Generate app password. Portly checks calendar (CalDAV, read-only) and mail (IMAP) separately. The password is encrypted on
        this PC and never shown again.
      </p>
      <FieldGrid>
        <Field label="Yahoo email" error={errors.email} required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="App password" error={errors.appPassword} required>
          <PasswordInput value={appPassword} onChange={(event) => setAppPassword(event.currentTarget.value)} />
        </Field>
      </FieldGrid>
      <FormFailure state={form.state} />
      <FormFooter>
        {extraActions}
        <Button type="submit" variant="primary" loading={form.pending}>
          Add Yahoo account
        </Button>
      </FormFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// CalDAV
// ---------------------------------------------------------------------------

export function CaldavForm({ onCreated, extraActions }: CredentialFormProps) {
  const form = useAccountForm('caldav', onCreated);
  const [label, setLabel] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [insecureLan, setInsecureLan] = useState(false);
  const errors = form.state.fieldErrors;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CaldavAccountCreateSchema.safeParse({ label: label.trim(), serverUrl: serverUrl.trim(), username: username.trim(), password, insecureLan });
    const fieldErrors = parsed.success
      ? {}
      : zodFieldErrors(parsed.error, {
          label: 'Give the account a name.',
          serverUrl: 'Enter the server address, e.g. https://dav.example.com.',
          username: 'Enter the user name.',
          password: 'Enter the password.',
        });
    if (parsed.success && parsed.data.serverUrl.toLowerCase().startsWith('http:') && !parsed.data.insecureLan) {
      fieldErrors.serverUrl = 'Use https, or allow http for a server on your local network.';
    }
    if (!parsed.success || Object.keys(fieldErrors).length > 0) {
      form.setState({ ...NO_FAILURE, fieldErrors });
      return;
    }
    void form.submit(parsed.data);
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add a CalDAV account">
      <p className={styles.intro}>
        Calendars from Nextcloud, Fastmail, iCloud (app-specific password) and other CalDAV servers. Read-only in this version. The
        password is encrypted on this PC and never shown again.
      </p>
      <FieldGrid>
        <Field label="Name" error={errors.label} required>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder="Family calendar" maxLength={120} />
        </Field>
        <Field label="Server URL" error={errors.serverUrl} required>
          <Input
            type="url"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.currentTarget.value)}
            placeholder="https://dav.example.com"
            spellCheck={false}
            autoCapitalize="off"
          />
        </Field>
        <Field label="User name" error={errors.username} required>
          <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Password" error={errors.password} required>
          <PasswordInput value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
        </Field>
      </FieldGrid>
      <Checkbox
        checked={insecureLan}
        onCheckedChange={setInsecureLan}
        label="Allow http for a server on my local network"
        description="Only for servers at a private address (e.g. a NAS at home). Certificates are always verified for https."
      />
      <FormFailure state={form.state} />
      <FormFooter>
        {extraActions}
        <Button type="submit" variant="primary" loading={form.pending}>
          Add CalDAV account
        </Button>
      </FormFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

export function ImapForm({ onCreated, extraActions }: CredentialFormProps) {
  const form = useAccountForm('imap', onCreated);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [security, setSecurity] = useState<'tls' | 'starttls'>('tls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [webmailUrl, setWebmailUrl] = useState('');
  const errors = form.state.fieldErrors;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const portNumber = Number(port);
    const parsed = ImapAccountCreateSchema.safeParse({
      label: label.trim(),
      host: host.trim(),
      port: Number.isInteger(portNumber) ? portNumber : Number.NaN,
      security,
      username: username.trim(),
      password,
      ...(webmailUrl.trim() ? { webmailUrl: webmailUrl.trim() } : {}),
    });
    if (!parsed.success) {
      form.setState({
        ...NO_FAILURE,
        fieldErrors: zodFieldErrors(parsed.error, {
          label: 'Give the account a name.',
          host: 'Enter the IMAP server host name, e.g. imap.example.com.',
          port: 'Enter a port between 1 and 65535.',
          username: 'Enter the user name.',
          password: 'Enter the password.',
          webmailUrl: 'Enter an http(s) address, or leave it empty.',
        }),
      });
      return;
    }
    void form.submit(parsed.data);
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add an IMAP account">
      <p className={styles.intro}>
        Unread counts and recent messages from any IMAP mailbox. Connections are always encrypted. The password is encrypted on this PC
        and never shown again.
      </p>
      <FieldGrid>
        <Field label="Name" error={errors.label} required>
          <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder="Work mail" maxLength={120} />
        </Field>
        <Field label="IMAP server" error={errors.host} required>
          <Input value={host} onChange={(event) => setHost(event.currentTarget.value)} placeholder="imap.example.com" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Encryption">
          <SegmentedControl
            value={security}
            onValueChange={(next) => {
              setSecurity(next);
              if (next === 'tls' && port === '143') setPort('993');
              if (next === 'starttls' && port === '993') setPort('143');
            }}
            options={[
              { value: 'tls', label: 'TLS (993)' },
              { value: 'starttls', label: 'STARTTLS (143)' },
            ]}
          />
        </Field>
        <Field label="Port" error={errors.port} required>
          <Input inputMode="numeric" value={port} onChange={(event) => setPort(event.currentTarget.value.replace(/[^0-9]/g, ''))} maxLength={5} />
        </Field>
        <Field label="User name" error={errors.username} required>
          <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Password" error={errors.password} required>
          <PasswordInput value={password} onChange={(event) => setPassword(event.currentTarget.value)} />
        </Field>
      </FieldGrid>
      <Field label="Webmail address" help={`Optional. "Open in webmail" links go here, e.g. ${YAHOO_PRESET.webmailUrl}`} error={errors.webmailUrl}>
        <Input type="url" value={webmailUrl} onChange={(event) => setWebmailUrl(event.currentTarget.value)} placeholder="https://mail.example.com/" spellCheck={false} />
      </Field>
      <FormFailure state={form.state} />
      <FormFooter>
        {extraActions}
        <Button type="submit" variant="primary" loading={form.pending}>
          Add IMAP account
        </Button>
      </FormFooter>
    </form>
  );
}
