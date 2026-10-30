/**
 * Notes widget (§10.8 Notes): one plain-text note per widget, saved as you type.
 *
 * The note is the widget's `text` config, so it goes wherever the profile goes (export and
 * import, profile copies, the in-browser backend, other PCs). Several tabs or PCs may show the
 * same note, so a save never overwrites blindly:
 * - edits are saved 600 ms after typing stops, and at once on blur, Ctrl+S or when the tab is
 *   hidden;
 * - a save first reads the stored note; when another tab or PC changed it since this tab loaded
 *   it, nothing is written and the widget asks which version to keep;
 * - until a save succeeds the text is also kept in this browser (`model.ts` drafts), so a tab
 *   closed mid-save or a stopped server loses nothing: the next page load shows it again;
 * - clicking into the note or coming back to the tab refreshes it first.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { qk } from '../../api/keys.ts';
import { fetchProfiles, saveWidget } from '../../api/profiles.ts';
import { useWidgetFrame, WidgetActions } from '../../grid/WidgetContext.tsx';
import { useDebouncedCallback } from '../../lib/useDebouncedCallback.ts';
import { Button } from '../../ui/Button.tsx';
import { errorMessage, toastError } from '../../ui/toast.ts';
import { Tooltip } from '../../ui/Tooltip.tsx';
import type { WidgetProps } from '../types.ts';
import { MAX_NOTE_LENGTH, notesConfigSchema, type NotesConfig } from './index.ts';
import { clearNoteDraft, findNotesWidget, initialNote, readNoteDraft, writeNoteDraft } from './model.ts';
import styles from './Notes.module.css';

export const SAVE_DELAY_MS = 600;
/** The character count shows from this share of the limit on. */
const COUNT_FROM = 0.9;

type SaveState = 'idle' | 'saving' | 'failed' | 'conflict';

function storedConfig(raw: unknown): NotesConfig {
  const parsed = notesConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : notesConfigSchema.parse({});
}

export default function NotesWidget({ instanceId, config }: WidgetProps<NotesConfig>) {
  const client = useQueryClient();
  const { title } = useWidgetFrame();
  const [initial] = useState(() => initialNote(readNoteDraft(instanceId), config.text));
  const [text, setText] = useState(initial.text);
  const [state, setState] = useState<SaveState>(initial.theirs === null ? 'idle' : 'conflict');
  /** The stored text while the user picks between it and theirs (state `conflict`). */
  const [theirs, setTheirs] = useState<string | null>(initial.theirs);
  const [failure, setFailure] = useState<unknown>(null);
  // Saves and listeners run outside renders: they read these.
  const textRef = useRef(initial.text);
  /** The stored text the edits in `text` were typed over; `text !== base` means unsaved edits. */
  const baseRef = useRef(initial.base);
  const stateRef = useRef<SaveState>(state);
  const inFlight = useRef(false);
  const saveAgain = useRef(false);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  const updateText = useCallback((next: string) => {
    textRef.current = next;
    setText(next);
  }, []);
  const updateState = useCallback((next: SaveState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const debouncedSave = useDebouncedCallback(() => void saveRef.current(), SAVE_DELAY_MS);

  saveRef.current = async () => {
    if (inFlight.current) {
      saveAgain.current = true;
      return;
    }
    if (stateRef.current === 'conflict') return;
    const draft = textRef.current;
    if (draft === baseRef.current) {
      clearNoteDraft(instanceId);
      if (stateRef.current === 'failed') updateState('idle');
      return;
    }
    const wasFailing = stateRef.current === 'failed';
    inFlight.current = true;
    updateState('saving');
    let next: SaveState = 'idle';
    try {
      // Read the stored note fresh: another tab or PC may have saved it since this tab loaded it.
      const found = findNotesWidget(await fetchProfiles(), instanceId);
      if (found === null) {
        // The widget was removed (or its profile deleted): there is nothing to save into.
        baseRef.current = draft;
      } else {
        const stored = storedConfig(found.instance.config);
        if (stored.text === draft) {
          baseRef.current = draft;
        } else if (stored.text !== baseRef.current) {
          setTheirs(stored.text);
          next = 'conflict';
        } else {
          await saveWidget(client, found.profileId, instanceId, { config: { ...stored, text: draft } }, null);
          baseRef.current = draft;
        }
      }
      setFailure(null);
    } catch (error) {
      next = 'failed';
      setFailure(error);
      // One toast when saving starts failing, not one per retry; the header keeps saying so.
      if (!wasFailing) toastError(error, 'The note could not be saved.');
    } finally {
      inFlight.current = false;
    }
    updateState(next);
    if (textRef.current === baseRef.current) clearNoteDraft(instanceId);
    else writeNoteDraft(instanceId, { text: textRef.current, base: baseRef.current });
    if (next !== 'idle') {
      saveAgain.current = false;
    } else if (saveAgain.current) {
      saveAgain.current = false;
      void saveRef.current();
    } else if (textRef.current !== baseRef.current) {
      // Typed on while the save ran.
      debouncedSave();
    }
  };

  // The stored note changed (a refetch, another tab, the settings preview).
  useEffect(() => {
    const stored = config.text;
    // This tab's own save is writing it (the optimistic update or its rollback).
    if (inFlight.current) return;
    if (textRef.current === stored) {
      baseRef.current = stored;
      clearNoteDraft(instanceId);
      if (stateRef.current !== 'idle') {
        setTheirs(null);
        updateState('idle');
      }
      return;
    }
    if (textRef.current === baseRef.current) {
      // Nothing unsaved here: show the stored note.
      baseRef.current = stored;
      updateText(stored);
      return;
    }
    if (stored === baseRef.current) {
      // The unsaved edits still apply; a conflict seen in an older copy of the note is over.
      if (stateRef.current === 'conflict') {
        setTheirs(null);
        updateState('idle');
        debouncedSave();
      }
      return;
    }
    if (stateRef.current === 'conflict') setTheirs(stored);
  }, [config.text, debouncedSave, instanceId, updateState, updateText]);

  // Edits restored from an earlier visit that never reached the backend.
  useEffect(() => {
    if (stateRef.current === 'idle' && textRef.current !== baseRef.current) debouncedSave();
  }, [debouncedSave]);

  /** Shows what another tab or PC saved before the user starts typing over an old copy. */
  const refresh = useCallback(() => {
    if (inFlight.current || textRef.current !== baseRef.current) return;
    void client.invalidateQueries({ queryKey: qk.profiles() }, { cancelRefetch: false });
  }, [client]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') debouncedSave.flush();
      else refresh();
    };
    const onPageHide = () => debouncedSave.flush();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [debouncedSave, refresh]);

  const onChange = (next: string) => {
    updateText(next);
    writeNoteDraft(instanceId, { text: next, base: baseRef.current });
    if (stateRef.current !== 'conflict') debouncedSave();
  };

  const saveNow = () => {
    debouncedSave.cancel();
    void saveRef.current();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveNow();
    }
  };

  const keepMine = () => {
    if (theirs === null) return;
    baseRef.current = theirs;
    setTheirs(null);
    updateState('idle');
    writeNoteDraft(instanceId, { text: textRef.current, base: theirs });
    saveNow();
  };

  const takeSaved = () => {
    if (theirs === null) return;
    baseRef.current = theirs;
    updateText(theirs);
    setTheirs(null);
    clearNoteDraft(instanceId);
    updateState('idle');
  };

  const count = text.length >= MAX_NOTE_LENGTH * COUNT_FROM ? `${text.length.toLocaleString()} / ${MAX_NOTE_LENGTH.toLocaleString()}` : null;

  return (
    <div className={styles.root} data-text-size={config.textSize} data-font={config.font}>
      <WidgetActions>
        {state === 'failed' ? (
          <Tooltip content={`Couldn't save: ${errorMessage(failure)} Your text is kept in this browser. Click to try again.`}>
            <button type="button" className={styles.unsaved} onClick={saveNow}>
              <TriangleAlert aria-hidden="true" />
              <span>Not saved</span>
            </button>
          </Tooltip>
        ) : null}
      </WidgetActions>
      {state === 'conflict' && theirs !== null ? (
        // Not a Banner: it has to fit a 2-column card and leave the text in view.
        <div className={styles.conflict} role="alert">
          <p className={styles.conflictText}>
            <TriangleAlert aria-hidden="true" />
            <span>Another tab or PC saved this note while you were editing it.</span>
          </p>
          <div className={styles.conflictActions}>
            <Button size="sm" variant="primary" onClick={keepMine}>
              Keep mine
            </Button>
            <Button size="sm" onClick={takeSaved}>
              Use saved
            </Button>
          </div>
        </div>
      ) : null}
      <textarea
        className={styles.text}
        value={text}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() => debouncedSave.flush()}
        onFocus={refresh}
        onKeyDown={onKeyDown}
        aria-label={title || 'Note'}
        placeholder="Write a note…"
        spellCheck={config.spellcheck}
        maxLength={MAX_NOTE_LENGTH}
      />
      {count !== null ? (
        <p className={styles.count} aria-live="polite">
          {count}
        </p>
      ) : null}
    </div>
  );
}
