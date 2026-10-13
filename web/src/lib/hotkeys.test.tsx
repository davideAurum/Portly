import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { focusSearchInput, isEditableTarget, useHotkey, SEARCH_INPUT_ATTRIBUTE } from './hotkeys.ts';

function Harness({ onE, onHelp, enabled = true }: { onE: () => void; onHelp?: () => void; enabled?: boolean }) {
  useHotkey('e', onE, { enabled });
  useHotkey('?', onHelp ?? (() => {}));
  return (
    <div>
      <input aria-label="text" />
      <input aria-label="check" type="checkbox" />
      <textarea aria-label="area" />
      <select aria-label="pick">
        <option>a</option>
      </select>
      <div aria-label="editor" contentEditable suppressContentEditableWarning>
        <span>rich text</span>
      </div>
      <button type="button">button</button>
    </div>
  );
}

describe('useHotkey', () => {
  it('fires for plain key presses outside text entry', () => {
    const onE = vi.fn();
    render(<Harness onE={onE} />);
    fireEvent.keyDown(document.body, { key: 'e' });
    fireEvent.keyDown(document.body, { key: 'E', shiftKey: true });
    fireEvent.keyDown(screen.getByRole('button'), { key: 'e' });
    fireEvent.keyDown(screen.getByLabelText('check'), { key: 'e' });
    expect(onE).toHaveBeenCalledTimes(4);
  });

  it('ignores events from input, textarea, select and contenteditable', () => {
    const onE = vi.fn();
    render(<Harness onE={onE} />);
    fireEvent.keyDown(screen.getByLabelText('text'), { key: 'e' });
    fireEvent.keyDown(screen.getByLabelText('area'), { key: 'e' });
    fireEvent.keyDown(screen.getByLabelText('pick'), { key: 'e' });
    fireEvent.keyDown(screen.getByText('rich text'), { key: 'e' });
    expect(onE).not.toHaveBeenCalled();
  });

  it('ignores modifier chords, auto-repeat, IME composition and handled events', () => {
    const onE = vi.fn();
    render(<Harness onE={onE} />);
    fireEvent.keyDown(document.body, { key: 'e', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'e', altKey: true });
    fireEvent.keyDown(document.body, { key: 'e', repeat: true });
    fireEvent.keyDown(document.body, { key: 'e', isComposing: true });
    const handled = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(onE).not.toHaveBeenCalled();
  });

  it('ignores key presses inside an open dialog, menu or listbox', () => {
    const onE = vi.fn();
    const onHelp = vi.fn();
    render(
      <>
        <Harness onE={onE} onHelp={onHelp} />
        <div role="dialog" aria-label="Widget settings">
          <button type="button">Save</button>
        </div>
        <div role="menu" aria-label="Profiles">
          <div role="menuitemradio" aria-checked="false" tabIndex={-1}>
            Evening
          </div>
        </div>
      </>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'e' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: '?', shiftKey: true });
    // Menu typeahead ("e" jumps to "Evening") must not toggle edit mode behind the menu.
    fireEvent.keyDown(screen.getByRole('menuitemradio'), { key: 'e' });
    expect(onE).not.toHaveBeenCalled();
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('matches shifted characters like ? and can be disabled', () => {
    const onE = vi.fn();
    const onHelp = vi.fn();
    const { rerender } = render(<Harness onE={onE} onHelp={onHelp} enabled={false} />);
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(onHelp).toHaveBeenCalledOnce();
    expect(onE).not.toHaveBeenCalled();
    rerender(<Harness onE={onE} onHelp={onHelp} enabled />);
    fireEvent.keyDown(document.body, { key: 'e' });
    expect(onE).toHaveBeenCalledOnce();
  });

  it('prevents the default action only when it fires', () => {
    render(<Harness onE={() => {}} />);
    const fired = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    document.body.dispatchEvent(fired);
    expect(fired.defaultPrevented).toBe(true);
    const typed = new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true });
    screen.getByLabelText('text').dispatchEvent(typed);
    expect(typed.defaultPrevented).toBe(false);
  });
});

describe('helpers', () => {
  it('isEditableTarget', () => {
    const input = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(range)).toBe(false);
    expect(isEditableTarget(textbox)).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('focusSearchInput focuses the element marked by the search widget', () => {
    render(<input aria-label="search" {...{ [SEARCH_INPUT_ATTRIBUTE]: '' }} />);
    expect(focusSearchInput()).toBe(true);
    expect(screen.getByLabelText('search')).toHaveFocus();
  });
});
