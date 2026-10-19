/**
 * The connect dialog behind each "Add a connection" tile (§7 Accounts, §4.7):
 *
 * - Google and Microsoft: the app registration (only while the provider is not set up), the
 *   services to use, then the sign-in. The sign-in asks only for the scopes of the services
 *   ticked; it runs in the same tab and comes back to this page.
 * - Yahoo: the services, then the app-password form (services left unticked start switched off).
 * - Other: CalDAV calendar or IMAP mail, then that server's form.
 * - Todoist: the API token.
 *
 * Password forms show what Portly's checks found per service, whether the account was added or not.
 */
import { useState, type ReactNode } from 'react';
import { LogIn } from 'lucide-react';
import { CAPABILITIES, type AccountCreateResult, type Capability, type OAuthClientInfo, type OAuthProvider } from '@portly/shared';
import { useOAuthClient, useStartOAuth, useUpdateAccount } from '../../../api/accounts.ts';
import { getCapabilities } from '../../../capabilities.ts';
import { CAPABILITY_ICONS, CAPABILITY_LABELS } from '../../../ui/accounts/accountKinds.ts';
import { Banner } from '../../../ui/Banner.tsx';
import { Button } from '../../../ui/Button.tsx';
import { Dialog } from '../../../ui/Dialog.tsx';
import { ErrorState } from '../../../ui/ErrorState.tsx';
import { FieldGroup } from '../../../ui/Field.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { SkeletonList } from '../../../ui/Skeleton.tsx';
import { Checkbox, SegmentedControl } from '../../../ui/Toggles.tsx';
import { AppRegistrationForm, PROVIDER_INFO, isClientConfigured } from './AppRegistration.tsx';
import { connectionInfo, connectionServices, type ConnectionId, type ServiceInfo } from './connections.ts';
import { CaldavForm, CreatedResult, ImapForm, YahooForm } from './CredentialForms.tsx';
import { TodoistTokenForm } from './Todoist.tsx';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';

const RETURN_TO = '#/settings/accounts';

/** How long a browser sign-in lasts on the in-browser backend, and how it renews. */
export const STATIC_MICROSOFT_SESSION_NOTE =
  'The sign-in is kept in this browser (not encrypted) and lasts 24 hours; Portly renews it by itself when you open the page while you are still signed in to Microsoft.';

export interface ConnectDialogProps {
  /** The connection to set up, or null when closed. */
  connection: ConnectionId | null;
  onClose(): void;
}

export function ConnectDialog({ connection, onClose }: ConnectDialogProps) {
  const title = connection === null ? '' : connection === 'other' ? 'Connect another account' : `Connect ${connectionInfo(connection).title}`;
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      size="lg"
    >
      {connection === null ? null : <ConnectFlow key={connection} connection={connection} onClose={onClose} />}
    </Dialog>
  );
}

function ConnectFlow({ connection, onClose }: { connection: ConnectionId; onClose(): void }) {
  switch (connection) {
    case 'google':
    case 'microsoft':
      return <OAuthConnect provider={connection} />;
    case 'yahoo':
      return <YahooConnect onClose={onClose} />;
    case 'other':
      return <OtherConnect onClose={onClose} />;
    case 'todoist':
      return <TodoistTokenForm onSaved={onClose} />;
  }
}

/** The step list at the top of the dialog. */
function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className={styles.stepper} aria-label="Steps">
      {steps.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined} data-done={index < current ? 'true' : undefined}>
          <span className={styles.stepNumber} aria-hidden="true">
            {index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** Checkboxes for the services to use, each with its one-line description. */
function ServicePicker({ services, picked, onChange }: { services: readonly ServiceInfo[]; picked: readonly Capability[]; onChange(next: Capability[]): void }) {
  return (
    <FieldGroup legend="What should Portly use this account for?" description="You can switch services on and off later under Manage.">
      <div className={styles.serviceList}>
        {services.map((service) => (
          <Checkbox
            key={service.capability}
            label={service.label}
            description={service.description}
            checked={picked.includes(service.capability)}
            onCheckedChange={(on) => {
              const next = on ? [...picked, service.capability] : picked.filter((c) => c !== service.capability);
              onChange(CAPABILITIES.filter((c) => next.includes(c)));
            }}
          />
        ))}
      </div>
    </FieldGroup>
  );
}

function ServiceChipList({ capabilities, label }: { capabilities: readonly Capability[]; label: string }) {
  return (
    <ul className={styles.serviceChips} aria-label={label}>
      {capabilities.map((capability) => {
        const Icon = CAPABILITY_ICONS[capability];
        return (
          <li key={capability} className={styles.serviceChip}>
            <Icon aria-hidden="true" />
            {CAPABILITY_LABELS[capability]}
          </li>
        );
      })}
    </ul>
  );
}

function Footer({ onBack, children }: { onBack?: (() => void) | undefined; children: ReactNode }) {
  return (
    <FormFooter>
      {onBack ? (
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      ) : null}
      {children}
    </FormFooter>
  );
}

// ---------------------------------------------------------------------------
// Google and Microsoft
// ---------------------------------------------------------------------------

function OAuthConnect({ provider }: { provider: OAuthProvider }) {
  const client = useOAuthClient(provider);
  if (client.data === undefined) {
    return client.isError ? <ErrorState error={client.error} onRetry={() => void client.refetch()} compact /> : <SkeletonList rows={2} avatar={false} />;
  }
  return <OAuthSteps provider={provider} client={client.data} />;
}

function OAuthSteps({ provider, client }: { provider: OAuthProvider; client: OAuthClientInfo }) {
  const services = connectionServices(provider);
  // Decided when the dialog opens: saving the registration must not make its step disappear.
  const [needsRegistration] = useState(() => !isClientConfigured(provider, client));
  const steps = [...(needsRegistration ? ['App registration'] : []), 'Services', 'Sign in'];
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Capability[]>(() => services.map((s) => s.capability));
  const current = steps[step];

  return (
    <div className={styles.dialogStack}>
      <Steps steps={steps} current={step} />
      {current === 'App registration' ? (
        <AppRegistrationForm provider={provider} client={client} submitLabel="Save and continue" onSaved={() => setStep(step + 1)} />
      ) : null}
      {current === 'Services' ? (
        <>
          <ServicePicker services={services} picked={picked} onChange={setPicked} />
          <Footer onBack={step > 0 ? () => setStep(step - 1) : undefined}>
            <Button variant="primary" disabled={picked.length === 0} onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          </Footer>
        </>
      ) : null}
      {current === 'Sign in' ? <SignInStep provider={provider} client={client} picked={picked} onBack={() => setStep(step - 1)} /> : null}
    </div>
  );
}

function SignInStep({ provider, client, picked, onBack }: { provider: OAuthProvider; client: OAuthClientInfo; picked: readonly Capability[]; onBack(): void }) {
  const title = PROVIDER_INFO[provider].title;
  const start = useStartOAuth();
  const locked = useVaultLocked();
  const configured = isClientConfigured(provider, client);
  const inBrowser = getCapabilities().backend === 'browser';
  return (
    <>
      <p className={styles.intro}>
        Portly takes you to {title} to sign in, then brings you back here. {title} asks you to allow access for:
      </p>
      <ServiceChipList capabilities={picked} label="Services to allow" />
      {provider === 'google' ? (
        <p className={styles.intro}>Keep every box ticked on Google's consent screen: a service you untick there stays off.</p>
      ) : null}
      {provider === 'microsoft' && inBrowser ? <p className={styles.intro}>{STATIC_MICROSOFT_SESSION_NOTE}</p> : null}
      {locked ? (
        <Banner tone="warning" title="Saved credentials are locked">
          Portly could not store the sign-in. Reset credentials with the banner on this page first.
        </Banner>
      ) : null}
      {!configured ? (
        <Banner tone="warning" title="App registration needed">
          Set up the {title} app registration under “App registrations” first.
        </Banner>
      ) : null}
      <Footer onBack={onBack}>
        <Button
          variant="primary"
          icon={LogIn}
          loading={start.isPending}
          disabled={locked || !configured}
          onClick={() => start.mutate({ provider, capabilities: [...picked], returnTo: RETURN_TO })}
        >
          Sign in with {title}
        </Button>
      </Footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Yahoo
// ---------------------------------------------------------------------------

/** After an account is added: what its checks found, and Done. */
function Added({ result, note, onClose }: { result: AccountCreateResult; note?: string | undefined; onClose(): void }) {
  return (
    <>
      <CreatedResult result={result} {...(note ? { note } : {})} />
      <Footer>
        <Button variant="primary" onClick={onClose} autoFocus>
          Done
        </Button>
      </Footer>
    </>
  );
}

function YahooConnect({ onClose }: { onClose(): void }) {
  const services = connectionServices('yahoo');
  const update = useUpdateAccount();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Capability[]>(() => services.map((s) => s.capability));
  const [created, setCreated] = useState<AccountCreateResult | null>(null);

  const onCreated = (result: AccountCreateResult) => {
    setCreated(result);
    // Both services are checked; the ones left unticked start switched off.
    const { account } = result;
    const enabled = account.enabledCapabilities.filter((c) => picked.includes(c));
    if (enabled.length !== account.enabledCapabilities.length) update.mutate({ id: account.id, enabledCapabilities: enabled });
  };

  const unpicked = services.filter((s) => !picked.includes(s.capability)).map((s) => s.label);
  return (
    <div className={styles.dialogStack}>
      <Steps steps={['Services', 'App password']} current={step} />
      {created ? (
        <Added
          result={created}
          note={unpicked.length > 0 ? `${unpicked.join(' and ')} is switched off; turn it on under Manage.` : undefined}
          onClose={onClose}
        />
      ) : step === 0 ? (
        <>
          <ServicePicker services={services} picked={picked} onChange={setPicked} />
          <Footer>
            <Button variant="primary" disabled={picked.length === 0} onClick={() => setStep(1)}>
              Continue
            </Button>
          </Footer>
        </>
      ) : (
        <YahooForm
          onCreated={onCreated}
          extraActions={
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Other: CalDAV calendar or IMAP mail
// ---------------------------------------------------------------------------

function OtherConnect({ onClose }: { onClose(): void }) {
  const services = connectionServices('other');
  const [step, setStep] = useState(0);
  const [service, setService] = useState<Capability>(services[0]?.capability ?? 'calendar');
  const [created, setCreated] = useState<AccountCreateResult | null>(null);
  const chosen = services.find((s) => s.capability === service);
  const back = (
    <Button variant="ghost" onClick={() => setStep(0)}>
      Back
    </Button>
  );

  return (
    <div className={styles.dialogStack}>
      <Steps steps={['Service', 'Server details']} current={step} />
      {created ? (
        <Added result={created} onClose={onClose} />
      ) : step === 0 ? (
        <>
          <FieldGroup legend="What do you want to connect?">
            <SegmentedControl<Capability>
              aria-label="Account type"
              value={service}
              onValueChange={setService}
              options={services.map((s) => ({ value: s.capability, label: s.capability === 'calendar' ? 'CalDAV calendar' : 'IMAP mail' }))}
            />
            {chosen ? <p className={styles.intro}>{chosen.description}</p> : null}
          </FieldGroup>
          <Footer>
            <Button variant="primary" onClick={() => setStep(1)}>
              Continue
            </Button>
          </Footer>
        </>
      ) : service === 'calendar' ? (
        <CaldavForm onCreated={setCreated} extraActions={back} />
      ) : (
        <ImapForm onCreated={setCreated} extraActions={back} />
      )}
    </div>
  );
}
