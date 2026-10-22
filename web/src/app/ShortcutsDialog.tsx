/** Keyboard shortcut help (`?`, §10.6). */
import { Fragment } from 'react';
import { SEARCH_BOX_SHORTCUTS, SHORTCUTS, type Shortcut } from '../lib/hotkeys.ts';
import { Kbd } from '../ui/Badge.tsx';
import { Dialog } from '../ui/Dialog.tsx';
import styles from './Shell.module.css';

/**
 * Keys on a focused launch pad tile. The tile handles them itself (`ViewTile` in
 * `widgets/launchpad/Widget.tsx`: `Shift+F10` and the `ContextMenu` key open its menu), so they
 * are listed here rather than registered through `useHotkey`.
 */
export const LAUNCH_PAD_SHORTCUTS: readonly Shortcut[] = Object.freeze([
  { keys: ['Shift', 'F10'], description: 'Open its menu: Edit, Move to, Delete (the context-menu key works too)' },
]);

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
      <h3 className={styles.shortcutHeading}>On a launch pad tile</h3>
      <List shortcuts={LAUNCH_PAD_SHORTCUTS} label="On a launch pad tile" />
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
