/**
 * Paired browsers (hybrid mode), a card in Settings → About wherever the server answers: the Pages
 * address Portly trusts (or how to set one), the browsers paired with it — when each was paired
 * and last used, and an "Old address" badge for pairings made for a Pages address that is no
 * longer configured (they no longer work) — and Revoke. Pairing itself starts on the Pages site
 * and is approved on `#/pair` (`app/PairPage.tsx`).
 */
import { useState, type ReactNode } from 'react';
import { MonitorSmartphone, Unlink } from 'lucide-react';
import type { PairingSummary } from '@portly/shared';
import { usePairings, useRevokePairing } from '../../api/pairing.ts';
import { PairingSetupSteps } from '../../app/PairPage.tsx';
import { Badge } from '../../ui/Badge.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { FactList, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { toast } from '../../ui/toast.ts';
import styles from '../../styles/settings.module.css';

/** Most recently active first (last use, else pairing time). */
function byRecentUse(a: PairingSummary, b: PairingSummary): number {
  return Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt);
}

export function PairedBrowsersCard() {
  const pairings = usePairings();
  const data = pairings.data;

  let body: ReactNode;
  if (data === undefined) {
    body = pairings.isError ? <ErrorState error={pairings.error} onRetry={() => void pairings.refetch()} compact /> : <SkeletonList rows={2} />;
  } else {
    const list = [...data.pairings].sort(byRecentUse);
    body = (
      <>
        {data.pagesUrl === null ? (
          <PairingSetupSteps />
        ) : (
          <FactList items={[{ label: 'Pages site', value: <ExternalLink href={data.pagesUrl}>{data.pagesUrl}</ExternalLink> }]} />
        )}
        {list.length > 0 ? (
          <ul className={styles.list} aria-label="Paired browsers">
            {list.map((pairing) => (
              <PairingRow key={pairing.id} pairing={pairing} />
            ))}
          </ul>
        ) : data.pagesUrl !== null ? (
          <p className={styles.intro}>
            No browser is paired yet. Open your Pages site and choose <strong>Pair this browser</strong> in the Portly status at the bottom of the
            dashboard.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <SettingsCard
      id="paired-browsers"
      title="Paired browsers"
      description={
        data !== undefined && data.pagesUrl === null
          ? 'Pairing is off: your Pages site can’t use Portly on this PC until you tell Portly its address.'
          : 'Browsers that may use Portly on this PC from your Pages site. Every page on that site’s address gets the same access in a paired browser.'
      }
    >
      {body}
    </SettingsCard>
  );
}

export default PairedBrowsersCard;

function PairingRow({ pairing }: { pairing: PairingSummary }) {
  const revoke = useRevokePairing();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={styles.listItem}>
      <MonitorSmartphone aria-hidden="true" width={18} height={18} />
      <div className={styles.grow}>
        <div className={styles.inlineRow}>
          <span className={styles.itemTitle}>{pairing.label}</span>
          {pairing.current ? null : (
            <Badge tone="warning" title="Paired for a Pages address that is no longer configured, so it no longer works.">
              Old address
            </Badge>
          )}
        </div>
        <span className={styles.itemMeta}>
          Paired <RelativeTime date={pairing.createdAt} />
          {' · '}
          {pairing.lastUsedAt === null ? (
            'never used'
          ) : (
            <>
              last used <RelativeTime date={pairing.lastUsedAt} />
            </>
          )}
          {pairing.current ? null : ` · ${pairing.origin}`}
        </span>
      </div>
      <div className={styles.itemActions}>
        <Button size="sm" variant="ghost" icon={Unlink} onClick={() => setConfirming(true)} aria-label={`Revoke ${pairing.label}`}>
          Revoke
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Revoke ${pairing.label}?`}
        description="That browser can no longer use Portly on this PC. Its Pages site goes back to the copy stored in the browser until it is paired again."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          await revoke.mutateAsync(pairing.id);
          toast.success(`${pairing.label} was unpaired.`);
        }}
      />
    </li>
  );
}
