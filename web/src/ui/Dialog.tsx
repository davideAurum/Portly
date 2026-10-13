/**
 * Dialog and ConfirmDialog (§10.4) on Radix: focus trap, Esc to close, focus returns to the
 * trigger, `aria-labelledby`/`aria-describedby` from the title and description. `placement="side"`
 * renders a sheet on the right with a light overlay (used where the page behind is a live preview).
 */
import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { Button } from './Button.tsx';
import styles from './Dialog.module.css';

export interface DialogProps {
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** Optional trigger element (uncontrolled use). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer (usually buttons), right-aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  placement?: 'center' | 'side';
  /** Which edge a side sheet attaches to (default right). */
  side?: 'left' | 'right';
  /** Hide the × button (e.g. while an operation must finish). */
  hideClose?: boolean;
  /** Prevent closing via Esc/overlay (still closable via buttons). */
  dismissible?: boolean;
  /** Radix: runs when the dialog opens; `preventDefault()` keeps focus from the first focusable. */
  onOpenAutoFocus?: (event: Event) => void;
}

export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = 'md',
  placement = 'center',
  side = 'right',
  hideClose = false,
  dismissible = true,
  onOpenAutoFocus,
}: DialogProps) {
  const preventIfLocked = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} data-placement={placement} />
        <RadixDialog.Content
          className={styles.content}
          // Radix leaves this out; it says the page behind is inert (screen readers, and the hybrid
          // mode controller, which does not reload the page under an open dialog).
          aria-modal="true"
          data-size={size}
          data-placement={placement}
          data-side={placement === 'side' ? side : undefined}
          onEscapeKeyDown={preventIfLocked}
          {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
          onPointerDownOutside={preventIfLocked}
          onInteractOutside={preventIfLocked}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <header className={styles.header}>
            <div className={styles.titles}>
              <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className={styles.description}>{description}</RadixDialog.Description> : null}
            </div>
            {hideClose ? null : (
              <RadixDialog.Close className={styles.close} aria-label="Close">
                <X aria-hidden="true" />
              </RadixDialog.Close>
            )}
          </header>
          {children !== undefined ? <div className={styles.body}>{children}</div> : null}
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Closes the enclosing Dialog when its child is activated. */
export const DialogClose = RadixDialog.Close;

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. */
  destructive?: boolean;
  /**
   * Runs on confirm. The dialog shows a busy state while a returned promise is pending, closes
   * when it resolves and stays open if it rejects (the caller reports the error).
   */
  onConfirm(): void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Stay open; the caller has shown the error.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      description={description}
      size="sm"
      hideClose
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={() => void confirm()} loading={busy} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
