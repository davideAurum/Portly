/**
 * What the local server controller needs to know about the page it runs in (hybrid mode): whether
 * it is visible, when it becomes visible, hidden or focused or the network comes back, whether
 * it runs inside a frame, and whether the user is in the middle of something a reload would lose
 * (a modal dialog, edit mode, typing in a field). The controller receives these as dependencies;
 * the functions here are the browser's.
 */

export type PageEvent = 'visible' | 'hidden' | 'focus' | 'online';

export interface PageSignals {
  /** True while the tab is visible. */
  visible(): boolean;
  /** Calls `listener` on visibility changes, window focus and `online`; returns the unsubscribe function. */
  subscribe(listener: (event: PageEvent) => void): () => void;
}

export function browserPageSignals(doc: Document = document, win: Window = window): PageSignals {
  return {
    visible: () => doc.visibilityState === 'visible',
    subscribe(listener) {
      const onVisibility = () => listener(doc.visibilityState === 'visible' ? 'visible' : 'hidden');
      const onFocus = () => listener('focus');
      const onOnline = () => listener('online');
      doc.addEventListener('visibilitychange', onVisibility);
      win.addEventListener('focus', onFocus);
      win.addEventListener('online', onOnline);
      return () => {
        doc.removeEventListener('visibilitychange', onVisibility);
        win.removeEventListener('focus', onFocus);
        win.removeEventListener('online', onOnline);
      };
    },
  };
}

/** True when the page runs inside a frame (it then never uses the local server). */
export function isFramed(win: Window = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    // A cross-origin parent can make even the comparison throw in some browsers.
    return true;
  }
}

/** Input types whose value is typed text (a reload would lose what is being typed). */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * A focused field holding typed text. An empty one loses nothing on reload: the dashboard's search
 * box takes the focus on every load (autofocus) and must not hold a backend switch back.
 */
function isEditable(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled && element.value !== '';
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type) && !element.readOnly && !element.disabled && element.value !== '';
  if (!(element instanceof HTMLElement)) return false;
  // The attribute too: not every DOM implementation computes `isContentEditable`.
  const attribute = element.getAttribute('contenteditable');
  return element.isContentEditable === true || attribute === '' || attribute === 'true' || attribute === 'plaintext-only';
}

/**
 * True while reloading would interrupt the user: a modal dialog is open (`[role="dialog"]
 * [aria-modal="true"]` or `<dialog open>`), the dashboard is in edit mode
 * (`<html data-portly-editing="true">`), or a text field with text in it has focus.
 */
export function isPageBusy(doc: Document = document): boolean {
  if (doc.querySelector('[role="dialog"][aria-modal="true"], dialog[open]') !== null) return true;
  if (doc.documentElement.dataset.portlyEditing === 'true') return true;
  return isEditable(doc.activeElement);
}
