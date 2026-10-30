/**
 * OAuth app registrations (§4.7) for Google and Microsoft: the one-time registration each provider
 * needs, with the console to open, the steps, the exact redirect URI to register and the client
 * ID (and Google's secret, write-only). The form is the first step of a connect dialog when the
 * provider is not set up yet; afterwards the "App registrations" line under the tiles edits it.
 *
 * On the in-browser backend Microsoft signs in from the browser itself, so its redirect URI is
 * this site's address, registered as a single-page application.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { OAuthClientUpdateSchema, type OAuthClientInfo, type OAuthProvider } from '@portly/shared';
import { isApiError } from '../../../api/client.ts';
import { useOAuthClient, useSaveOAuthClient } from '../../../api/accounts.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { Badge } from '../../../ui/Badge.tsx';
import { Button } from '../../../ui/Button.tsx';
import { CopyField } from '../../../ui/CopyField.tsx';
import { Dialog } from '../../../ui/Dialog.tsx';
import { ErrorState } from '../../../ui/ErrorState.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field } from '../../../ui/Field.tsx';
import { Input, PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { SkeletonList } from '../../../ui/Skeleton.tsx';
import { toast, toastError } from '../../../ui/toast.ts';
import { fieldErrorsFromDetails } from './CredentialForms.tsx';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';

interface ProviderInfo {
  title: string;
  console: { href: string; label: string };
  guide: string;
  needsSecret: boolean;
  /** Same plausibility check the server applies (catches copy/paste mistakes before saving). */
  clientIdPattern: RegExp;
  clientIdHint: string;
  clientIdLabel: string;
  steps: ReactNode[];
}

export const PROVIDER_INFO: Readonly<Record<OAuthProvider, ProviderInfo>> = {
  google: {
    title: 'Google',
    console: { href: 'https://console.cloud.google.com/apis/credentials', label: 'Google Cloud Console' },
    guide: 'docs/setup/google.md',
    needsSecret: true,
    clientIdPattern: /^[A-Za-z0-9-]{1,200}\.apps\.googleusercontent\.com$/,
    clientIdHint: 'Google client IDs end with .apps.googleusercontent.com.',
    clientIdLabel: 'Client ID',
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
    title: 'Microsoft',
    console: { href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', label: 'Microsoft Entra admin center' },
    guide: 'docs/setup/microsoft.md',
    needsSecret: false,
    clientIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    clientIdHint: 'The Application (client) ID looks like 00000000-0000-0000-0000-000000000000.',
    clientIdLabel: 'Application (client) ID',
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

/** A client ID is saved (and Google's secret with it). */
export function isClientConfigured(provider: OAuthProvider, client: OAuthClientInfo): boolean {
  return client.clientId !== null && (!PROVIDER_INFO[provider].needsSecret || client.hasSecret);
}

export interface AppRegistrationFormProps {
  provider: OAuthProvider;
  client: OAuthClientInfo;
  /** Runs after a successful save. */
  onSaved?(): void;
  submitLabel?: string;
  /** Extra buttons before the submit button (e.g. Cancel). */
  extraActions?: ReactNode;
}

/** Console link, steps, redirect URI and the client ID (and secret) form. */
export function AppRegistrationForm({ provider, client, onSaved, submitLabel = 'Save', extraActions }: AppRegistrationFormProps) {
  const info = PROVIDER_INFO[provider];
  const save = useSaveOAuthClient(provider);
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({});

  const idValue = clientId ?? client.clientId ?? '';
  const dirty = (clientId !== null && clientId.trim() !== (client.clientId ?? '')) || clientSecret !== '';

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
    const keepsSecret = client.hasSecret && body.clientId === client.clientId;
    if (info.needsSecret && !keepsSecret && !body.clientSecret) {
      next.clientSecret = client.hasSecret ? 'Enter the client secret that belongs to the new client ID.' : 'Google requires the client secret.';
    }
    setErrors(next);
    if (!parsed.success || Object.keys(next).length > 0) return;
    try {
      await save.mutateAsync(parsed.data);
      setClientId(null);
      setClientSecret('');
      toast.success(`${info.title} app registration saved.`);
      onSaved?.();
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
    <div className={styles.formGrid}>
      <p className={styles.intro}>
        {info.title} needs a one-time app registration that only you control. It is what lets Portly ask {info.title} for access to your
        account.
      </p>
      <ol className={styles.steps}>
        <li>
          Open the{' '}
          <ExternalLink href={info.console.href} showIcon>
            {info.console.label}
          </ExternalLink>
          .
        </li>
        {info.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <Field label="Redirect URI" help={`Must match exactly. Step-by-step guide: ${info.guide} in the Portly folder.`}>
        <CopyField value={client.redirectUri} label="Redirect URI" />
      </Field>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} noValidate aria-label={`${info.title} app registration`}>
        <Field label={info.clientIdLabel} error={errors.clientId} required>
          <Input value={idValue} onChange={(event) => setClientId(event.currentTarget.value)} spellCheck={false} autoComplete="off" maxLength={600} />
        </Field>
        {info.needsSecret ? (
          <Field
            label="Client secret"
            error={errors.clientSecret}
            help={client.hasSecret && idValue.trim() === client.clientId ? 'A secret is saved. Leave empty to keep it.' : 'Stored encrypted; never shown again.'}
            required={!client.hasSecret || idValue.trim() !== client.clientId}
          >
            <PasswordInput
              value={clientSecret}
              onChange={(event) => setClientSecret(event.currentTarget.value)}
              placeholder={client.hasSecret ? '••••••••••••' : ''}
              maxLength={1100}
            />
          </Field>
        ) : null}
        <FormFooter>
          {extraActions}
          <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
            {submitLabel}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

/** Ready / Setup needed / Credentials locked (a sign-in cannot store its tokens while the vault is locked). */
export function RegistrationStatus({ provider, client }: { provider: OAuthProvider; client: OAuthClientInfo }) {
  const locked = useVaultLocked();
  if (!isClientConfigured(provider, client)) return <Badge tone="warning">Setup needed</Badge>;
  if (locked) return <Badge tone="warning">Credentials locked</Badge>;
  return (
    <Badge tone="success" dot>
      Ready
    </Badge>
  );
}

/** The "App registrations" line under the tiles: each provider's status, and Edit. */
export function AppRegistrations({ providers }: { providers: readonly OAuthProvider[] }) {
  const [editing, setEditing] = useState<OAuthProvider | null>(null);
  if (providers.length === 0) return null;
  return (
    <div className={styles.registrations}>
      <span className={styles.registrationsLabel}>App registrations</span>
      <ul className={styles.registrationList} aria-label="App registrations">
        {providers.map((provider) => (
          <li key={provider}>
            <RegistrationItem provider={provider} onEdit={() => setEditing(provider)} />
          </li>
        ))}
      </ul>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing ? `${PROVIDER_INFO[editing].title} app registration` : ''}
        size="lg"
      >
        {editing ? <RegistrationEditor provider={editing} onDone={() => setEditing(null)} /> : null}
      </Dialog>
    </div>
  );
}

/** One provider's registration status with Edit and its editor: shown beside that provider's accounts (Manage). */
export function ProviderRegistration({ provider }: { provider: OAuthProvider }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={styles.registrationItem}>
      <RegistrationItem provider={provider} onEdit={() => setEditing(true)} />
      <Dialog open={editing} onOpenChange={setEditing} title={`${PROVIDER_INFO[provider].title} app registration`} size="lg">
        {editing ? <RegistrationEditor provider={provider} onDone={() => setEditing(false)} /> : null}
      </Dialog>
    </div>
  );
}

function RegistrationItem({ provider, onEdit }: { provider: OAuthProvider; onEdit(): void }) {
  const client = useOAuthClient(provider);
  const title = PROVIDER_INFO[provider].title;
  return (
    <span className={styles.registrationItem}>
      <span>{title}</span>
      {client.data ? <RegistrationStatus provider={provider} client={client.data} /> : client.isError ? <Badge tone="danger">Status unavailable</Badge> : null}
      <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit} aria-label={`Edit the ${title} app registration`}>
        Edit
      </Button>
    </span>
  );
}

function RegistrationEditor({ provider, onDone }: { provider: OAuthProvider; onDone(): void }) {
  const client = useOAuthClient(provider);
  if (client.data === undefined) {
    return client.isError ? <ErrorState error={client.error} onRetry={() => void client.refetch()} compact /> : <SkeletonList rows={2} avatar={false} />;
  }
  return (
    <AppRegistrationForm
      provider={provider}
      client={client.data}
      onSaved={onDone}
      extraActions={
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      }
    />
  );
}
