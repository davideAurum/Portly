/**
 * Settings → Devices on the Pages build's browser backend: Portly on the main PC
 * (`localServer/mainPc.ts`). The user types the main PC's address for other PCs once; from then
 * on this browser's Pages site forwards there on load, so every PC uses the same address. Saving
 * asks for confirmation with the address spelled out; **Forget** removes it. `?here` keeps one
 * page load here, which is how this card is reached again while an address is saved.
 */
import { useState, type FormEvent } from 'react';
import { ExternalLink as ExternalLinkIcon, Trash2 } from 'lucide-react';
import { browserLocalStorage } from '../../localServer/pairing.ts';
import { STAY_HERE_PARAM, createMainPcStore, parseMainPcOrigin } from '../../localServer/mainPc.ts';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input } from '../../ui/Input.tsx';
import { FactList, SettingsCard } from '../../ui/Section.tsx';
import { toast } from '../../ui/toast.ts';
import pairStyles from '../../app/PairPage.module.css';
import styles from '../../styles/settings.module.css';

export function MainPcCard() {
  const pagesOrigin = window.location.origin;
  const [store] = useState(() => createMainPcStore(browserLocalStorage(), pagesOrigin));
  const [saved, setSaved] = useState(() => store.read());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const origin = parseMainPcOrigin(draft, pagesOrigin);
    if (origin === null) {
      setError('Enter the https address Portly on the main PC gives other PCs, such as https://<pc>.<tailnet>.ts.net.');
      return;
    }
    setError(null);
    setConfirming(origin);
  };

  return (
    <>
      <SettingsCard
        id="main-pc"
        title="Portly on your main PC"
        description="Open Portly from the main PC on this PC, with the same address you use everywhere."
      >
        {saved === null ? (
          <form className={styles.stack} onSubmit={submit} noValidate aria-label="Portly on your main PC">
            <p className={styles.intro}>
              If Portly runs on another PC that lets other PCs in (Settings → Devices there shows the address), enter that address. From then on,
              opening this site in this browser goes straight to Portly on the main PC, unless this PC runs Portly itself and this browser is
              paired with it.
            </p>
            <div className={styles.inlineForm}>
              <Field label="Main PC address" error={error} className={styles.grow}>
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://<pc>.<tailnet>.ts.net"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary">
                Use this address
              </Button>
            </div>
          </form>
        ) : (
          <div className={styles.stack}>
            <FactList items={[{ label: 'Main PC address', value: <code className={pairStyles.code}>{saved}</code> }]} />
            <p className={styles.intro}>
              Opening this site in this browser goes to Portly on the main PC. To stay on this browser’s copy once (for example while the main PC
              is off), add <code className={pairStyles.code}>?{STAY_HERE_PARAM}</code> to this site’s address.
            </p>
            <div className={styles.inlineRow}>
              <Button variant="primary" icon={ExternalLinkIcon} onClick={() => window.location.assign(`${saved}/`)}>
                Open Portly on the main PC
              </Button>
              <Button variant="ghost" icon={Trash2} onClick={() => setForgetting(true)}>
                Forget this address
              </Button>
            </div>
          </div>
        )}
      </SettingsCard>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Always open Portly on the main PC?"
        description={
          <>
            This browser will open <strong>{confirming}</strong> instead of this site from now on. Use it only for the address of your own main PC.
          </>
        }
        confirmLabel="Use this address"
        onConfirm={() => {
          if (confirming === null || !store.save(confirming)) {
            toast.error('This browser could not save the address.');
            throw new Error('not saved');
          }
          setSaved(store.read());
          setDraft('');
          toast.success('Saved. This site now opens Portly on the main PC.');
        }}
      />
      <ConfirmDialog
        open={forgetting}
        onOpenChange={setForgetting}
        title="Forget the main PC’s address?"
        description="Opening this site in this browser then shows this browser’s copy again. Portly on the main PC is not changed."
        confirmLabel="Forget"
        destructive
        onConfirm={() => {
          store.clear();
          setSaved(null);
        }}
      />
    </>
  );
}
