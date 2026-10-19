/**
 * Search widget (§10.8): engine chip/menu, `<keyword>` + Space switches engine (Backspace on an
 * empty input reverts), URL-looking input navigates directly (when the address was inferred —
 * `node.js`, `example.com` — the dropdown also offers searching for the text), dropdown with
 * bookmark matches (≤ 4) then suggestions (≤ 8; debounced 150 ms; the previous request is aborted on new input; provider
 * = engine's → default engine's → none when disabled; on the in-browser backend a provider only
 * Portly can ask is replaced by Wikipedia, labelled "Wikipedia suggestions"). ↑/↓ navigate, Enter opens in the current
 * tab (or a new one when `general.openLinksInNewTab`), Ctrl/Shift+Enter (and Ctrl/middle click)
 * open a new tab. `/` focuses the first search box (shell hotkey via `data-hb-search-input`), and
 * the first widget with `autofocus` takes focus on load (e.g. `?src=newtab`).
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowUpRight, Bookmark as BookmarkGlyph, ChevronDown, CornerDownLeft, Search as SearchGlyph, X } from 'lucide-react';
import type { Bookmark, SearchEngine, SearchSettings } from '@portly/shared';
import { useBookmarks } from '../../api/bookmarks.ts';
import { useSuggestions } from '../../api/search.ts';
import { useSettings } from '../../api/settings.ts';
import { SEARCH_INPUT_ATTRIBUTE } from '../../lib/hotkeys.ts';
import { openUrl } from '../../lib/openUrl.ts';
import { Kbd } from '../../ui/Badge.tsx';
import { IconButton } from '../../ui/Button.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../../ui/Menu.tsx';
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/Popover.tsx';
import { Skeleton } from '../../ui/Skeleton.tsx';
import { SiteIcon } from '../launchpad/SiteIcon.tsx';
import type { WidgetProps } from '../types.ts';
import { bookmarkHost, buildSearchUrl, defaultEngine, engineForKeyword, matchBookmarks, reachableSuggestProvider, suggestProviderFor, widgetEngines } from './engines.ts';
import type { SearchConfig } from './index.ts';
import { useEngineIcons } from './engineIcons.ts';
import { addressCandidate, detectUrl } from './url.ts';
import styles from './Search.module.css';

export const SUGGEST_DEBOUNCE_MS = 150;
const MAX_BOOKMARK_MATCHES = 4;
const MAX_SUGGESTIONS = 8;

export default function SearchWidget({ config }: WidgetProps<SearchConfig>) {
  const settings = useSettings();
  if (!settings.data) {
    if (settings.isError) return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} compact />;
    return (
      <div className={styles.root} role="status" aria-label="Loading">
        <Skeleton height={44} round className={styles.skeleton} />
      </div>
    );
  }
  return (
    <SearchBox
      search={settings.data.search}
      openLinksInNewTab={settings.data.general.openLinksInNewTab}
      autoIcons={settings.data.bookmarks.autoFetchIcons}
      config={config}
    />
  );
}

type Item =
  | { kind: 'url'; key: string; url: string }
  | { kind: 'search'; key: string; text: string }
  | { kind: 'bookmark'; key: string; bookmark: Bookmark }
  | { kind: 'suggestion'; key: string; text: string };

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface SearchBoxProps {
  search: SearchSettings;
  openLinksInNewTab: boolean;
  autoIcons: boolean;
  config: SearchConfig;
}

function SearchBox({ search, openLinksInNewTab, autoIcons, config }: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-opt-${index}`;

  const [text, setText] = useState('');
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const debounced = useDebounced(text, SUGGEST_DEBOUNCE_MS);
  useEngineIcons(search, autoIcons);

  const engines = useMemo(() => widgetEngines(search, config.engineIds), [search, config.engineIds]);
  const fallback = defaultEngine(engines, search.defaultEngineId);
  const engine = (overrideId ? engines.find((e) => e.id === overrideId) : undefined) ?? fallback;
  const switched = engine !== undefined && fallback !== undefined && engine.id !== fallback.id;

  const query = text.trim();
  const urlTarget = detectUrl(text);
  /** The address was inferred (no scheme typed): the text may just as well be a search. */
  const inferredUrl = urlTarget !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(query);
  /** `next.js`, `index.html`: searched on Enter, the address offered second. */
  const maybeUrl = urlTarget === null ? addressCandidate(text) : null;
  const wanted = urlTarget ? null : suggestProviderFor(search, engine, fallback);
  // A provider this page load cannot ask (the in-browser backend): Wikipedia's suggestions, labelled as such.
  const provider = wanted === null ? null : reachableSuggestProvider(wanted);
  const fellBack = provider !== null && provider !== wanted;
  const suggestions = useSuggestions(provider, provider ? debounced : '');
  const bookmarks = useBookmarks({ enabled: search.showBookmarkMatches });

  const matches = useMemo(
    () => (search.showBookmarkMatches ? matchBookmarks(bookmarks.data?.groups, query, MAX_BOOKMARK_MATCHES) : []),
    [bookmarks.data, query, search.showBookmarkMatches],
  );
  const suggestionData = suggestions.data;
  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    if (urlTarget) list.push({ kind: 'url', key: `url:${urlTarget}`, url: urlTarget });
    if (inferredUrl) list.push({ kind: 'search', key: `search:${query}`, text: query });
    if (maybeUrl) {
      list.push({ kind: 'search', key: `search:${query}`, text: query });
      list.push({ kind: 'url', key: `url:${maybeUrl}`, url: maybeUrl });
    }
    for (const bookmark of matches) list.push({ kind: 'bookmark', key: `b:${bookmark.id}`, bookmark });
    // Suggestions for text that was since deleted or replaced are not shown (UX-12).
    const current = debounced.trim() !== '' && query.toLowerCase().startsWith(debounced.trim().toLowerCase());
    if (query !== '' && provider && current) {
      for (const suggestion of (suggestionData ?? []).slice(0, MAX_SUGGESTIONS)) {
        list.push({ kind: 'suggestion', key: `s:${suggestion}`, text: suggestion });
      }
    }
    return list;
  }, [urlTarget, inferredUrl, maybeUrl, matches, suggestionData, query, provider, debounced]);

  const keywordEngine = !/\s/.test(query) ? engineForKeyword(engines, query) : undefined;
  const keywordHint = keywordEngine && keywordEngine.id !== engine?.id ? keywordEngine : undefined;
  const showDropdown = open && query !== '' && (items.length > 0 || keywordHint !== undefined);

  useEffect(() => setActive(-1), [text, overrideId]);
  useEffect(() => {
    if (active >= items.length) setActive(-1);
  }, [active, items.length]);

  // Autofocus: the first search widget (in document order) with autofocus takes focus on load,
  // unless the user is already somewhere else.
  useEffect(() => {
    if (!config.autofocus) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== document.documentElement) return;
      const first = document.querySelector(`[${SEARCH_INPUT_ATTRIBUTE}][data-hb-autofocus="true"]`);
      if (first === input) input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [config.autofocus]);

  const reset = () => {
    setText('');
    setOverrideId(null);
    setOpen(false);
    setActive(-1);
  };

  const go = (url: string, forceNewTab: boolean) => {
    const newTab = forceNewTab || openLinksInNewTab;
    if (!openUrl(url, { newTab })) return;
    if (newTab) reset();
  };

  const searchFor = (q: string, forceNewTab: boolean, withEngine: SearchEngine | undefined = engine) => {
    if (!withEngine || q.trim() === '') return;
    go(buildSearchUrl(withEngine.urlTemplate, q.trim()), forceNewTab);
  };

  const submit = (forceNewTab: boolean) => {
    if (query === '') return;
    if (urlTarget) return go(urlTarget, forceNewTab);
    searchFor(query, forceNewTab);
  };

  const activate = (item: Item, forceNewTab: boolean) => {
    if (item.kind === 'url') go(item.url, forceNewTab);
    else if (item.kind === 'bookmark') go(item.bookmark.url, forceNewTab);
    else searchFor(item.text, forceNewTab);
  };

  const selectEngine = (id: string) => {
    setOverrideId(id === fallback?.id ? null : id);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    const typedKeyword = /^(\S+) $/.exec(value);
    if (typedKeyword && text === typedKeyword[1]) {
      const target = engineForKeyword(engines, typedKeyword[1]!);
      if (target) {
        setOverrideId(target.id === fallback?.id ? null : target.id);
        setText('');
        setOpen(true);
        return;
      }
    }
    setText(value);
    setOpen(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        if (items.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActive((a) => (a + 1 >= items.length ? -1 : a + 1));
        return;
      case 'ArrowUp':
        if (items.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActive((a) => (a <= -1 ? items.length - 1 : a - 1));
        return;
      case 'Enter': {
        event.preventDefault();
        const forceNewTab = event.ctrlKey || event.shiftKey || event.metaKey;
        const item = showDropdown && active >= 0 ? items[active] : undefined;
        if (item) activate(item, forceNewTab);
        else submit(forceNewTab);
        return;
      }
      case 'Escape':
        if (showDropdown) {
          event.preventDefault();
          setOpen(false);
          setActive(-1);
        } else if (text !== '') {
          event.preventDefault();
          setText('');
        }
        return;
      case 'Backspace':
        if (text === '' && overrideId !== null) {
          event.preventDefault();
          setOverrideId(null);
        }
        return;
      default:
    }
  };

  const onOptionClick = (item: Item) => (event: MouseEvent) => {
    activate(item, event.ctrlKey || event.metaKey || event.shiftKey);
  };
  const onOptionAuxClick = (item: Item) => (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    activate(item, true);
  };

  const placeholder = switched && engine ? `Search ${engine.name}` : config.placeholder;
  const activeItem = showDropdown && active >= 0 ? items[active] : undefined;
  const showChip = engine !== undefined && (config.showEngineSwitcher || switched);
  const canSwitch = config.showEngineSwitcher && engines.length > 1;

  const renderOption = (item: Item, index: number) => (
    <div
      key={item.key}
      id={optionId(index)}
      role="option"
      aria-selected={index === active}
      className={styles.option}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => setActive(index)}
      onClick={onOptionClick(item)}
      onAuxClick={onOptionAuxClick(item)}
    >
      <OptionContent item={item} query={query} engineName={engine?.name ?? 'the web'} />
    </div>
  );
  // Options grouped by kind (a labelled group per section), keeping their flat indexes.
  const sections: { kind: Item['kind']; entries: { item: Item; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = sections.at(-1);
    if (last && last.kind === item.kind) last.entries.push({ item, index });
    else sections.push({ kind: item.kind, entries: [{ item, index }] });
  });
  const rows: ReactNode[] = sections.map((section) => {
    if (section.kind === 'url' || section.kind === 'search') return section.entries.map(({ item, index }) => renderOption(item, index));
    const label = section.kind === 'bookmark' ? 'Bookmarks' : fellBack ? 'Wikipedia suggestions' : `${engine?.name ?? 'Search'} suggestions`;
    const labelId = `${listboxId}-${section.kind}`;
    return (
      <div key={section.kind} role="group" aria-labelledby={labelId} className={styles.section}>
        <div id={labelId} className={styles.sectionLabel} role="presentation">
          {label}
        </div>
        {section.entries.map(({ item, index }) => renderOption(item, index))}
      </div>
    );
  });

  return (
    <div className={styles.root}>
      <Popover
        open={showDropdown}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
      >
        <PopoverAnchor asChild>
          <div ref={shellRef} className={styles.shell} data-switched={switched ? 'true' : undefined}>
            {showChip && engine ? (
              canSwitch ? (
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" className={styles.chip} aria-label={`Search engine: ${engine.name}. Change engine`}>
                      <SiteIcon label={engine.name} iconId={engine.iconId} size={20} />
                      <span className={styles.chipName}>{engine.name}</span>
                      <ChevronDown aria-hidden="true" className={styles.chipChevron} />
                    </button>
                  </MenuTrigger>
                  <MenuContent
                    align="start"
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      inputRef.current?.focus();
                    }}
                  >
                    <MenuLabel>Search with</MenuLabel>
                    <MenuRadioGroup value={engine.id} onValueChange={selectEngine}>
                      {engines.map((e) => (
                        <MenuRadioItem key={e.id} value={e.id}>
                          <span className={styles.menuEngine}>
                            <SiteIcon label={e.name} iconId={e.iconId} size={16} />
                            <span className={styles.menuEngineName}>{e.name}</span>
                            {e.keyword ? <Kbd>{e.keyword}</Kbd> : null}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                    {engines.some((e) => e.keyword) ? (
                      <>
                        <MenuSeparator />
                        {/* UX-12: the keyword switch is otherwise only discoverable in the ? dialog. */}
                        <p className={styles.menuHint}>
                          Type a keyword, then <Kbd>Space</Kbd>, to switch in the box. <Kbd>?</Kbd> lists all shortcuts.
                        </p>
                      </>
                    ) : null}
                  </MenuContent>
                </Menu>
              ) : (
                <span className={styles.chip} data-static="true">
                  <SiteIcon label={engine.name} iconId={engine.iconId} size={20} />
                  <span className={styles.chipName}>{engine.name}</span>
                  {switched ? (
                    <button type="button" className={styles.chipClear} aria-label={`Stop searching ${engine.name}`} onClick={() => selectEngine(fallback?.id ?? '')}>
                      <X aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              )
            ) : (
              <SearchGlyph aria-hidden="true" className={styles.leadingIcon} />
            )}
            <input
              ref={inputRef}
              className={styles.input}
              type="text"
              role="combobox"
              value={text}
              placeholder={placeholder}
              aria-label={engine ? `Search with ${engine.name} or enter an address` : 'Search or enter an address'}
              aria-autocomplete="list"
              aria-expanded={showDropdown}
              aria-controls={listboxId}
              aria-activedescendant={activeItem ? optionId(active) : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint={urlTarget ? 'go' : 'search'}
              maxLength={2048}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              data-hb-search-input=""
              data-hb-autofocus={config.autofocus ? 'true' : undefined}
            />
            {text !== '' ? (
              <IconButton
                icon={X}
                size="sm"
                aria-label="Clear"
                tooltip={false}
                className={styles.clear}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setText('');
                  inputRef.current?.focus();
                }}
              />
            ) : null}
            <IconButton
              icon={urlTarget ? ArrowUpRight : SearchGlyph}
              variant="primary"
              size="sm"
              className={styles.submit}
              aria-label={urlTarget ? 'Go to address' : `Search${engine ? ` ${engine.name}` : ''}`}
              tooltip={false}
              disabled={query === ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => submit(event.ctrlKey || event.metaKey || event.shiftKey)}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          className={styles.dropdown}
          align="start"
          sideOffset={6}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (shellRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
        >
          {keywordHint ? (
            <p className={styles.hint}>
              <SiteIcon label={keywordHint.name} iconId={keywordHint.iconId} size={16} />
              <span>
                Press <Kbd>Space</Kbd> to search {keywordHint.name}
              </span>
            </p>
          ) : null}
          <div id={listboxId} role="listbox" aria-label="Search suggestions" className={styles.listbox}>
            {rows}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function OptionContent({ item, query, engineName }: { item: Item; query: string; engineName: string }) {
  if (item.kind === 'search') {
    return (
      <>
        <SearchGlyph aria-hidden="true" className={styles.optionIcon} />
        <span className={styles.optionText}>
          Search {engineName} for <strong>{item.text}</strong>
        </span>
      </>
    );
  }
  if (item.kind === 'url') {
    return (
      <>
        <ArrowUpRight aria-hidden="true" className={styles.optionIcon} />
        <span className={styles.optionText}>
          Go to <strong>{item.url}</strong>
        </span>
        <CornerDownLeft aria-hidden="true" className={styles.optionEnter} />
      </>
    );
  }
  if (item.kind === 'bookmark') {
    const b = item.bookmark;
    return (
      <>
        <SiteIcon label={b.title} iconId={b.iconMode === 'letter' ? null : b.iconId} letter={b.iconMode === 'letter'} letterColor={b.letterColor} size={18} />
        <span className={styles.optionText}>{b.title}</span>
        <span className={styles.optionMeta}>
          <BookmarkGlyph aria-hidden="true" />
          {bookmarkHost(b.url)}
        </span>
      </>
    );
  }
  const lower = item.text.toLowerCase();
  const prefix = query.toLowerCase();
  const completes = prefix !== '' && lower.startsWith(prefix) && lower !== prefix;
  return (
    <>
      <SearchGlyph aria-hidden="true" className={styles.optionIcon} />
      <span className={styles.optionText}>
        {completes ? (
          <>
            {item.text.slice(0, query.length)}
            <strong>{item.text.slice(query.length)}</strong>
          </>
        ) : (
          item.text
        )}
      </span>
    </>
  );
}
