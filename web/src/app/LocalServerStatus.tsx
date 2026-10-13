/**
 * The footer's local server indicator (Pages build, hybrid mode): a status dot and a short label
 * ("Not checked", "Connected · v0.1.0", "Reconnecting…", …) on a button that opens the local
 * server panel in a popover (Enter/Space opens it, Esc closes it and focus returns here).
 *
 * A polite `role="status"` live region announces real status changes only: the label present when
 * the page loads (and the page's first background check settling) is not announced, and a
 * background re-probe keeps showing the last settled status instead of flashing "Checking…". "Disconnect this browser" closes the popover and is
 * confirmed here, so the dialog outlives it. Renders nothing in the server build, while hybrid
 * mode is off (status `disabled`) and inside a frame.
 */
import { useState } from 'react';
import { getCapabilities } from '../capabilities.ts';
import { useLocalServer } from '../localServer/store.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover.tsx';
import { DisconnectDialog, LocalServerPanel, localServerStatusView, useDisplayedLocalServerStatus } from './LocalServerPanel.tsx';
import styles from './LocalServerStatus.module.css';

export function LocalServerStatus() {
  const state = useLocalServer();
  const status = useDisplayedLocalServerStatus(state);
  const view = localServerStatusView(status, state.server);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // What the live region says: empty until the label changes after the first render. When the
  // page loads during its first background check ("Checking…"), that check settling is not news
  // either (every new tab would announce "Connected"); later changes are.
  const [announcement, setAnnouncement] = useState(() => ({
    label: view.label,
    text: '',
    quiet: status === 'checking' && !state.manual,
  }));
  if (announcement.label !== view.label) {
    setAnnouncement({ label: view.label, text: announcement.quiet ? '' : `Portly on this PC: ${view.label}`, quiet: false });
  }

  if (!getCapabilities().pagesBuild || status === 'disabled' || status === 'framed') return null;
  return (
    <span className={styles.root}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* The name contains the visible label (WCAG 2.5.3) and says what it is the status of. */}
          <button type="button" className={styles.trigger} data-tone={view.tone} data-status={status} aria-label={`Portly on this PC: ${view.label}`}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.label}>{view.label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label="Portly on this PC" side="top" align="end">
          <LocalServerPanel
            variant="popover"
            status={status}
            onDisconnect={() => {
              setOpen(false);
              setConfirming(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <span role="status" aria-live="polite" className="hb-visually-hidden">
        {announcement.text}
      </span>
      <DisconnectDialog open={confirming} onOpenChange={setConfirming} />
    </span>
  );
}
