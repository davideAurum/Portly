/**
 * Add / edit bookmark dialog (§10.8 Launch pad): URL → debounced `GET /api/site-meta` fills the
 * title (unless the user typed one) and the automatic icon; icon modes auto | upload | letter
 * (+ color). Uploads go to `POST /api/bookmarks/:id/icon` after the bookmark is saved.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ImagePlus, RefreshCw, Trash } from 'lucide-react';
import { BookmarkGroupNameSchema, BookmarkTitleSchema, type Bookmark, type BookmarkGroup, type SiteMeta } from '@homebase/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createGroup,
  fetchSiteMeta,
  moveBookmark,
  useCreateBookmark,
  useRefreshBookmarkIcon,
  useUpdateBookmark,
  useUploadBookmarkIcon,
} from '../../api/bookmarks.ts';
import { qk } from '../../api/keys.ts';
import { MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from '../../api/uploads.ts';
import { getCapabilities } from '../../capabilities.ts';
import { Button, ColorPicker, Dialog, Field, Input, LetterTile, SegmentedControl, Select, Spinner, toast, toastError } from '../../ui/index.ts';
import { normalizeTypedUrl } from '../search/url.ts';
import { SiteIcon } from './SiteIcon.tsx';
import { UNGROUPED_NAME, ensureUngroupedGroup, useUngroupedId } from './ungrouped.ts';
import styles from './Launchpad.module.css';

export const SITE_META_DEBOUNCE_MS = 400;
/** Group choices that are not group ids. */
const NO_GROUP = '__none__';
const NEW_GROUP = '__new__';
/** Where the suggested title came from: the page itself, or (in-browser backend) the address. */
function titleHelp(): string {
  return getCapabilities().siteMetaFetch ? 'Filled in from the page.' : 'Filled in from the address.';
}

/**
 * What "Fetch the website icon again" reports. The in-browser backend looks nothing up: it points
 * the bookmark at DuckDuckGo's icon service, which shows a generic placeholder for sites it does
 * not know (indistinguishable from a real icon), so it never claims an icon was found.
 */
function refreshIconMessage(refreshed: Pick<Bookmark, 'iconId'>): string {
  if (getCapabilities().siteMetaFetch) return refreshed.iconId ? 'Icon refreshed' : 'No icon found for this site';
  return refreshed.iconId ? 'Using DuckDuckGo’s icon for this site' : 'Sites on your home network keep their letter tile';
}

type IconChoice = 'auto' | 'upload' | 'letter';

export interface BookmarkDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: readonly BookmarkGroup[];
  /** Edit this bookmark (otherwise add a new one). */
  bookmark?: Bookmark | null;
  /** Preselected group for new bookmarks. */
  groupId?: string | null;
  /** A new bookmark's address and title to start from ("Add this page", addRequest.ts). */
  initialUrl?: string;
  initialTitle?: string | null;
  /** Deletes the bookmark being edited (the caller closes the dialog and offers Undo). */
  onDelete?: (bookmark: Bookmark) => void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Second-level labels under which a country code keeps its registrable names (bbc.co.uk). */
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'gob', 'ne', 'or']);

/**
 * "Netflix" for netflix.com (the site's name as a fallback title until, or unless, the page's own
 * title arrives); the host itself for IP addresses and single-label names.
 */
export function siteName(url: string): string {
  const host = hostOf(url);
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  let index = labels.length - 2;
  if (index > 0 && labels[labels.length - 1]!.length === 2 && GENERIC_SECOND_LEVEL.has(labels[index]!)) index--;
  const label = labels[index] ?? host;
  return label.charAt(0).toLocaleUpperCase() + label.slice(1);
}

export function BookmarkDialog(props: BookmarkDialogProps) {
  // Remount the form for every opening so state never leaks between bookmarks.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (props.open) setGeneration((g) => g + 1);
  }, [props.open]);
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.bookmark ? 'Edit bookmark' : 'Add bookmark'}
      description={props.bookmark ? undefined : props.initialUrl ? 'Choose a group, then add it to your launch pad.' : 'Paste an address — the title and icon are filled in for you.'}
      size="md"
    >
      {props.open ? <BookmarkForm key={generation} {...props} /> : null}
    </Dialog>
  );
}

function BookmarkForm({ onOpenChange, groups, bookmark, groupId: preselected, initialUrl, initialTitle, onDelete }: BookmarkDialogProps) {
  const client = useQueryClient();
  const create = useCreateBookmark();
  const update = useUpdateBookmark();
  const upload = useUploadBookmarkIcon();
  const refresh = useRefreshBookmarkIcon();
  const fileInputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const initialChoice: IconChoice = bookmark ? (bookmark.iconMode === 'custom' ? 'upload' : bookmark.iconMode) : 'auto';
  const [url, setUrl] = useState(bookmark?.url ?? initialUrl ?? '');
  const [title, setTitle] = useState(bookmark?.title ?? initialTitle ?? '');
  // A page's own title is kept: the site's title (site meta) only fills an empty one.
  const [titleTouched, setTitleTouched] = useState(Boolean(bookmark) || Boolean(initialTitle));
  const titleTouchedRef = useRef(titleTouched);
  titleTouchedRef.current = titleTouched;
  const ungroupedId = useUngroupedId(groups);
  const namedGroups = groups.filter((g) => g.id !== ungroupedId);
  const initialGroup = bookmark?.groupId ?? preselected ?? namedGroups[0]?.id ?? null;
  const [groupId, setGroupId] = useState<string>(initialGroup && initialGroup !== ungroupedId && groups.some((g) => g.id === initialGroup) ? initialGroup : NO_GROUP);
  const [newGroupName, setNewGroupName] = useState('');
  const [choice, setChoice] = useState<IconChoice>(initialChoice);
  const [letterColor, setLetterColor] = useState<string | null>(bookmark?.letterColor ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [meta, setMeta] = useState<SiteMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const normalized = normalizeTypedUrl(url);
  const urlChanged = !bookmark || normalized !== bookmark.url;

  // Debounced site meta (title + automatic icon) for new or changed URLs.
  useEffect(() => {
    if (!normalized || !urlChanged) {
      setMeta(null);
      setMetaLoading(false);
      return;
    }
    const controller = new AbortController();
    setMetaLoading(true);
    const timer = setTimeout(() => {
      fetchSiteMeta(normalized, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setMeta(result);
          const fetchedTitle = result.title;
          if (fetchedTitle) setTitle((current) => (titleTouchedRef.current && current.trim() !== '' ? current : fetchedTitle));
        })
        .catch(() => {
          if (!controller.signal.aborted) setMeta({ title: null, iconId: null });
        })
        .finally(() => {
          if (!controller.signal.aborted) setMetaLoading(false);
        });
    }, SITE_META_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalized, urlChanged]);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const autoIconId = urlChanged ? (meta?.iconId ?? null) : bookmark?.iconMode === 'auto' ? bookmark.iconId : (meta?.iconId ?? null);
  const displayTitle = title.trim() || meta?.title || (normalized ? siteName(normalized) : '');
  const urlError = submitted && !normalized ? 'Enter a web address such as example.com or https://example.com/page.' : null;
  const titleCheck = BookmarkTitleSchema.safeParse(displayTitle);
  const titleError = submitted && !titleCheck.success ? 'Titles can be up to 300 characters.' : null;
  const newGroupCheck = BookmarkGroupNameSchema.safeParse(newGroupName);
  const newGroupError =
    submitted && groupId === NEW_GROUP && !newGroupCheck.success
      ? newGroupName.trim() === ''
        ? 'Give the new group a name.'
        : 'Keep the name to 100 characters or fewer.'
      : null;

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size === 0 || picked.size > MAX_UPLOAD_BYTES) {
      setFileError('Choose an image up to 10 MB.');
      return;
    }
    if (picked.type !== '' && !picked.type.startsWith('image/')) {
      setFileError('Choose an image file (PNG, JPEG, WebP, GIF, SVG or ICO).');
      return;
    }
    setFileError(null);
    setFile(picked);
    setChoice('upload');
  };

  /** The chosen group's id: "No group" and "New group…" create their group first. */
  const resolveGroup = async (): Promise<string> => {
    if (groupId === NEW_GROUP && newGroupCheck.success) {
      const created = await createGroup({ name: newGroupCheck.data });
      await client.invalidateQueries({ queryKey: qk.bookmarks.all(), exact: true });
      return created.id;
    }
    if (groupId !== NO_GROUP && groups.some((g) => g.id === groupId)) return groupId;
    return ensureUngroupedGroup(client, ungroupedId);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!normalized || !titleCheck.success) return;
    if (groupId === NEW_GROUP && !newGroupCheck.success) return;
    if (choice === 'upload' && !file && bookmark?.iconMode !== 'custom') {
      setFileError('Choose an image for the icon.');
      return;
    }
    setSaving(true);
    try {
      let saved: Bookmark;
      if (!bookmark) {
        const target = await resolveGroup();
        saved = await create.mutateAsync({
          groupId: target,
          title: titleCheck.data,
          url: normalized,
          iconMode: choice === 'letter' ? 'letter' : 'auto',
          iconId: choice === 'auto' ? autoIconId : null,
          letterColor,
        });
      } else {
        const patch: Parameters<typeof update.mutateAsync>[0]['patch'] = {};
        if (titleCheck.data !== bookmark.title) patch.title = titleCheck.data;
        if (normalized !== bookmark.url) patch.url = normalized;
        if (letterColor !== bookmark.letterColor) patch.letterColor = letterColor;
        if (choice === 'letter' && bookmark.iconMode !== 'letter') patch.iconMode = 'letter';
        if (choice === 'auto' && (bookmark.iconMode !== 'auto' || (urlChanged && autoIconId))) {
          patch.iconMode = 'auto';
          if (autoIconId) patch.iconId = autoIconId;
        }
        saved = Object.keys(patch).length > 0 ? await update.mutateAsync({ id: bookmark.id, patch }) : bookmark;
        const currentChoice = bookmark.groupId === ungroupedId ? NO_GROUP : bookmark.groupId;
        if (groupId !== currentChoice) {
          // Moving between groups goes through the atomic move route (appended at the end).
          const target = await resolveGroup();
          const size = groups.find((g) => g.id === target)?.bookmarks.length ?? 0;
          if (target !== bookmark.groupId) client.setQueryData(qk.bookmarks.all(), await moveBookmark(bookmark.id, target, size));
        }
      }
      if (choice === 'upload' && file) {
        try {
          await upload.mutateAsync({ id: saved.id, file });
        } catch (error) {
          toastError(error, 'The bookmark was saved, but the icon could not be uploaded.');
        }
      }
      if (!bookmark) toast.success(`Added “${saved.title}”`);
      onOpenChange(false);
    } catch (error) {
      toastError(error, bookmark ? 'The bookmark could not be saved.' : 'The bookmark could not be added.');
    } finally {
      setSaving(false);
    }
  };

  const groupOptions = [
    { value: NO_GROUP, label: UNGROUPED_NAME },
    ...namedGroups.map((g) => ({ value: g.id, label: g.name })),
    { value: NEW_GROUP, label: 'New group…' },
  ];

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)} aria-label={bookmark ? 'Edit bookmark' : 'Add bookmark'} noValidate>
      <div className={styles.formPreview} aria-hidden="true">
        <IconPreview choice={choice} title={displayTitle || '?'} autoIconId={autoIconId} bookmark={bookmark ?? null} previewUrl={previewUrl} letterColor={letterColor} />
        <div className={styles.formPreviewText}>
          <span className={styles.formPreviewTitle}>{displayTitle || 'New bookmark'}</span>
          <span className={styles.formPreviewHost}>{normalized ? hostOf(normalized) : 'example.com'}</span>
        </div>
        {metaLoading ? <Spinner size={16} /> : null}
      </div>

      <Field label="Address" error={urlError} required>
        <Input
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder="example.com"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus
          maxLength={2048}
        />
      </Field>
      <Field label="Title" error={titleError} help={!titleTouched && meta?.title ? titleHelp() : undefined}>
        <Input
          value={title}
          placeholder={meta?.title ?? (normalized ? siteName(normalized) : 'Name')}
          maxLength={300}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setTitleTouched(true);
          }}
        />
      </Field>
      <Field label="Group">
        <Select value={groupId} onChange={(event) => setGroupId(event.currentTarget.value)} options={groupOptions} />
      </Field>
      {groupId === NEW_GROUP ? (
        <Field label="New group name" error={newGroupError} required>
          <Input value={newGroupName} onChange={(event) => setNewGroupName(event.currentTarget.value)} maxLength={120} autoFocus placeholder="Work, News, Tools…" />
        </Field>
      ) : null}
      <Field label="Icon">
        <SegmentedControl<IconChoice>
          value={choice}
          onValueChange={(next) => {
            setChoice(next);
            if (next === 'upload' && !file && bookmark?.iconMode !== 'custom') fileRef.current?.click();
          }}
          options={[
            { value: 'auto', label: 'Website icon' },
            { value: 'upload', label: 'Upload' },
            { value: 'letter', label: 'Letter' },
          ]}
        />
      </Field>
      {choice === 'upload' ? (
        <div className={styles.uploadRow}>
          <label htmlFor={fileInputId} className={styles.fileButton}>
            <ImagePlus aria-hidden="true" />
            <span>{file ? file.name : bookmark?.iconMode === 'custom' ? 'Replace image…' : 'Choose an image…'}</span>
          </label>
          <input
            ref={fileRef}
            id={fileInputId}
            type="file"
            accept={`${UPLOAD_ACCEPT},.ico`}
            className="hb-visually-hidden"
            onChange={(event) => pickFile(event.currentTarget.files?.[0])}
          />
          <p className={fileError ? styles.fileError : styles.fileHint} role={fileError ? 'alert' : undefined}>
            {fileError ?? 'PNG, SVG, WebP, JPEG, GIF or ICO — square images look best.'}
          </p>
        </div>
      ) : null}
      {choice === 'letter' ? (
        <Field label="Tile color">
          <ColorPicker value={letterColor} onChange={setLetterColor} onClear={() => setLetterColor(null)} aria-label="Tile color" />
        </Field>
      ) : null}
      {choice === 'auto' && bookmark && !urlChanged ? (
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          loading={refresh.isPending}
          className={styles.refreshIcon}
          onClick={() =>
            refresh.mutate(bookmark.id, {
              onSuccess: (b) => toast.success(refreshIconMessage(b)),
            })
          }
        >
          Fetch the website icon again
        </Button>
      ) : null}

      <div className={styles.formFooter}>
        {bookmark && onDelete ? (
          <Button variant="danger" icon={Trash} className={styles.formFooterStart} onClick={() => onDelete(bookmark)} disabled={saving}>
            Delete
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {bookmark ? 'Save' : 'Add bookmark'}
        </Button>
      </div>
    </form>
  );
}

function IconPreview({
  choice,
  title,
  autoIconId,
  bookmark,
  previewUrl,
  letterColor,
}: {
  choice: IconChoice;
  title: string;
  autoIconId: string | null;
  bookmark: Bookmark | null;
  previewUrl: string | null;
  letterColor: string | null;
}) {
  const size = 44;
  if (choice === 'letter') return <LetterTile label={title} color={letterColor} size={size} />;
  if (choice === 'upload') {
    if (previewUrl) return <img className={styles.previewImage} src={previewUrl} width={size} height={size} alt="" />;
    if (bookmark?.iconMode === 'custom') return <SiteIcon label={title} iconId={bookmark.iconId} size={size} />;
    return <LetterTile label={title} size={size} />;
  }
  return <SiteIcon label={title} iconId={autoIconId} size={size} />;
}
