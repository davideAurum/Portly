/**
 * Global keyboard shortcuts (§10.6). {@link useHotkey} ignores key presses that come from text
 * entry (input, textarea, select, contenteditable), IME composition, auto-repeat, and presses
 * with Ctrl/Alt/Meta held, so shortcuts never fight with typing or browser/OS shortcuts. Events a
 * dialog or menu already handled (`defaultPrevented`, e.g. Esc closing a Radix dialog) are skipped,
 * and so is anything typed while focus is inside an open dialog, menu or listbox (menu typeahead,
 * a widget's settings sheet): page shortcuts must not act behind an overlay.
 */
import { useEffect, useRef } from 'react';

/** Attribute the search widget puts on its input so `/` can focus it. */
export const SEARCH_INPUT_ATTRIBUTE = 'data-hb-search-input';

export interface Shortcut {
  keys: string[];
  description: string;
}

/** Shown in the `?` help dialog and on the About page. */
export const SHORTCUTS: readonly Shortcut[] = Object.freeze([
  { keys: ['/'], description: 'Focus the search box' },
  { keys: ['E'], description: 'Toggle edit mode (move, resize, add and remove widgets)' },
  { keys: ['Esc'], description: 'Close a dialog or leave edit mode' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
]);

/** Keys inside the search box (§10.8), listed in the shortcut help (UX-12). */
export const SEARCH_BOX_SHORTCUTS: readonly Shortcut[] = Object.freeze([
  { keys: ['keyword', 'Space'], description: 'Switch to the engine with that keyword (e.g. yt Space)' },
  { keys: ['Backspace'], description: 'In an empty box: back to the default engine' },
  { keys: ['↑', '↓'], description: 'Move through bookmarks and suggestions' },
  { keys: ['Enter'], description: 'Search, or open the highlighted item' },
  { keys: ['Ctrl', 'Enter'], description: 'Open in a new tab (Shift+Enter too)' },
  { keys: ['Esc'], description: 'Close the suggestions, then clear the box' },
]);

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** True when the event target accepts text (shortcuts must not fire there). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // jsdom does not implement isContentEditable; also cover role=textbox widgets.
  const editable = target.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return true;
  return target.closest('[role="textbox"]') !== null;
}

const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/** True when the event target is inside an open dialog, menu or listbox. */
export function isInsideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null;
}

/** Whether `event` is a plain press of `key` (case-insensitive for letters). */
export function matchesHotkey(event: KeyboardEvent, key: string): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (key.length === 1) return event.key.toLowerCase() === key.toLowerCase();
  return event.key === key;
}

export interface HotkeyOptions {
  enabled?: boolean;
  /** Call preventDefault() when the hotkey fires (default true). */
  preventDefault?: boolean;
}

/** Registers a global shortcut for the lifetime of the component. */
export function useHotkey(key: string, handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}): void {
  const { enabled = true, preventDefault = true } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (isEditableTarget(event.target) || isInsideOverlay(event.target)) return;
      if (!matchesHotkey(event, key)) return;
      if (preventDefault) event.preventDefault();
      handlerRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, key, preventDefault]);
}

/** Focuses the first search input on the page; returns whether one was found. */
export function focusSearchInput(root: ParentNode = document): boolean {
  const input = root.querySelector<HTMLElement>(`[${SEARCH_INPUT_ATTRIBUTE}]`);
  if (!input) return false;
  input.focus();
  return true;
}
