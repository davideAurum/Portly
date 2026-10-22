/**
 * Settings → Devices (ARCHITECTURE §4.2 remote branch, shared/src/devices.ts): the other PCs that
 * use this Portly through the reverse proxy on the main PC. Three cards:
 *
 * - *Other PCs*: the address they use (`PORTLY_REMOTE_ORIGIN`) and the port the proxy must point
 *   at, or how to set them up;
 * - *Waiting for approval*: each request with the name the other PC gave itself, its browser, the
 *   code to compare with that PC's screen, and **Approve** / **Deny**. Approving happens only on
 *   Portly's own page on the main PC: a connected PC and the paired Pages site see the list
 *   without the buttons and a line saying where to approve;
 * - *Connected PCs*: each device with its browser, when it connected and was last used, a "This
 *   PC" badge for the page's own device, and **Remove**, which stops its cookie at once. Other PCs
 *   are managed from the main PC (its own page or the paired Pages site): on another PC only
 *   **Disconnect this PC** is offered, which removes that PC's own device.
 *
 * The list is polled every few seconds while the page is open, so a request shows up by itself.
 * On a page load whose data lives in this browser (the Pages build's browser backend) there is no
 * server to manage: a note says so.
 */
import { useState, type ReactNode } from 'react';
import { Check, Laptop, MonitorSmartphone, Trash2, X } from 'lucide-react';
import type { DeviceRequestSummary, DeviceSummary } from '@portly/shared';
import { useApproveDevice, useDenyDevice, useDevices, useDisconnectDevice, useRevokeDevice } from '../../api/devices.ts';
import { getCapabilities } from '../../capabilities.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Banner } from '../../ui/Banner.tsx';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { ExternalLink } from '../../ui/ExternalLink.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { FactList, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { toast } from '../../ui/toast.ts';
import pairStyles from '../../app/PairPage.module.css';
import styles from '../../styles/settings.module.css';

/** Most recently active first (last use, else connection time). */
function byRecentUse(a: DeviceSummary, b: DeviceSummary): number {
  return Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt);
}

/** How to let other PCs in: the server reads the variables at start-up. */
export function RemoteSetupSteps() {
  return (
    <>
      <ol className={pairStyles.steps}>
        <li>
          Put an HTTPS reverse proxy in front of Portly on this PC. Tailscale Serve is the documented one: it is reachable only from your own
          devices, with a real certificate and no firewall change. Never use Tailscale Funnel, which would put Portly on the public internet.
        </li>
        <li>
          Point the proxy at Portly’s port for other PCs: the main port plus one, <code className={pairStyles.code}>5758</code> by default
          (for example <code className={pairStyles.code}>tailscale serve --bg 5758</code>).
        </li>
        <li>
          From your Portly folder run <code className={pairStyles.code}>scripts\setup.ps1 -RemoteOrigin &lt;address&gt;</code> with the
          address the proxy gives you, for example <code className={pairStyles.code}>https://&lt;pc&gt;.&lt;tailnet&gt;.ts.net</code> (add{' '}
          <code className={pairStyles.code}>-Trigger Logon</code> if you use Logon mode). It saves <code className={pairStyles.code}>PORTLY_REMOTE_ORIGIN</code>{' '}
          and restarts Portly with it. Setting the variable by hand and re-running{' '}
          <code className={pairStyles.code}>scripts\install-autostart.ps1</code> does the same.
        </li>
        <li>On the other PC, open that address and choose a name; then approve the request here.</li>
      </ol>
      <p className={pairStyles.text}>
        The step-by-step guide is <code className={pairStyles.code}>docs/setup/other-pcs.md</code> in the Portly folder.
      </p>
    </>
  );
}

export default function DevicesSettings() {
  const caps = getCapabilities();
  if (caps.backend === 'browser') {
    return (
      <div className={styles.stack}>
        <SettingsCard title="Other PCs" description="Other PCs connect to Portly running on the main PC, not to the copy in this browser.">
          <p className={styles.intro}>
            This page’s data lives in this browser, so there is nothing for another PC to connect to here. Set other PCs up on the main PC, in
            Portly’s own Settings → Devices.
          </p>
        </SettingsCard>
      </div>
    );
  }
  return <DevicesOnServer />;
}

function DevicesOnServer() {
  const caps = getCapabilities();
  // Approving is a decision for Portly's own page on the main PC: not another PC, not the Pages site.
  const canDecide = !caps.remoteClient && !caps.remoteServer;
  const devices = useDevices({ poll: true });
  const data = devices.data;

  if (data === undefined) {
    return (
      <div className={styles.stack}>
        <SettingsCard title="Other PCs">
          {devices.isError ? <ErrorState error={devices.error} onRetry={() => void devices.refetch()} compact /> : <SkeletonList rows={2} />}
        </SettingsCard>
      </div>
    );
  }

  const list = [...data.devices].sort(byRecentUse);
  return (
    <div className={styles.stack}>
      <SettingsCard
        id="remote-access"
        title="Other PCs"
        description={
          data.remoteOrigin === null
            ? 'Other PCs can’t connect yet: Portly on this PC does not know the address they would use.'
            : 'Other PCs open this address, ask to connect, and use Portly here once you approve them.'
        }
      >
        {data.remoteOrigin === null ? (
          <RemoteSetupSteps />
        ) : (
          <FactList items={[{ label: 'Address for other PCs', value: <ExternalLink href={data.remoteOrigin}>{data.remoteOrigin}</ExternalLink> }]} />
        )}
      </SettingsCard>

      <SettingsCard
        id="device-requests"
        title="Waiting for approval"
        description={
          canDecide
            ? 'Approve a request only when the code here matches the one on that PC’s screen.'
            : 'Requests are approved on Portly’s own page on the main PC.'
        }
      >
        {data.requests.length === 0 ? (
          <p className={styles.intro}>No PC is asking to connect right now. A request shows up here by itself while this page is open.</p>
        ) : (
          <ul className={styles.list} aria-label="Requests waiting for approval">
            {data.requests.map((request) => (
              <RequestRow key={request.id} request={request} canDecide={canDecide} />
            ))}
          </ul>
        )}
        {!canDecide && data.requests.length > 0 ? (
          <Banner tone="info" title="Approve on the main PC">
            Open Portly’s own page on the main PC (Settings → Devices) to approve or deny these requests.
          </Banner>
        ) : null}
      </SettingsCard>

      <SettingsCard
        id="connected-devices"
        title="Connected PCs"
        description={caps.remoteClient ? 'PCs that may use Portly on the main PC. They are managed there.' : 'PCs that may use Portly here. Removing one stops it at once.'}
      >
        {list.length === 0 ? (
          <EmptyState icon={Laptop} title="No other PC is connected" body="Once you approve a request, that PC shows up here." />
        ) : (
          <ul className={styles.list} aria-label="Connected PCs">
            {list.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}

function RequestRow({ request, canDecide }: { request: DeviceRequestSummary; canDecide: boolean }) {
  const approve = useApproveDevice();
  const deny = useDenyDevice();
  const busy = approve.isPending || deny.isPending;
  return (
    <li className={styles.listItem}>
      <MonitorSmartphone aria-hidden="true" width={18} height={18} />
      <div className={styles.grow}>
        <div className={styles.inlineRow}>
          <span className={styles.itemTitle}>{request.label}</span>
          <Badge tone="neutral">{request.browser}</Badge>
        </div>
        <span className={styles.itemMeta}>
          Code <span className={styles.mono}>{request.code}</span>
          {' · '}
          asked <RelativeTime date={request.createdAt} />
          {' · '}
          expires <RelativeTime date={request.expiresAt} />
        </span>
      </div>
      {canDecide ? (
        <div className={styles.itemActions}>
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            loading={deny.isPending}
            disabled={busy}
            // The hook's onError shows the toast; the handler only keeps the rejection from going unhandled.
            onClick={() => void deny.mutateAsync(request.id).then(() => toast.success(`${request.label} was denied.`), () => undefined)}
            aria-label={`Deny ${request.label}`}
          >
            Deny
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={Check}
            loading={approve.isPending}
            disabled={busy}
            onClick={() => void approve.mutateAsync(request.id).then(() => toast.success(`${request.label} was approved. It connects by itself.`), () => undefined)}
            aria-label={`Approve ${request.label}`}
          >
            Approve
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function DeviceRow({ device }: { device: DeviceSummary }) {
  const revoke = useRevokeDevice();
  const disconnect = useDisconnectDevice();
  const [confirming, setConfirming] = useState(false);
  // On another PC the server refuses removing other devices; that PC may only disconnect itself.
  const remote = getCapabilities().remoteClient;
  const offered = remote ? device.current : true;
  const label = remote ? 'Disconnect this PC' : `Remove ${device.label}`;
  let meta: ReactNode;
  if (device.lastUsedAt === null) meta = 'never used';
  else
    meta = (
      <>
        last used <RelativeTime date={device.lastUsedAt} />
      </>
    );
  return (
    <li className={styles.listItem}>
      <Laptop aria-hidden="true" width={18} height={18} />
      <div className={styles.grow}>
        <div className={styles.inlineRow}>
          <span className={styles.itemTitle}>{device.label}</span>
          <Badge tone="neutral">{device.browser}</Badge>
          {device.current ? <Badge tone="success">This PC</Badge> : null}
        </div>
        <span className={styles.itemMeta}>
          Connected <RelativeTime date={device.createdAt} />
          {' · '}
          {meta}
        </span>
      </div>
      {offered ? (
        <div className={styles.itemActions}>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)} aria-label={label}>
            {remote ? 'Disconnect' : 'Remove'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={remote ? 'Disconnect this PC?' : `Remove ${device.label}?`}
        description={
          device.current
            ? 'This PC stops using Portly at once and sees the connect screen again. To use Portly here again, ask to connect and approve the request on the main PC.'
            : 'That PC can no longer use Portly. To let it in again, it asks to connect and you approve the new request here.'
        }
        confirmLabel={remote ? 'Disconnect' : 'Remove'}
        destructive
        onConfirm={async () => {
          if (remote) await disconnect.mutateAsync();
          else await revoke.mutateAsync(device.id);
          toast.success(remote ? 'This PC was disconnected.' : `${device.label} was removed.`);
          if (device.current) window.location.reload();
        }}
      />
    </li>
  );
}
