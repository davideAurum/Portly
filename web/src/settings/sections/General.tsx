/**
 * General settings (§7a GeneralSettings): name, locale, time format, week start, units and link
 * behaviour. Every field saves on its own (see GeneralForm); input is validated with the shared
 * schema first.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GeneralSettingsSchema, LocaleSchema, type GeneralSettings, type SettingsPatch } from '@portly/shared';
import { useSettings, useSettingsAutosave } from '../../api/settings.ts';
import { createFormatters } from '../../lib/format.ts';
import { useNow } from '../../lib/useNow.ts';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select } from '../../ui/Input.tsx';
import { FieldGrid, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonLines } from '../../ui/Skeleton.tsx';
import { SegmentedControl, Switch } from '../../ui/Toggles.tsx';
import styles from '../../styles/settings.module.css';

/** Locales offered in the picker (any other BCP 47 tag can be entered as "Other"). */
export const COMMON_LOCALES: readonly { value: string; label: string }[] = [
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-CA', label: 'English (Canada)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'de-DE', label: 'Deutsch (Deutschland)' },
  { value: 'fr-FR', label: 'Français (France)' },
  { value: 'es-ES', label: 'Español (España)' },
  { value: 'it-IT', label: 'Italiano (Italia)' },
  { value: 'nl-NL', label: 'Nederlands (Nederland)' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'sv-SE', label: 'Svenska (Sverige)' },
  { value: 'pl-PL', label: 'Polski (Polska)' },
  { value: 'ja-JP', label: '日本語 (日本)' },
  { value: 'zh-CN', label: '中文 (中国)' },
];

const OTHER = '__other__';

type FieldErrors = Partial<Record<keyof GeneralSettings, string>>;

export interface GeneralDraft {
  userName: string;
  localeChoice: string;
  customLocale: string;
  timeFormat: GeneralSettings['timeFormat'];
  weekStartsOn: GeneralSettings['weekStartsOn'];
  temperatureUnit: GeneralSettings['temperatureUnit'];
  windUnit: GeneralSettings['windUnit'];
  precipUnit: GeneralSettings['precipUnit'];
  openLinksInNewTab: boolean;
}

function toDraft(general: GeneralSettings): GeneralDraft {
  const known = general.locale === 'system' || COMMON_LOCALES.some((l) => l.value === general.locale);
  return {
    userName: general.userName ?? '',
    localeChoice: known ? general.locale : OTHER,
    customLocale: known ? '' : general.locale,
    timeFormat: general.timeFormat,
    weekStartsOn: general.weekStartsOn,
    temperatureUnit: general.temperatureUnit,
    windUnit: general.windUnit,
    precipUnit: general.precipUnit,
    openLinksInNewTab: general.openLinksInNewTab,
  };
}

function draftLocale(draft: GeneralDraft): string {
  return draft.localeChoice === OTHER ? draft.customLocale.trim() : draft.localeChoice;
}

/** Validates the draft; returns the settings to save or per-field errors. */
export function validateGeneral(draft: GeneralDraft): { ok: true; value: GeneralSettings } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  let locale = draftLocale(draft);
  if (!LocaleSchema.safeParse(locale).success) {
    errors.locale = 'Enter a language tag such as en-US, de or pt-BR.';
  } else if (locale !== 'system') {
    try {
      // Store the canonical form (fr-ca → fr-CA).
      locale = Intl.getCanonicalLocales(locale)[0] ?? locale;
    } catch {
      errors.locale = 'This language tag is not recognized.';
    }
  }
  const name = draft.userName.trim();
  const candidate = {
    ...(name ? { userName: name } : {}),
    locale,
    timeFormat: draft.timeFormat,
    weekStartsOn: draft.weekStartsOn,
    temperatureUnit: draft.temperatureUnit,
    windUnit: draft.windUnit,
    precipUnit: draft.precipUnit,
    openLinksInNewTab: draft.openLinksInNewTab,
  };
  const parsed = GeneralSettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) {
        errors[key as keyof GeneralSettings] = key === 'userName' ? 'Keep your name to 64 characters or fewer.' : issue.message;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

export default function GeneralSettingsSection() {
  const settings = useSettings();
  if (settings.data === undefined) {
    return settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <SkeletonLines lines={6} />;
  }
  return <GeneralForm saved={settings.data.general} />;
}

const NAME_TOO_LONG = 'Keep your name to 64 characters or fewer.';
const BAD_LOCALE = 'Enter a language tag such as en-US, de or pt-BR.';

/** A valid, canonical language tag (fr-ca → fr-CA), or null. */
export function canonicalLocale(tag: string): string | null {
  const text = tag.trim();
  if (!LocaleSchema.safeParse(text).success) return null;
  if (text === 'system') return text;
  try {
    return Intl.getCanonicalLocales(text)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every control saves on its own (UX-5), like Appearance: choices right away, the text fields
 * when they lose focus, on Enter, and when the section is left — nothing typed is lost by
 * switching sections, and there is no Save button to forget.
 */
function GeneralForm({ saved }: { saved: GeneralSettings }) {
  const autosave = useSettingsAutosave(300);
  const knownLocale = saved.locale === 'system' || COMMON_LOCALES.some((l) => l.value === saved.locale);
  const [name, setName] = useState(saved.userName ?? '');
  const [nameError, setNameError] = useState<string | undefined>();
  const [localeChoice, setLocaleChoice] = useState(knownLocale ? saved.locale : OTHER);
  const [customLocale, setCustomLocale] = useState(knownLocale ? '' : saved.locale);
  const [localeError, setLocaleError] = useState<string | undefined>();
  const [lastSaved, setLastSaved] = useState(false);
  const now = useNow(60_000);

  const save = (general: NonNullable<SettingsPatch['general']>) => {
    autosave.save({ general });
    setLastSaved(true);
  };

  // The latest text-field state, for the "leaving the section" save below.
  const latest = useRef({ name, customLocale, localeChoice, saved });
  latest.current = { name, customLocale, localeChoice, saved };

  const nameChange = (): { ok: boolean; patch?: { userName: string | null } } => {
    const { name: typed, saved: current } = latest.current;
    const trimmed = typed.trim();
    if (trimmed.length > 64) return { ok: false };
    return trimmed === (current.userName ?? '') ? { ok: true } : { ok: true, patch: { userName: trimmed || null } };
  };

  const localeChange = (): { ok: boolean; patch?: { locale: string } } => {
    const { customLocale: typed, localeChoice: choice, saved: current } = latest.current;
    if (choice !== OTHER) return { ok: true };
    const locale = canonicalLocale(typed);
    if (locale === null) return { ok: false };
    return locale === current.locale ? { ok: true } : { ok: true, patch: { locale } };
  };

  const commitName = () => {
    const result = nameChange();
    setNameError(result.ok ? undefined : NAME_TOO_LONG);
    if (result.patch) save(result.patch);
  };

  const commitLocale = () => {
    const result = localeChange();
    setLocaleError(result.ok ? undefined : BAD_LOCALE);
    if (result.patch) save(result.patch);
  };

  // Leaving the section (or Settings) saves valid text that was typed but not yet committed.
  useEffect(
    () => () => {
      const pending = { ...nameChange().patch, ...localeChange().patch };
      if (Object.keys(pending).length > 0) autosave.save({ general: pending });
      autosave.flush();
    },
    // Runs once, on unmount: the helpers read the latest values from refs.
    [],
  );

  const onEnter = (commit: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
  };

  const previewLocale = localeChoice === OTHER ? (canonicalLocale(customLocale) ?? saved.locale) : localeChoice;
  const fmt = createFormatters({
    locale: LocaleSchema.safeParse(previewLocale).success ? previewLocale : 'system',
    timeFormat: saved.timeFormat,
    weekStartsOn: saved.weekStartsOn,
  });

  const weekStart = <WeekStartSelect value={saved.weekStartsOn} onChange={(v) => save({ weekStartsOn: v })} />;

  return (
    <form className={styles.stack} onSubmit={(event) => event.preventDefault()} noValidate aria-label="General settings">
      <SettingsCard title="You" description="Used for the greeting on the clock widget.">
        <Field label="Your name" error={nameError}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (nameError && event.currentTarget.value.trim().length <= 64) setNameError(undefined);
            }}
            onBlur={commitName}
            onKeyDown={onEnter(commitName)}
            placeholder="e.g. Alex"
            autoComplete="given-name"
            maxLength={80}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title="Language, date and time" description="How dates, times and numbers are written across your widgets.">
        <FieldGrid>
          <Field label="Language and region">
            <Select
              value={localeChoice}
              onChange={(event) => {
                const choice = event.currentTarget.value;
                setLocaleChoice(choice);
                setLocaleError(undefined);
                if (choice !== OTHER && choice !== saved.locale) save({ locale: choice });
              }}
            >
              <option value="system">Browser default</option>
              {COMMON_LOCALES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </Select>
          </Field>
          {localeChoice === OTHER ? (
            <Field label="Language tag" help="A BCP 47 tag, for example en-IE or fr-CA." error={localeError} required>
              <Input
                value={customLocale}
                onChange={(event) => {
                  setCustomLocale(event.currentTarget.value);
                  if (localeError && canonicalLocale(event.currentTarget.value) !== null) setLocaleError(undefined);
                }}
                onBlur={commitLocale}
                onKeyDown={onEnter(commitLocale)}
                placeholder="en-IE"
                spellCheck={false}
                autoCapitalize="off"
                maxLength={35}
              />
            </Field>
          ) : (
            <Field label="Week starts on">{weekStart}</Field>
          )}
        </FieldGrid>
        {localeChoice === OTHER ? <Field label="Week starts on">{weekStart}</Field> : null}
        <Field label="Time format">
          <SegmentedControl
            value={saved.timeFormat}
            onValueChange={(v) => save({ timeFormat: v })}
            options={[
              { value: 'system', label: 'Automatic' },
              { value: '12h', label: '12-hour' },
              { value: '24h', label: '24-hour' },
            ]}
          />
        </Field>
        <p className={styles.preview} aria-live="polite">
          Preview: <strong>{fmt.date(now, 'full')}</strong> · <strong>{fmt.time(now)}</strong>
        </p>
      </SettingsCard>

      <SettingsCard title="Units" description="Used by the weather widget unless a widget overrides them.">
        <FieldGrid>
          <Field label="Temperature">
            <SegmentedControl
              value={saved.temperatureUnit}
              onValueChange={(v) => save({ temperatureUnit: v })}
              options={[
                { value: 'C', label: '°C' },
                { value: 'F', label: '°F' },
              ]}
            />
          </Field>
          <Field label="Wind speed">
            <SegmentedControl
              value={saved.windUnit}
              onValueChange={(v) => save({ windUnit: v })}
              options={[
                { value: 'kmh', label: 'km/h' },
                { value: 'mph', label: 'mph' },
                { value: 'ms', label: 'm/s' },
              ]}
            />
          </Field>
          <Field label="Precipitation">
            <SegmentedControl
              value={saved.precipUnit}
              onValueChange={(v) => save({ precipUnit: v })}
              options={[
                { value: 'mm', label: 'mm' },
                { value: 'in', label: 'in' },
              ]}
            />
          </Field>
        </FieldGrid>
      </SettingsCard>

      <SettingsCard title="Links">
        <Switch
          label="Open bookmarks and searches in a new tab"
          description="When off, the launch pad and search open pages in this tab (Ctrl+click still opens a new tab)."
          checked={saved.openLinksInNewTab}
          onCheckedChange={(v) => save({ openLinksInNewTab: v })}
        />
      </SettingsCard>

      <p className={styles.autosaveStatus} role="status">
        {autosave.saving ? 'Saving…' : lastSaved ? 'Changes saved.' : 'Changes are saved automatically.'}
      </p>
    </form>
  );
}

function WeekStartSelect({ value, onChange }: { value: 0 | 1 | 6; onChange(value: 0 | 1 | 6): void }) {
  return (
    <Select
      value={String(value)}
      onChange={(event) => {
        const next = Number(event.currentTarget.value);
        if (next === 0 || next === 1 || next === 6) onChange(next);
      }}
    >
      <option value="1">Monday</option>
      <option value="0">Sunday</option>
      <option value="6">Saturday</option>
    </Select>
  );
}
