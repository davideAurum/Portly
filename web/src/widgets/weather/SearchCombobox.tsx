/**
 * A small accessible combobox (ARIA 1.2 "list autocomplete"): a text input that controls an
 * inline listbox rendered below it (in flow, so it is never clipped by a dialog). Arrow keys move
 * the active option, Enter picks it (Enter never submits the surrounding form), Escape clears
 * the text (without closing a surrounding dialog).
 * Used by the weather location search and the clock's time-zone picker.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '../../ui/Input.tsx';
import styles from './Settings.module.css';

export interface SearchComboboxProps<T> {
  value: string;
  onValueChange(text: string): void;
  items: readonly T[];
  getKey(item: T): string;
  /** Visible content of an option. */
  renderItem(item: T): ReactNode;
  /** Accessible name of an option (defaults to its text content). */
  getLabel?(item: T): string;
  onSelect(item: T): void;
  /** Whether the list (or the status line) is shown. */
  open: boolean;
  /** Shown instead of the list when there are no items (searching, no results, error). */
  status?: ReactNode;
  placeholder?: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Required unless inside a Field. */
  'aria-label'?: string;
}

export function SearchCombobox<T>({
  value,
  onValueChange,
  items,
  getKey,
  renderItem,
  getLabel,
  onSelect,
  open,
  status,
  placeholder,
  icon: Icon,
  disabled,
  ...aria
}: SearchComboboxProps<T>) {
  const listId = useId();
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const showList = open && items.length > 0;

  // Escape with text clears the search and must not also close the dialog around it (the widget
  // settings sheet would discard every unsaved change). Radix dialogs listen for Escape on the
  // document in the capture phase, i.e. before any handler on the input, so this listener sits
  // on the window (captured even earlier) and stops the event there. With an empty box, Escape
  // passes through and closes the dialog as usual.
  const clearRef = useRef({ value, onValueChange });
  clearRef.current = { value, onValueChange };
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.target !== inputRef.current) return;
      if (clearRef.current.value === '') return;
      event.preventDefault();
      event.stopPropagation();
      clearRef.current.onValueChange('');
      setActive(-1);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // A new result set starts without an active option.
  const itemsKey = items.map(getKey).join('\u0000');
  useEffect(() => setActive(-1), [itemsKey]);

  // In a scrolling settings sheet the list can open below the fold: bring it into view.
  useEffect(() => {
    if (showList) listRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showList]);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const optionId = (index: number) => `${listId}-option-${index}`;

  const choose = (item: T) => {
    onSelect(item);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        if (!showList) return;
        event.preventDefault();
        setActive((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        if (!showList) return;
        event.preventDefault();
        setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
        break;
      case 'Enter': {
        // Never submit the surrounding (settings) form from the search box.
        event.preventDefault();
        const item = showList ? items[active >= 0 ? active : 0] : undefined;
        if (item !== undefined) choose(item);
        break;
      }
      // Escape is handled by the window listener above.
    }
  };

  return (
    <div className={styles.combobox}>
      <Input
        type="search"
        role="combobox"
        aria-label={aria['aria-label']}
        aria-expanded={showList}
        aria-controls={listId}
        ref={inputRef}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        leading={Icon ? <Icon aria-hidden="true" className={styles.searchIcon} /> : undefined}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" ref={listRef} className={styles.listbox} hidden={!showList} aria-label={aria['aria-label'] ? `${aria['aria-label']} results` : 'Results'}>
        {showList
          ? items.map((item, index) => (
              <li
                key={getKey(item)}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                aria-label={getLabel?.(item)}
                data-index={index}
                className={styles.option}
                // Keep focus in the input while clicking.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (active !== index) setActive(index);
                }}
                onClick={() => choose(item)}
              >
                {renderItem(item)}
              </li>
            ))
          : null}
      </ul>
      {/* Always mounted so screen readers announce changes (searching, no results). */}
      <div className={styles.comboStatus} role="status">
        {open && !showList ? status : null}
      </div>
    </div>
  );
}
