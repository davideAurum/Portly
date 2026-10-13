/**
 * Accounts (§4.6, §4.7, §7 Accounts, §8): connected accounts (status, rename, color, enabled
 * capabilities, test, reconnect, remove), OAuth client setup for Google and Microsoft with the
 * exact redirect URI to register, forms for Yahoo / CalDAV / IMAP with per-capability results,
 * and the vault-locked banner with "Reset credentials". Secrets are write-only.
 *
 * The same on Portly's own page and on the Pages site paired with it: there is one page, with or
 * without the server. The Pages site on its in-browser backend shows Outlook.com alone: its sign-in
 * runs in the browser (a single-page-application registration); everything else needs the server
 * (`capabilities.ts`).
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  CircleCheck,
  CircleX,
  FlaskConical,
  KeyRound,
  LogIn,
  Pencil,
  Plug,
  RotateCcw,
  Trash,
  UserRoundPlus,
} from 'lucide-react';
import {
  CAPABILITIES,
  CaldavAccountCreateSchema,
  ImapAccountCreateSchema,
  OAuthClientUpdateSchema,
  YahooAccountCreateSchema,
  YAHOO_PRESET,
  type Account,
  type AccountCreateResult,
  type Capability,
  type OAuthProvider,
  type ProbeResult,
} from '@portly/shared';
import type { z } from 'zod';
import { isApiError } from '../../api/client.ts';
import {
  useAccounts,
  useCreateAccount,
  useDeleteAccount,
  useOAuthClient,
  useSaveOAuthClient,
  useStartOAuth,
  useTestAccount,
  useUpdateAccount,
  type AccountCreateKind,
  type AccountCreatePayloads,
} from '../../api/accounts.ts';
import { useHealth } from '../../api/about.ts';
import { getCapabilities } from '../../capabilities.ts';
import { useCalendars } from '../../api/calendar.ts';
import { useResetVault } from '../../api/vault.ts';
import { accountColor } from '../../ui/accounts/AccountBadge.tsx';
import { ACCOUNT_KIND_LABELS, CAPABILITY_ICONS, CAPABILITY_LABELS, reconnectsWithOAuth } from '../../ui/accounts/accountKinds.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { ColorPickerPopover } from '../../ui/ColorPicker.tsx';
import { CopyField } from '../../ui/CopyField.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, PasswordInput } from '../../ui/Input.tsx';
import { FieldGrid, FormFooter, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs.tsx';
import { errorMessage, toast, toastError } from '../../ui/toast.ts';
import { Checkbox, SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import styles from '../../styles/settings.module.css';

export default function AccountsSettings() {
  const health = useHealth();
  const locked = health.data?.vault === 'locked';
  return (
    <div className={styles.stack}>
      {locked ? <VaultLockedBanner /> : null}
      <ConnectedAccounts />
      {getCapabilities().googleAccounts ? (
        <SettingsCard
          title="Google and Outlook.com"
          description="Calendar and mail through the providers' official APIs. Each provider needs a one-time app registration that only you control."
        >
          <div className={styles.providerGrid}>
            <OAuthProviderSetup provider="google" />
            <OAuthProviderSetup provider="microsoft" />
          </div>
        </SettingsCard>
      ) : (
        <OAuthProviderSetup provider="microsoft" description={STATIC_OUTLOOK_DESCRIPTION} />
      )}
      {getCapabilities().appPasswordAccounts ? <OtherAccounts /> : null}
    </div>
  );
}

/** The Outlook.com card on the in-browser backend: where the sign-in lives and how long it lasts. */
export const STATIC_OUTLOOK_DESCRIPTION =
  "Your Outlook.com calendar through Microsoft's official API, signed in from this browser. It needs a one-time app registration that only you control. The sign-in is kept in this browser (not encrypted) and lasts 24 hours; Portly renews it by itself when you open the page while you are still signed in to Microsoft.";

function OtherAccounts() {
  return (
    <SettingsCard
      title="Other accounts"
      description="Yahoo, any CalDAV calendar server (read-only for now) or any IMAP mailbox. Passwords are encrypted on this PC and never shown again."
    >
      <Tabs defaultValue="yahoo">
        <TabsList aria-label="Account type">
          <TabsTrigger value="yahoo">Yahoo</TabsTrigger>
          <TabsTrigger value="caldav">CalDAV calendar</TabsTrigger>
          <TabsTrigger value="imap">IMAP mail</TabsTrigger>
        </TabsList>
        <TabsContent value="yahoo">
          <YahooForm />
        </TabsContent>
        <TabsContent value="caldav">
          <CaldavForm />
        </TabsContent>
        <TabsContent value="imap">
          <ImapForm />
        </TabsContent>
      </Tabs>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function VaultLockedBanner() {
  const reset = useResetVault();
  const [confirming, setConfirming] = useState(false);
  const icsCount = (useCalendars().data ?? []).filter((c) => c.source === 'ics').length;
  const icsNote =
    icsCount === 0
      ? ''
      : ` The addresses of your ${icsCount === 1 ? 'ICS calendar subscription are' : `${icsCount} ICS calendar subscriptions are`} deleted too and must be entered again in Settings → Calendars.`;
  return (
    <>
      <Banner
        tone="danger"
        icon={KeyRound}
        title="Saved credentials can't be unlocked"
        actions={
          <Button variant="danger" size="sm" icon={RotateCcw} onClick={() => setConfirming(true)}>
            Reset credentials
          </Button>
        }
      >
        Portly could not read its encryption key (for example after restoring the data folder on another PC or Windows
        account). Accounts, Todoist and ICS calendar subscriptions are paused. Resetting deletes every stored password, token and
        subscription address and creates a new key; you then reconnect your accounts and re-enter your ICS feed addresses.
      </Banner>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset all stored credentials?"
        description={`Every saved password, token and OAuth client secret is deleted and a new encryption key is created. Your accounts stay listed but need to be reconnected.${icsNote} This cannot be undone.`}
        confirmLabel="Reset credentials"
        destructive
        onConfirm={async () => {
          try {
            await reset.mutateAsync();
            toast.success('Credentials were reset. Reconnect your accounts to resume syncing.');
          } catch (error) {
            toastError(error, 'The credentials could not be reset.');
            throw error;
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

function ConnectedAccounts() {
  const accounts = useAccounts();
  const list = [...(accounts.data ?? [])].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  return (
    <SettingsCard title="Connected accounts">
      {accounts.data === undefined ? (
        accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : (
          <SkeletonList rows={2} />
        )
      ) : list.length === 0 ? (
        <EmptyState
          icon={UserRoundPlus}
          title="No accounts yet"
          body={
            getCapabilities().googleAccounts
              ? 'Connect Google, Outlook.com, Yahoo, a CalDAV server or an IMAP mailbox below to see your calendars and mail.'
              : 'Connect Outlook.com below to see your calendars.'
          }
        />
      ) : (
        <ul className={styles.list} aria-label="Connected accounts">
          {list.map((account) => (
            <li key={account.id}>
              <AccountRow account={account} />
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function StatusBadge({ account }: { account: Account }) {
  if (account.status === 'reauth') return <Badge tone="warning">Reconnect needed</Badge>;
  if (account.status === 'error') return <Badge tone="danger">Error</Badge>;
  if (account.statusMessage) return <Badge tone="neutral">{account.statusMessage}</Badge>;
  return (
    <Badge tone="success" dot>
      Connected
    </Badge>
  );
}

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

function AccountRow({ account }: { account: Account }) {
  const locked = useHealth().data?.vault === 'locked';
  const update = useUpdateAccount();
  const remove = useDeleteAccount();
  const test = useTestAccount();
  const start = useStartOAuth();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const saveLabel = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      setLabelError('Use 1–100 characters.');
      return;
    }
    setLabelError(null);
    setRenaming(false);
    if (trimmed !== account.label) update.mutate({ id: account.id, label: trimmed });
  };

  const runTest = async () => {
    try {
      const { results } = await test.mutateAsync(account.id);
      const summary = summarizeProbes(results);
      if (!summary.checked) toast.info(`There is nothing to test for ${account.label} yet.`);
      else if (summary.ok) toast.success(`${account.label} is working.`, { description: summary.text });
      else toast.error(`${account.label} has a problem.`, { description: summary.text });
    } catch (error) {
      toastError(error, 'The test could not run.');
    }
  };

  const toggleCapability = (capability: Capability, on: boolean) => {
    const next = on
      ? [...new Set([...account.enabledCapabilities, capability])]
      : account.enabledCapabilities.filter((c) => c !== capability);
    update.mutate({ id: account.id, enabledCapabilities: CAPABILITIES.filter((c) => next.includes(c)) });
  };

  return (
    <div className={styles.accountRow}>
      <ColorPickerPopover
        label={`${account.label} color`}
        value={accountColor(account)}
        onChange={(color) => update.mutate({ id: account.id, color })}
      />
      <div className={styles.accountMain}>
        {renaming ? (
          <form className={styles.inlineRow} onSubmit={saveLabel} aria-label={`Rename ${account.label}`}>
            <Field label="Account name" hideLabel error={labelError}>
              <Input
                size="sm"
                value={label}
                autoFocus
                maxLength={120}
                onChange={(event) => setLabel(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenaming(false);
                    setLabel(account.label);
                    setLabelError(null);
                  }
                }}
              />
            </Field>
            <Button size="sm" type="submit" variant="primary">
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setLabel(account.label);
                setLabelError(null);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className={styles.accountName}>
            <span>{account.label}</span>
            <IconButton
              icon={Pencil}
              size="sm"
              aria-label={`Rename ${account.label}`}
              onClick={() => {
                setLabel(account.label);
                setRenaming(true);
              }}
            />
            <StatusBadge account={account} />
          </div>
        )}
        <span className={styles.itemMeta}>
          {ACCOUNT_KIND_LABELS[account.kind]}
          {account.email ? ` · ${account.email}` : ''}
        </span>
        {account.status !== 'ok' && account.statusMessage ? <span className={styles.itemMeta}>{account.statusMessage}</span> : null}
        {account.status === 'reauth' && !reconnectsWithOAuth(account.kind) ? (
          <span className={styles.itemMeta}>
            To reconnect, add this account again below with its current password.
          </span>
        ) : null}
        {account.capabilities.length > 0 ? (
          <div className={styles.accountCaps}>
            {account.capabilities.map((capability) => {
              const Icon = CAPABILITY_ICONS[capability];
              return (
                <span key={capability} className={styles.capability}>
                  <Icon aria-hidden="true" width={15} height={15} />
                  <Switch
                    size="sm"
                    label={CAPABILITY_LABELS[capability]}
                    checked={account.enabledCapabilities.includes(capability)}
                    onCheckedChange={(on) => toggleCapability(capability, on)}
                  />
                </span>
              );
            })}
          </div>
        ) : (
          <span className={styles.itemMeta}>No calendar or mail access was granted.</span>
        )}
      </div>
      <div className={styles.itemActions}>
        {reconnectsWithOAuth(account.kind) ? (
          <Button
            size="sm"
            variant={account.status === 'reauth' ? 'primary' : 'ghost'}
            icon={LogIn}
            loading={start.isPending}
            disabled={locked}
            onClick={() => start.mutate({ provider: account.kind as OAuthProvider, accountId: account.id, returnTo: '#/settings/accounts' })}
          >
            Reconnect
          </Button>
        ) : null}
        <IconButton icon={FlaskConical} size="sm" aria-label={`Test ${account.label}`} loading={test.isPending} onClick={() => void runTest()} />
        <IconButton icon={Trash} size="sm" aria-label={`Remove ${account.label}`} onClick={() => setConfirmRemove(true)} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${account.label}?`}
        description={
          account.kind === 'google'
            ? 'Portly deletes its stored tokens, calendars and cached events for this account and asks Google to revoke access.'
            : 'Portly deletes its stored credentials, calendars and cached events for this account. Nothing is deleted at the provider.'
        }
        confirmLabel="Remove account"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(account.id);
          toast.success(`${account.label} removed.`);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth client setup
// ---------------------------------------------------------------------------

interface ProviderInfo {
  title: string;
  console: { href: string; label: string };
  guide: string;
  needsSecret: boolean;
  /** Same plausibility check the server applies (catches copy/paste mistakes before saving). */
  clientIdPattern: RegExp;
  clientIdHint: string;
  steps: ReactNode[];
}

const PROVIDER_INFO: Record<OAuthProvider, ProviderInfo> = {
  google: {
    title: 'Google',
    console: { href: 'https://console.cloud.google.com/apis/credentials', label: 'Google Cloud Console' },
    guide: 'docs/setup/google.md',
    needsSecret: true,
    clientIdPattern: /^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/,
    clientIdHint: 'Google client IDs end with .apps.googleusercontent.com.',
    steps: [
      <>
        Create an OAuth client of type <strong>Web application</strong>.
      </>,
      <>Add the redirect URI below as an authorized redirect URI.</>,
      <>
        Set the OAuth consent screen to <strong>In production</strong> (in “Testing”, Google expires sign-ins after 7 days).
      </>,
      <>Paste the client ID and client secret here.</>,
    ],
  },
  microsoft: {
    title: 'Outlook.com',
    console: { href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', label: 'Microsoft Entra admin center' },
    guide: 'docs/setup/microsoft.md',
    needsSecret: false,
    clientIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    clientIdHint: 'The Application (client) ID looks like 00000000-0000-0000-0000-000000000000.',
    steps: [
      <>
        Register an app for <strong>Personal Microsoft accounts only</strong>.
      </>,
      <MicrosoftPlatformStep key="platform" />,
      <>Paste the Application (client) ID here. No secret is needed.</>,
    ],
  },
};

/** The redirect platform to register: the browser signs in itself on the in-browser backend (a single-page app). */
function MicrosoftPlatformStep() {
  const platform = getCapabilities().backend === 'browser' ? 'Single-page application' : 'Mobile and desktop applications';
  return (
    <>
      Add the platform <strong>{platform}</strong> with the redirect URI below.
    </>
  );
}

function OAuthProviderSetup({ provider, description }: { provider: OAuthProvider; description?: string }) {
  const info = PROVIDER_INFO[provider];
  const client = useOAuthClient(provider);
  const save = useSaveOAuthClient(provider);
  const start = useStartOAuth();
  // While the vault is locked the server refuses to start a sign-in (the tokens could not be stored).
  const locked = useHealth().data?.vault === 'locked';
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});

  if (client.data === undefined) {
    return (
      <SettingsCard title={info.title} description={description}>
        {client.isError ? <ErrorState error={client.error} onRetry={() => void client.refetch()} compact /> : <SkeletonList rows={2} avatar={false} />}
      </SettingsCard>
    );
  }

  const data = client.data;
  const configured = data.clientId !== null && (!info.needsSecret || data.hasSecret);
  const idValue = clientId ?? data.clientId ?? '';
  const dirty = (clientId !== null && clientId.trim() !== (data.clientId ?? '')) || clientSecret !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = { clientId: idValue.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
    const parsed = OAuthClientUpdateSchema.safeParse(body);
    const next: typeof errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === 'clientId') next.clientId = 'Enter the client ID (up to 512 characters).';
        if (key === 'clientSecret') next.clientSecret = 'The client secret is too long.';
      }
    }
    if (!next.clientId && body.clientId && !info.clientIdPattern.test(body.clientId)) next.clientId = info.clientIdHint;
    // The stored secret belongs to the stored client ID: a new ID needs its own secret.
    const keepsSecret = data.hasSecret && body.clientId === data.clientId;
    if (info.needsSecret && !keepsSecret && !body.clientSecret) {
      next.clientSecret = data.hasSecret ? 'Enter the client secret that belongs to the new client ID.' : 'Google requires the client secret.';
    }
    setErrors(next);
    if (!parsed.success || Object.keys(next).length > 0) return;
    try {
      await save.mutateAsync(parsed.data);
      setClientId(null);
      setClientSecret('');
      toast.success(`${info.title} app registration saved.`);
    } catch (error) {
      // The server's 422 names the field ({path: 'clientId' | 'clientSecret', message}).
      const fields = isApiError(error) ? fieldErrorsFromDetails(error.details) : {};
      const serverErrors: typeof errors = {};
      if (fields.clientId) serverErrors.clientId = fields.clientId;
      if (fields.clientSecret) serverErrors.clientSecret = fields.clientSecret;
      if (Object.keys(serverErrors).length > 0) setErrors(serverErrors);
      else toastError(error, 'The app registration could not be saved.');
    }
  };

  return (
    <SettingsCard
      title={info.title}
      description={description}
      actions={
        configured && locked ? (
          <Badge tone="warning">Credentials locked</Badge>
        ) : configured ? (
          <Badge tone="success" dot>
            Ready
          </Badge>
        ) : (
          <Badge tone="warning">Setup needed</Badge>
        )
      }
    >
      <ol className={styles.steps}>
        <li>
          Open the <ExternalLink href={info.console.href} showIcon>{info.console.label}</ExternalLink>.
        </li>
        {info.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <Field label="Redirect URI" help={`Must match exactly. Step-by-step guide: ${info.guide} in the Portly folder.`}>
        <CopyField value={data.redirectUri} label="Redirect URI" />
      </Field>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} noValidate aria-label={`${info.title} app registration`}>
        <Field label={provider === 'google' ? 'Client ID' : 'Application (client) ID'} error={errors.clientId} required>
          <Input
            value={idValue}
            onChange={(event) => setClientId(event.currentTarget.value)}
            spellCheck={false}
            autoComplete="off"
            maxLength={600}
          />
        </Field>
        {info.needsSecret ? (
          <Field
            label="Client secret"
            error={errors.clientSecret}
            help={
              data.hasSecret && idValue.trim() === data.clientId
                ? 'A secret is saved. Leave empty to keep it.'
                : 'Stored encrypted; never shown again.'
            }
            required={!data.hasSecret || idValue.trim() !== data.clientId}
          >
            <PasswordInput
              value={clientSecret}
              onChange={(event) => setClientSecret(event.currentTarget.value)}
              placeholder={data.hasSecret ? '••••••••••••' : ''}
              maxLength={1100}
            />
          </Field>
        ) : null}
        <FormFooter>
          <Button type="submit" disabled={!dirty} loading={save.isPending}>
            Save
          </Button>
          <Button
            variant="primary"
            icon={Plug}
            disabled={!configured || dirty || locked}
            loading={start.isPending}
            onClick={() => start.mutate({ provider, returnTo: '#/settings/accounts' })}
          >
            Connect {info.title}
          </Button>
        </FormFooter>
      </form>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// App-password / server account forms
// ---------------------------------------------------------------------------

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

interface CreateState {
  fieldErrors: FieldErrors;
  probes: Partial<Record<Capability, ProbeResult>> | null;
  message: string | null;
  created: AccountCreateResult | null;
}

const EMPTY_STATE: CreateState = { fieldErrors: {}, probes: null, message: null, created: null };

/** Shared submit flow: validate → POST → show created result or per-capability/field errors. */
function useAccountForm(kind: AccountCreateKind) {
  const create = useCreateAccount(kind);
  const [state, setState] = useState<CreateState>(EMPTY_STATE);

  const submit = async (body: AccountCreatePayloads[AccountCreateKind], onCreated: () => void) => {
    setState(EMPTY_STATE);
    try {
      const result = await create.mutateAsync(body);
      setState({ ...EMPTY_STATE, created: result });
      const failed = CAPABILITIES.some((c) => result.probes[c]?.ok === false);
      const name = result.account?.label ?? ACCOUNT_KIND_LABELS[kind];
      if (failed) toast.warning(`${name} was added, but not everything is working.`);
      else toast.success(`${name} was added.`);
      onCreated();
    } catch (error) {
      if (isApiError(error)) {
        setState({
          ...EMPTY_STATE,
          fieldErrors: fieldErrorsFromDetails(error.details),
          probes: probeResultsFromDetails(error.details),
          message: error.message || 'The account could not be added.',
        });
      } else {
        setState({ ...EMPTY_STATE, message: errorMessage(error, 'The account could not be added.') });
      }
    }
  };

  return { state, setState, submit, pending: create.isPending };
}

function FormResult({ state }: { state: CreateState }) {
  if (state.created) {
    const failed = CAPABILITIES.some((c) => state.created!.probes[c]?.ok === false);
    return (
      <Banner tone={failed ? 'warning' : 'success'} title={failed ? 'Added with problems' : 'Account added'}>
        <ProbeResults results={state.created.probes} />
      </Banner>
    );
  }
  if (state.message || state.probes) {
    return (
      <Banner tone="danger" title={state.message ?? 'The account could not be added.'}>
        {state.probes ? <ProbeResults results={state.probes} /> : null}
      </Banner>
    );
  }
  return null;
}

function YahooForm() {
  const form = useAccountForm('yahoo');
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const errors = form.state.fieldErrors;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = YahooAccountCreateSchema.safeParse({ email: email.trim(), appPassword });
    if (!parsed.success) {
      form.setState({
        ...EMPTY_STATE,
        fieldErrors: zodFieldErrors(parsed.error, { email: 'Enter your Yahoo email address.', appPassword: 'Enter the app password.' }),
      });
      return;
    }
    void form.submit(parsed.data, () => {
      setEmail('');
      setAppPassword('');
    });
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add a Yahoo account">
      <p className={styles.intro}>
        Yahoo needs an <strong>app password</strong>, not your normal password. Create one under{' '}
        <ExternalLink href="https://login.yahoo.com/account/security" showIcon>
          Yahoo Account Security
        </ExternalLink>{' '}
        → Generate app password. Portly checks calendar (CalDAV, read-only) and mail (IMAP) separately.
      </p>
      <FieldGrid>
        <Field label="Yahoo email" error={errors.email} required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="App password" error={errors.appPassword} required>
          <PasswordInput value={appPassword} onChange={(event) => setAppPassword(event.currentTarget.value)} />
        </Field>
      </FieldGrid>
      <FormResult state={form.state} />
      <FormFooter>
        <Button type="submit" variant="primary" loading={form.pending}>
          Add Yahoo account
        </Button>
      </FormFooter>
    </form>
  );
}

function CaldavForm() {
  const form = useAccountForm('caldav');
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
      form.setState({ ...EMPTY_STATE, fieldErrors });
      return;
    }
    void form.submit(parsed.data, () => {
      setLabel('');
      setServerUrl('');
      setUsername('');
      setPassword('');
      setInsecureLan(false);
    });
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add a CalDAV account">
      <p className={styles.intro}>
        Calendars from Nextcloud, Fastmail, iCloud (app-specific password) and other CalDAV servers. Read-only in this version.
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
      <FormResult state={form.state} />
      <FormFooter>
        <Button type="submit" variant="primary" loading={form.pending}>
          Add CalDAV account
        </Button>
      </FormFooter>
    </form>
  );
}

function ImapForm() {
  const form = useAccountForm('imap');
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
        ...EMPTY_STATE,
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
    void form.submit(parsed.data, () => {
      setLabel('');
      setHost('');
      setPort('993');
      setSecurity('tls');
      setUsername('');
      setPassword('');
      setWebmailUrl('');
    });
  };

  return (
    <form className={styles.formGrid} onSubmit={onSubmit} noValidate aria-label="Add an IMAP account">
      <p className={styles.intro}>Unread counts and recent messages from any IMAP mailbox. Connections are always encrypted.</p>
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
      <FormResult state={form.state} />
      <FormFooter>
        <Button type="submit" variant="primary" loading={form.pending}>
          Add IMAP account
        </Button>
      </FormFooter>
    </form>
  );
}
