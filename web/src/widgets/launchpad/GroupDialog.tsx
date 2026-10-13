/**
 * Create / rename a bookmark group (name + optional color), and the delete confirmation. Shared
 * by the launch pad (edit mode) and Settings → Bookmarks.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { BookmarkGroupNameSchema, type BookmarkGroup } from '@homebase/shared';
import { useCreateGroup, useDeleteGroup, useUpdateGroup } from '../../api/bookmarks.ts';
import { Button, ColorPicker, ConfirmDialog, Dialog, Field, Input, toastError } from '../../ui/index.ts';
import styles from './Launchpad.module.css';

export interface GroupDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Edit this group (otherwise create one). */
  group?: BookmarkGroup | null;
  onCreated?(group: BookmarkGroup): void;
}

export function GroupDialog({ open, onOpenChange, group, onCreated }: GroupDialogProps) {
  const create = useCreateGroup();
  const update = useUpdateGroup();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setColor(group?.color ?? null);
    setSubmitted(false);
  }, [open, group]);

  const parsed = BookmarkGroupNameSchema.safeParse(name);
  const error = submitted && !parsed.success ? (name.trim() === '' ? 'Give the group a name.' : 'Keep the name to 100 characters or fewer.') : null;
  const busy = create.isPending || update.isPending;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!parsed.success) return;
    try {
      if (group) {
        const patch: { name?: string; color?: string | null } = {};
        if (parsed.data !== group.name) patch.name = parsed.data;
        if (color !== group.color) patch.color = color;
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: group.id, patch });
      } else {
        const created = await create.mutateAsync({ name: parsed.data, color });
        onCreated?.(created);
      }
      onOpenChange(false);
    } catch (err) {
      if (!group) toastError(err, 'The group could not be created.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={group ? 'Edit group' : 'New group'} size="sm">
      <form className={styles.form} onSubmit={(event) => void onSubmit(event)} aria-label={group ? 'Edit group' : 'New group'} noValidate>
        <Field label="Name" error={error} required>
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={100} autoFocus placeholder="Work, News, Tools…" />
        </Field>
        <Field label="Color" help="Shown next to the group name.">
          <ColorPicker value={color} onChange={setColor} onClear={() => setColor(null)} />
        </Field>
        <div className={styles.formFooter}>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {group ? 'Save' : 'Create group'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface DeleteGroupDialogProps {
  group: BookmarkGroup | null;
  onOpenChange(open: boolean): void;
}

export function DeleteGroupDialog({ group, onOpenChange }: DeleteGroupDialogProps) {
  const remove = useDeleteGroup();
  const count = group?.bookmarks.length ?? 0;
  return (
    <ConfirmDialog
      open={group !== null}
      onOpenChange={onOpenChange}
      title={`Delete “${group?.name ?? ''}”?`}
      description={
        count > 0
          ? `The group and its ${count === 1 ? 'bookmark' : `${count} bookmarks`} will be deleted. This cannot be undone.`
          : 'The empty group will be deleted.'
      }
      confirmLabel="Delete group"
      destructive
      onConfirm={async () => {
        if (group) await remove.mutateAsync(group.id);
      }}
    />
  );
}
