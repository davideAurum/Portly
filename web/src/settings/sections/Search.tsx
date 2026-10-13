/**
 * Settings → Search (§10.8): search engines (add from presets or custom, edit, reorder, delete,
 * default, keyword with uniqueness check, URL template with `%s`, suggestion provider),
 * suggestion and bookmark-match toggles, and "reset to presets". Everything is saved through
 * `PATCH /api/settings {search: …}` (arrays replace) after validating with the shared schema.
 * Engine icons are fetched once through site meta (the favicon of the engine's site) when
 * automatic icons are enabled.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ListPlus, Pencil, Plus, RotateCcw, Star, Trash } from 'lucide-react';
import {
  SEARCH_ENGINE_PRESETS,
  SUGGEST_PROVIDERS,
  SearchKeywordSchema,
  SearchSettingsSchema,
  SearchUrlTemplateSchema,
  buildSearchUrl,
  newId,
  presetToEngine,
  urlHost,
  type SearchEngine,
  type SearchSettings,
  type SuggestProvider,
} from '@homebase/shared';
import { useSettings, useUpdateSettings } from '../../api/settings.ts';
import { getCapabilities } from '../../capabilities.ts';
import { HYBRID_ENABLED } from '../../localServer/config.ts';
import { getLocalServerState } from '../../localServer/store.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Select,
  SettingsCard,
  SkeletonList,
  Switch,
  toast,
} from '../../ui/index.ts';
import { SiteIcon } from '../../widgets/launchpad/SiteIcon.tsx';
import { useEngineIcons } from '../../widgets/search/engineIcons.ts';
import { SearchFocusSwitch } from './SearchFocus.tsx';
import styles from '../../styles/settings.module.css';
import own from '../../widgets/search/SearchSettingsPage.module.css';

export const SUGGEST_PROVIDER_LABELS: Record<SuggestProvider, string> = {
  google: 'Google',
  ddg: 'DuckDuckGo',
  bing: 'Bing',
  wikipedia: 'Wikipedia',
  youtube: 'YouTube',
};

/**
 * Whether this page load can ask the provider for suggestions. The in-browser backend reaches only
 * Wikipedia (the others send no CORS headers); the stored enum is unchanged, the UI just says so.
 */
export function isSuggestProviderAvailable(provider: SuggestProvider): boolean {
  return getCapabilities().serverSearchSuggestions || provider === 'wikipedia';
}

/**
 * True when the other providers become available once this browser uses Homebase on this PC
 * (hybrid mode, not in a frame); otherwise this build never offers them.
 */
function serverSuggestionsReachable(): boolean {
  const { status } = getLocalServerState();
  return HYBRID_ENABLED && status !== 'disabled' && status !== 'framed';
}

function suggestProviderLabel(provider: SuggestProvider): string {
  if (isSuggestProviderAvailable(provider)) return SUGGEST_PROVIDER_LABELS[provider];
  return `${SUGGEST_PROVIDER_LABELS[provider]} (${serverSuggestionsReachable() ? 'needs Homebase on this PC' : 'not available in this build'})`;
}

function suggestionsDescription(): string {
  if (getCapabilities().serverSearchSuggestions) {
    return 'Sends what you type to the engine’s suggestion service (Google, DuckDuckGo, Bing, Wikipedia or YouTube) through Homebase.';
  }
  return serverSuggestionsReachable()
    ? 'Sends what you type directly from your browser to Wikipedia; Google, DuckDuckGo, Bing and YouTube suggestions work while this browser is connected to Homebase on this PC.'
    : 'Sends what you type directly from your browser to Wikipedia; Google, DuckDuckGo, Bing and YouTube suggestions are not available in the browser-only build.';
}

export default function SearchSettings() {
  const settings = useSettings();
  if (!settings.data) {
    return settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <SkeletonList rows={5} />;
  }
  return <SearchSettingsForm search={settings.data.search} autoIcons={settings.data.bookmarks.autoFetchIcons} />;
}

function SearchSettingsForm({ search, autoIcons }: { search: SearchSettings; autoIcons: boolean }) {
  const update = useUpdateSettings();
  const [editing, setEditing] = useState<SearchEngine | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SearchEngine | null>(null);
  const [resetting, setResetting] = useState(false);

  /** Validates and saves a new search settings value (arrays replace in the merge patch). */
  const save = (next: Partial<SearchSettings>, success?: string): Promise<boolean> => {
    const candidate = { ...search, ...next };
    const parsed = SearchSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'These search settings are not valid.');
      return Promise.resolve(false);
    }
    return update
      .mutateAsync({ search: next })
      .then(() => {
        if (success) toast.success(success);
        return true;
      })
      .catch(() => false);
  };

  useEngineIcons(search, autoIcons);

  const engines = search.engines;
  const moveEngine = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= engines.length) return;
    const next = [...engines];
    [next[index], next[target]] = [next[target]!, next[index]!];
    void save({ engines: next });
  };

  const missingPresets = SEARCH_ENGINE_PRESETS.filter((p) => !engines.some((e) => e.id === p.id));
  const addPreset = (id: string) => {
    const preset = SEARCH_ENGINE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    const taken = new Set(engines.flatMap((e) => (e.keyword ? [e.keyword.toLowerCase()] : [])));
    const engine = presetToEngine(preset);
    if (engine.keyword && taken.has(engine.keyword.toLowerCase())) engine.keyword = null;
    void save({ engines: [...engines, engine] }, `${preset.name} added`);
  };

  return (
    <div className={styles.stack}>
      <SettingsCard
        title="Search engines"
        description={
          <>
            Type an engine’s keyword and press <Kbd>Space</Kbd> in a search box to switch to it; <Kbd>Backspace</Kbd> switches back. The
            starred engine is the default.
          </>
        }
        actions={
          <>
            {missingPresets.length > 0 ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="sm" icon={ListPlus}>
                    Add preset
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuLabel>Popular engines</MenuLabel>
                  {missingPresets.map((preset) => (
                    <MenuItem key={preset.id} onSelect={() => addPreset(preset.id)} hint={<Kbd>{preset.keyword}</Kbd>}>
                      {preset.name}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            ) : null}
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing('new')}>
              Custom engine
            </Button>
          </>
        }
      >
        <ul className={styles.list} aria-label="Search engines">
          {engines.map((engine, index) => {
            const isDefault = engine.id === search.defaultEngineId;
            return (
              <li key={engine.id} className={styles.listItem}>
                <SiteIcon label={engine.name} iconId={engine.iconId} size={24} />
                <div className={styles.grow}>
                  <div className={own.engineTitle}>
                    <span className={styles.itemTitle}>{engine.name}</span>
                    {isDefault ? (
                      <Badge tone="accent" icon={Star}>
                        Default
                      </Badge>
                    ) : null}
                  </div>
                  <p className={styles.itemMeta}>
                    {urlHost(engine.urlTemplate)}
                    {engine.keyword ? (
                      <>
                        {' · keyword '}
                        <Kbd>{engine.keyword}</Kbd>
                      </>
                    ) : null}
                    {' · '}
                    {engine.suggest ? `${suggestProviderLabel(engine.suggest)} suggestions` : 'default engine’s suggestions'}
                  </p>
                </div>
                <div className={styles.itemActions}>
                  {!isDefault ? (
                    <Button size="sm" variant="ghost" onClick={() => void save({ defaultEngineId: engine.id }, `${engine.name} is now the default`)}>
                      Make default
                    </Button>
                  ) : null}
                  <IconButton icon={ArrowUp} size="sm" aria-label={`Move ${engine.name} up`} disabled={index === 0} onClick={() => moveEngine(index, -1)} />
                  <IconButton
                    icon={ArrowDown}
                    size="sm"
                    aria-label={`Move ${engine.name} down`}
                    disabled={index === engines.length - 1}
                    onClick={() => moveEngine(index, 1)}
                  />
                  <IconButton icon={Pencil} size="sm" aria-label={`Edit ${engine.name}`} onClick={() => setEditing(engine)} />
                  <IconButton
                    icon={Trash}
                    size="sm"
                    aria-label={`Delete ${engine.name}`}
                    disabled={engines.length === 1}
                    onClick={() => setDeleting(engine)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      <SettingsCard title="Search box" description="How the search box behaves when a page opens and while you type.">
        <div className={own.toggles}>
          <SearchFocusSwitch />
          <Switch
            label="Search suggestions"
            description={suggestionsDescription()}
            checked={search.suggestionsEnabled}
            onCheckedChange={(suggestionsEnabled) => void save({ suggestionsEnabled })}
          />
          <Switch
            label="Matching bookmarks"
            description="Shows up to four of your bookmarks above the suggestions. Never leaves this PC."
            checked={search.showBookmarkMatches}
            onCheckedChange={(showBookmarkMatches) => void save({ showBookmarkMatches })}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Reset"
        description="Go back to the preset engines (Google, DuckDuckGo, Bing, YouTube, Wikipedia and Google Maps) with their keywords."
        actions={
          <Button size="sm" icon={RotateCcw} onClick={() => setResetting(true)}>
            Reset to presets
          </Button>
        }
      />

      <EngineDialog
        engine={editing === 'new' ? null : editing}
        open={editing !== null}
        engines={engines}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={async (engine, makeDefault) => {
          const exists = engines.some((e) => e.id === engine.id);
          const next = exists ? engines.map((e) => (e.id === engine.id ? engine : e)) : [...engines, engine];
          const patch: Partial<SearchSettings> = { engines: next };
          if (makeDefault) patch.defaultEngineId = engine.id;
          return save(patch, exists ? `${engine.name} saved` : `${engine.name} added`);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? 'engine'}?`}
        description={deleting?.id === search.defaultEngineId ? 'It is the default engine; the first remaining engine becomes the default.' : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const next = engines.filter((e) => e.id !== deleting.id);
          const patch: Partial<SearchSettings> = { engines: next };
          if (deleting.id === search.defaultEngineId && next[0]) patch.defaultEngineId = next[0].id;
          if (!(await save(patch, `${deleting.name} deleted`))) throw new Error('not saved');
        }}
      />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset search engines?"
        description="Your custom engines, keywords and the default engine are replaced by the presets. The two switches above are kept."
        confirmLabel="Reset"
        destructive
        onConfirm={async () => {
          try {
            await update.mutateAsync({ search: { engines: null, defaultEngineId: null } });
            toast.success('Search engines reset');
          } catch (error) {
            throw error instanceof Error ? error : new Error('reset failed');
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engine dialog
// ---------------------------------------------------------------------------

interface EngineDialogProps {
  open: boolean;
  engine: SearchEngine | null;
  engines: readonly SearchEngine[];
  onOpenChange(open: boolean): void;
  onSave(engine: SearchEngine, makeDefault: boolean): Promise<boolean>;
}

function EngineDialog({ open, engine, engines, onOpenChange, onSave }: EngineDialogProps) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [keyword, setKeyword] = useState('');
  const [suggest, setSuggest] = useState<SuggestProvider | ''>('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(engine?.name ?? '');
    setTemplate(engine?.urlTemplate ?? '');
    setKeyword(engine?.keyword ?? '');
    setSuggest(engine ? (engine.suggest ?? '') : '');
    setMakeDefault(false);
    setSubmitted(false);
  }, [open, engine]);

  const trimmedName = name.trim();
  const nameError = trimmedName === '' ? 'Give the engine a name.' : trimmedName.length > 64 ? 'Keep the name to 64 characters or fewer.' : null;
  const templateCheck = SearchUrlTemplateSchema.safeParse(template);
  const templateError = templateCheck.success
    ? null
    : template.trim() === ''
      ? 'Enter the search address.'
      : !template.includes('%s')
        ? 'Put %s where the search terms go, e.g. https://example.com/search?q=%s'
        : 'Use an http(s) address without a user name or password.';
  const trimmedKeyword = keyword.trim();
  const keywordCheck = trimmedKeyword === '' ? null : SearchKeywordSchema.safeParse(trimmedKeyword);
  const duplicate = trimmedKeyword !== '' && engines.some((e) => e.id !== engine?.id && e.keyword?.toLowerCase() === trimmedKeyword.toLowerCase());
  const keywordError =
    keywordCheck && !keywordCheck.success
      ? 'Keywords are 1–16 characters without spaces.'
      : duplicate
        ? `“${trimmedKeyword}” is already used by ${engines.find((e) => e.keyword?.toLowerCase() === trimmedKeyword.toLowerCase())?.name}.`
        : null;
  const example = templateCheck.success ? buildSearchUrl(templateCheck.data, 'hello world') : null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (nameError || templateError || keywordError || !templateCheck.success) return;
    const next: SearchEngine = {
      id: engine?.id ?? newId(),
      name: trimmedName,
      urlTemplate: templateCheck.data,
      keyword: trimmedKeyword === '' ? null : trimmedKeyword,
      suggest: suggest === '' ? null : suggest,
      // A changed site gets a fresh icon.
      iconId: engine && urlHost(engine.urlTemplate) === urlHost(templateCheck.data) ? engine.iconId : null,
    };
    setSaving(true);
    const ok = await onSave(next, makeDefault);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={engine ? `Edit ${engine.name}` : 'Add a search engine'} size="md">
      <form className={own.form} onSubmit={(event) => void onSubmit(event)} aria-label={engine ? 'Edit search engine' : 'Add search engine'} noValidate>
        <Field label="Name" error={submitted ? nameError : null} required>
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={64} autoFocus placeholder="Example Search" />
        </Field>
        <Field
          label="Search address"
          required
          error={submitted || (template.trim() !== '' && !template.includes('%s')) ? templateError : null}
          help={example ? <span className={own.example}>Searching “hello world” opens {example}</span> : 'Use %s where the search terms go.'}
        >
          <Input
            value={template}
            onChange={(event) => setTemplate(event.currentTarget.value)}
            placeholder="https://example.com/search?q=%s"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            maxLength={2048}
          />
        </Field>
        <div className={own.twoColumns}>
          <Field label="Keyword" error={keywordError} help="Optional, e.g. “yt”.">
            <Input value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} maxLength={16} spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Suggestions from">
            <Select
              value={suggest}
              onChange={(event) => setSuggest(event.currentTarget.value as SuggestProvider | '')}
              options={[{ value: '', label: 'Default engine’s' }, ...SUGGEST_PROVIDERS.map((p) => ({ value: p, label: suggestProviderLabel(p) }))]}
            />
          </Field>
        </div>
        <Switch label="Make this the default engine" checked={makeDefault} onCheckedChange={setMakeDefault} />
        <div className={own.footer}>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {engine ? 'Save' : 'Add engine'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
