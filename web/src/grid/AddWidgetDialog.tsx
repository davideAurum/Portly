/**
 * Add Widget dialog (§10.2): every widget type this page load can run, in registry order. Any
 * type can be added any number of times; the server picks the position (`POST /widgets {type}`).
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Dialog } from '../ui/Dialog.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { availableWidgetDefinitions } from '../widgets/registry.ts';
import styles from './Grid.module.css';

/** The example names a widget every page load offers (the calendar runs on both backends). */
const DESCRIPTION = 'Widgets can be added more than once — for example two calendars with different views.';

export interface AddWidgetDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Adds a widget of `type`; the dialog closes when the promise resolves. */
  onAdd(type: string): Promise<void>;
}

export function AddWidgetDialog({ open, onOpenChange, onAdd }: AddWidgetDialogProps) {
  const [adding, setAdding] = useState<string | null>(null);

  const add = async (type: string) => {
    setAdding(type);
    try {
      await onAdd(type);
      onOpenChange(false);
    } catch {
      // The mutation reports the error; keep the dialog open to retry.
    } finally {
      setAdding(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a widget"
      description={DESCRIPTION}
      size="lg"
    >
      <ul className={styles.catalog}>
        {availableWidgetDefinitions().map((def) => {
          const Icon = def.icon;
          return (
            <li key={def.type}>
              <button
                type="button"
                className={styles.catalogItem}
                onClick={() => void add(def.type)}
                disabled={adding !== null}
                aria-busy={adding === def.type || undefined}
              >
                <span className={styles.catalogIcon} aria-hidden="true">
                  <Icon />
                </span>
                <span className={styles.catalogText}>
                  <span className={styles.catalogTitle}>{def.title}</span>
                  <span className={styles.catalogDescription}>{def.description}</span>
                </span>
                <span className={styles.catalogAdd} aria-hidden="true">
                  {adding === def.type ? <Spinner size={16} /> : <Plus />}
                </span>
                <span className="hb-visually-hidden">Add {def.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
