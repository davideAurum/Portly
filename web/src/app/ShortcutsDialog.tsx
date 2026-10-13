/** Keyboard shortcut help (`?`, §10.6). */
import { Fragment } from 'react';
import { SEARCH_BOX_SHORTCUTS, SHORTCUTS, type Shortcut } from '../lib/hotkeys.ts';
import { Kbd } from '../ui/Badge.tsx';
import { Dialog } from '../ui/Dialog.tsx';
import styles from './Shell.module.css';

function List({ shortcuts, label }: { shortcuts: readonly Shortcut[]; label: string }) {
  return (
    <dl className={styles.shortcuts} aria-label={label}>
      {shortcuts.map((shortcut) => (
        <Fragment key={shortcut.description}>
          <dt>
            {shortcut.keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </dt>
          <dd>{shortcut.description}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function ShortcutList() {
  return (
    <div className={styles.shortcutGroups}>
      <List shortcuts={SHORTCUTS} label="Anywhere" />
      <h3 className={styles.shortcutHeading}>In the search box</h3>
      <List shortcuts={SEARCH_BOX_SHORTCUTS} label="In the search box" />
    </div>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="sm">
      <ShortcutList />
    </Dialog>
  );
}
