/**
 * The Add bookmark dialog for an "Add this page" request (`#/add-bookmark?url&title`, addRequest.ts),
 * mounted by the shell once the bookmarks have loaded. The group starts at the launch pad's default
 * group (`bookmarks.defaultGroupId`); saving or cancelling ends the request.
 */
import { useState } from 'react';
import { useBookmarks } from '../../api/bookmarks.ts';
import { useSettings } from '../../api/settings.ts';
import { BookmarkDialog } from './BookmarkDialog.tsx';
import type { AddBookmarkRequest } from './addRequest.ts';

export interface AddPageDialogProps {
  request: AddBookmarkRequest;
  /** The dialog closed (saved or cancelled). */
  onDone(): void;
}

export function AddPageDialog({ request, onDone }: AddPageDialogProps) {
  const bookmarks = useBookmarks();
  const settings = useSettings();
  const [open, setOpen] = useState(true);
  const groups = bookmarks.data?.groups;
  if (!groups || !settings.data) return null;
  const defaultGroupId = settings.data.bookmarks.defaultGroupId;
  return (
    <BookmarkDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onDone();
      }}
      groups={groups}
      groupId={groups.some((g) => g.id === defaultGroupId) ? defaultGroupId : null}
      initialUrl={request.url}
      initialTitle={request.title}
    />
  );
}

export default AddPageDialog;
