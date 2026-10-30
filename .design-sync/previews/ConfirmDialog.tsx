import { ConfirmDialog } from '@portly/ui';

// Rendered open (controlled `open`) so the card shows the confirmation surface.
export const RemoveWidget = () => (
  <ConfirmDialog
    open
    onOpenChange={() => {}}
    title="Remove Weather?"
    description="The widget and its settings are removed from this profile. Your accounts and data are not affected."
    confirmLabel="Remove"
    destructive
    onConfirm={() => {}}
  />
);

export const ContinueToProvider = () => (
  <ConfirmDialog
    open
    onOpenChange={() => {}}
    title="Add launch pad sync?"
    description="Microsoft asks you to allow one more permission: Portly's own folder in your OneDrive. You'll come back here after signing in."
    confirmLabel="Continue to Microsoft"
    onConfirm={() => {}}
  />
);
