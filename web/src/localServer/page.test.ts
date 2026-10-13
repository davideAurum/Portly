/**
 * The page signals the controller follows (visibility, focus, online), framing, and the busy check
 * that holds a backend switch back: an open modal dialog, edit mode, or typing in a focused field.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPageSignals, isFramed, isPageBusy } from './page.ts';

afterEach(() => {
  document.body.innerHTML = '';
  delete document.documentElement.dataset.portlyEditing;
});

describe('isPageBusy', () => {
  it('is idle on a plain page, or with a button focused', () => {
    document.body.innerHTML = '<button>Go</button><div role="dialog">not modal</div><dialog>closed</dialog>';
    document.querySelector('button')!.focus();
    expect(isPageBusy()).toBe(false);
  });

  it('is busy while a modal dialog is open', () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true">Edit bookmark</div>';
    expect(isPageBusy()).toBe(true);
    document.body.innerHTML = '<dialog open>Settings</dialog>';
    expect(isPageBusy()).toBe(true);
  });

  it('is busy in edit mode', () => {
    document.documentElement.dataset.portlyEditing = 'true';
    expect(isPageBusy()).toBe(true);
    document.documentElement.dataset.portlyEditing = 'false';
    expect(isPageBusy()).toBe(false);
  });

  const busy = (id: string) => {
    (document.getElementById(id) as HTMLElement).focus();
    return isPageBusy();
  };

  it('is busy while an editable field with text in it has focus', () => {
    document.body.innerHTML = [
      '<input id="text" value="draft">',
      '<input id="search" type="search" value="weather">',
      '<textarea id="area">A note</textarea>',
      '<div id="rich" contenteditable="true" tabindex="0"></div>',
      '<input id="box" type="checkbox">',
      '<input id="ro" readonly value="fixed">',
      '<textarea id="off" disabled>off</textarea>',
    ].join('');
    expect(busy('text')).toBe(true);
    expect(busy('search')).toBe(true);
    expect(busy('area')).toBe(true);
    expect(busy('rich')).toBe(true);
    expect(busy('box')).toBe(false);
    expect(busy('ro')).toBe(false);
  });

  it('is idle with an empty field focused (the autofocused search box), busy once typed into', () => {
    document.body.innerHTML = '<input id="search" type="text" autofocus><textarea id="area"></textarea>';
    expect(busy('search')).toBe(false);
    expect(busy('area')).toBe(false);
    const input = document.getElementById('search') as HTMLInputElement;
    input.value = 'w';
    expect(busy('search')).toBe(true);
    input.value = '';
    expect(busy('search')).toBe(false);
  });
});

describe('browserPageSignals', () => {
  it('reports visibility, focus and online until unsubscribed', () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const signals = browserPageSignals();
    const listener = vi.fn();
    const off = signals.subscribe(listener);
    expect(signals.visible()).toBe(true);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(signals.visible()).toBe(false);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    expect(listener.mock.calls.map(([event]) => event)).toEqual(['hidden', 'visible', 'focus', 'online']);
    off();
    window.dispatchEvent(new Event('focus'));
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('isFramed', () => {
  it('compares the top window with this one', () => {
    expect(isFramed()).toBe(false);
    const self = {} as Window;
    expect(isFramed({ top: {} as Window, self } as unknown as Window)).toBe(true);
    expect(isFramed({ top: self, self } as unknown as Window)).toBe(false);
  });

  it('treats a parent it cannot even compare as a frame', () => {
    const hostile = {
      get top(): Window {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
      self: {},
    };
    expect(isFramed(hostile as unknown as Window)).toBe(true);
  });
});
