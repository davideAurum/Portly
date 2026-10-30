/**
 * Notes widget helpers: the unsaved-draft copy kept in this browser, and finding a note in the
 * profiles the backend returns.
 */
import type { Profile, WidgetInstance } from '@portly/shared';

/**
 * Text typed into a note that the backend does not have yet, plus the stored text it was typed
 * over (`base`). Kept until a save succeeds, so a tab closed mid-save or a stopped server loses
 * nothing: the next page load shows it again.
 */
export interface NoteDraft {
  text: string;
  base: string;
}

/** Instance ids are random, so one prefix serves every backend and Pages site of an origin. */
const DRAFT_PREFIX = 'portly:notes-draft:';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readNoteDraft(instanceId: string): NoteDraft | null {
  try {
    const raw = storage()?.getItem(DRAFT_PREFIX + instanceId);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { text, base } = value as Record<string, unknown>;
    return typeof text === 'string' && typeof base === 'string' ? { text, base } : null;
  } catch {
    return null;
  }
}

/** Never throws: storage blocked or full only loses the safety copy. */
export function writeNoteDraft(instanceId: string, draft: NoteDraft): void {
  try {
    storage()?.setItem(DRAFT_PREFIX + instanceId, JSON.stringify(draft));
  } catch {
    // Nothing to do: the note itself still saves.
  }
}

export function clearNoteDraft(instanceId: string): void {
  try {
    storage()?.removeItem(DRAFT_PREFIX + instanceId);
  } catch {
    // Storage blocked: there is no draft to clear either.
  }
}

/** What a note shows when it mounts, from the stored text and any draft left by an earlier visit. */
export interface InitialNote {
  text: string;
  base: string;
  /** The stored text when it changed since the draft was typed (the user picks one), else null. */
  theirs: string | null;
}

export function initialNote(draft: NoteDraft | null, stored: string): InitialNote {
  if (draft === null || draft.text === stored || draft.text === draft.base) return { text: stored, base: stored, theirs: null };
  if (draft.base === stored) return { text: draft.text, base: stored, theirs: null };
  return { text: draft.text, base: draft.base, theirs: stored };
}

/** The notes widget `instanceId` in any profile, with that profile's id. */
export function findNotesWidget(profiles: readonly Profile[], instanceId: string): { profileId: string; instance: WidgetInstance } | null {
  for (const profile of profiles) {
    const instance = profile.layout.items.find((item) => item.id === instanceId && item.type === 'notes');
    if (instance) return { profileId: profile.id, instance };
  }
  return null;
}
