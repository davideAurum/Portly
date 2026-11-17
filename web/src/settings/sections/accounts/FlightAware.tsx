/**
 * FlightAware as a connection in Settings → Accounts (§7 Flights, §10.5): the AeroAPI key behind
 * the flight tracker widget, its row under "Connected accounts" (status, Manage, Remove) and the
 * Manage dialog. Modeled on GitHub repositories. The key is write-only, checked with FlightAware (a
 * free call) before it is saved, and kept in the server's vault: there is no browser-only version.
 * The guide is docs/setup/flightaware.md.
 */
import { useState, type FormEvent } from 'react';
import { Plane, Save, Settings2, Trash } from 'lucide-react';
import { FLIGHTAWARE_KEY_RE, cleanFlightAwareKey } from '@portly/shared';
import { isApiError } from '../../../api/client.ts';
import { useFlightsKey, useRemoveFlightsKey, useSaveFlightsKey } from '../../../api/flights.ts';
import { Badge, LetterTile } from '../../../ui/Badge.tsx';
import { Banner } from '../../../ui/Banner.tsx';
import { Button, IconButton } from '../../../ui/Button.tsx';
import { ConfirmDialog, Dialog } from '../../../ui/Dialog.tsx';
import { ExternalLink } from '../../../ui/ExternalLink.tsx';
import { Field, FieldGroup } from '../../../ui/Field.tsx';
import { PasswordInput } from '../../../ui/Input.tsx';
import { FormFooter } from '../../../ui/Section.tsx';
import { errorMessage, toast, toastError } from '../../../ui/toast.ts';
import { connectionInfo } from './connections.ts';
import { useVaultLocked } from './vault.ts';
import styles from '../../../styles/settings.module.css';

export const FLIGHTAWARE_SIGNUP_URL = 'https://www.flightaware.com/aeroapi/portal/';

/** Save (or replace) the AeroAPI key. */
export function FlightAwareKeyForm({ onSaved, replacing = false }: { onSaved?(): void; replacing?: boolean }) {
  const save = useSaveFlightsKey();
  const locked = useVaultLocked();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const cleaned = cleanFlightAwareKey(key);
    if (!FLIGHTAWARE_KEY_RE.test(cleaned)) {
      setError(cleaned === '' ? 'Paste your AeroAPI key.' : "That doesn't look like an AeroAPI key.");
      return;
    }
    setError(null);
    try {
      await save.mutateAsync(cleaned);
      setKey('');
      toast.success(replacing ? 'FlightAware key updated.' : 'FlightAware connected.');
      onSaved?.();
    } catch (err) {
      if (isApiError(err, 'validation_failed')) setError(errorMessage(err));
      else toastError(err, 'The key could not be saved.');
    }
  };

  return (
    <div className={styles.formGrid}>
      <p className={styles.intro}>
        The Flights widget gets times, delays and gates from FlightAware AeroAPI with your own key. It is stored encrypted on this PC and
        never shown again.
      </p>
      <ol className={styles.steps} aria-label="What to set up at FlightAware">
        <li>
          Sign in at the{' '}
          <ExternalLink href={FLIGHTAWARE_SIGNUP_URL} showIcon>
            AeroAPI portal
          </ExternalLink>{' '}
          and choose the <strong>Personal</strong> tier. It includes $5 of free use a month; FlightAware asks for a card.
        </li>
        <li>
          Under <strong>API Keys</strong>, create a key and copy it.
        </li>
        <li>Paste it below and click Save. Portly checks it with a free call before storing it.</li>
      </ol>
      <p className={styles.intro}>
        Each flight lookup costs half a cent. Portly asks rarely while a flight is days away and every 5–10 minutes around departure and in
        the air, so a typical flight costs well under a dollar. Set a monthly limit in the portal to be safe.
      </p>
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} aria-label="FlightAware AeroAPI key" noValidate>
        <Field label={replacing ? 'Replace key' : 'AeroAPI key'} error={error}>
          <PasswordInput
            value={key}
            onChange={(event) => {
              setKey(event.currentTarget.value);
              if (error) setError(null);
            }}
            placeholder={replacing ? 'Paste a new key to replace the saved one' : 'Your AeroAPI key'}
            autoComplete="off"
            maxLength={200}
            disabled={locked}
          />
        </Field>
        <FormFooter status={save.isPending ? 'Checking the key with FlightAware…' : undefined}>
          <Button type="submit" variant="primary" icon={Save} loading={save.isPending} disabled={locked || key.trim() === ''}>
            {replacing ? 'Replace key' : 'Save key'}
          </Button>
        </FormFooter>
      </form>
    </div>
  );
}

const CONNECTION = connectionInfo('flightaware');

/** FlightAware under "Connected accounts" (only while a key is saved). */
export function FlightAwareRow({ onManage }: { onManage(): void }) {
  const remove = useRemoveFlightsKey();
  const locked = useVaultLocked();
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className={styles.accountRow}>
      <LetterTile label={CONNECTION.title} color={CONNECTION.mark?.color} size={36} />
      <div className={styles.accountMain}>
        <div className={styles.accountName}>
          <span>{CONNECTION.title}</span>
          {locked ? (
            <Badge tone="warning">Locked</Badge>
          ) : (
            <Badge tone="success" dot>
              Connected
            </Badge>
          )}
        </div>
        <span className={styles.itemMeta}>FlightAware AeroAPI · your own key</span>
        <ul className={styles.serviceChips} aria-label="FlightAware services in use">
          <li className={styles.serviceChip}>
            <Plane aria-hidden="true" />
            Flight tracking
          </li>
        </ul>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="secondary" icon={Settings2} onClick={onManage} aria-label="Manage FlightAware">
          Manage
        </Button>
        <IconButton icon={Trash} size="sm" aria-label="Remove FlightAware" onClick={() => setConfirmRemove(true)} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove FlightAware?"
        description="Portly deletes the saved key. Flights widgets stop showing flight status until you connect again. Nothing changes at FlightAware: delete the key in the AeroAPI portal too if you no longer want it."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
            toast.success('FlightAware removed.');
          } catch (err) {
            toastError(err, 'The key could not be removed.');
            throw err;
          }
        }}
      />
    </div>
  );
}

export function FlightAwareManageDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Manage FlightAware" description="Flight status for the Flights widget, through your AeroAPI key." size="lg">
      {open ? <ManageBody onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ManageBody({ onDone }: { onDone(): void }) {
  const locked = useVaultLocked();
  const configured = useFlightsKey().data?.configured === true;
  return (
    <div className={styles.dialogStack}>
      {locked ? (
        <Banner tone="warning" title="Saved credentials are locked">
          Portly can't read its encryption key, so the FlightAware key can't be used or replaced. Reset credentials with the banner on this
          page, then connect FlightAware again.
        </Banner>
      ) : null}
      <FieldGroup legend="Key">
        <FlightAwareKeyForm replacing={configured} onSaved={onDone} />
      </FieldGroup>
    </div>
  );
}
