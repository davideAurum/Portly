/**
 * Profiles (§1, §7 Core): named layouts switched manually. Create (empty, a copy of another
 * profile, or the default layout), rename, reorder, activate and delete.
 */
import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Layers, Pencil, Plus, Trash } from 'lucide-react';
import { ProfileNameSchema, newId, type Profile, type ProfileCreate } from '@homebase/shared';
import {
  pickActiveProfile,
  sortProfiles,
  useActivateProfile,
  useCreateProfile,
  useDeleteProfile,
  useProfiles,
  useReorderProfiles,
  useUpdateProfile,
} from '../../api/profiles.ts';
import { useSettings } from '../../api/settings.ts';
import { createDefaultLayout } from '../../grid/defaultLayout.ts';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/Dialog.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState } from '../../ui/ErrorState.tsx';
import { Field } from '../../ui/Field.tsx';
import { Input, Select } from '../../ui/Input.tsx';
import { FieldGrid, FormFooter, SettingsCard } from '../../ui/Section.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { toast } from '../../ui/toast.ts';
import styles from '../../styles/settings.module.css';

const NAME_ERROR = 'Use 1–64 characters.';

function widgetCount(profile: Profile): string {
  const n = profile.layout.items.length;
  return n === 1 ? '1 widget' : `${n} widgets`;
}

export default function ProfilesSettings() {
  const profiles = useProfiles();
  const settings = useSettings();
  if (profiles.data === undefined) {
    return profiles.isError ? <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} /> : <SkeletonList rows={3} />;
  }
  const list = sortProfiles(profiles.data);
  const active = pickActiveProfile(list, settings.data?.activeProfileId ?? null);
  return (
    <div className={styles.stack}>
      <p className={styles.intro}>
        A profile is a named dashboard layout — for example “Home” and “Work”. Switch between them from the menu at the top of
        the dashboard.
      </p>
      <SettingsCard title="Your profiles">
        {list.length === 0 ? (
          <EmptyState icon={Layers} title="No profiles yet" body="Your first profile is created when the dashboard loads." />
        ) : (
          <ul className={styles.list} aria-label="Profiles">
            {list.map((profile, index) => (
              <li key={profile.id}>
                <ProfileRow profile={profile} list={list} index={index} active={profile.id === active?.id} />
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <CreateProfileForm profiles={list} activeId={active?.id ?? null} />
    </div>
  );
}

function ProfileRow({ profile, list, index, active }: { profile: Profile; list: Profile[]; index: number; active: boolean }) {
  const update = useUpdateProfile();
  const reorder = useReorderProfiles();
  const remove = useDeleteProfile();
  const activate = useActivateProfile();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const move = (delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate(next);
  };

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    const parsed = ProfileNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(NAME_ERROR);
      return;
    }
    setError(null);
    setRenaming(false);
    if (parsed.data !== profile.name) update.mutate({ id: profile.id, name: parsed.data });
  };

  return (
    <div className={styles.listItem}>
      <div className={styles.grow}>
        {renaming ? (
          <form className={styles.inlineRow} onSubmit={saveName} aria-label={`Rename ${profile.name}`}>
            <Field label="Profile name" hideLabel error={error}>
              <Input
                size="sm"
                value={name}
                autoFocus
                maxLength={80}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenaming(false);
                    setName(profile.name);
                    setError(null);
                  }
                }}
              />
            </Field>
            <Button size="sm" type="submit" variant="primary">
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setName(profile.name);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className={styles.inlineRow}>
            <span className={styles.itemTitle}>{profile.name}</span>
            {active ? (
              <Badge tone="accent" icon={Check}>
                Active
              </Badge>
            ) : null}
          </div>
        )}
        <span className={styles.itemMeta}>{widgetCount(profile)}</span>
      </div>
      <div className={styles.itemActions}>
        {active ? null : (
          <Button size="sm" variant="ghost" onClick={() => activate.mutate(profile.id)} loading={activate.isPending}>
            Make active
          </Button>
        )}
        <IconButton
          icon={Pencil}
          size="sm"
          aria-label={`Rename ${profile.name}`}
          onClick={() => {
            setName(profile.name);
            setRenaming(true);
          }}
        />
        <IconButton icon={ArrowUp} size="sm" aria-label={`Move ${profile.name} up`} disabled={index === 0} onClick={() => move(-1)} />
        <IconButton
          icon={ArrowDown}
          size="sm"
          aria-label={`Move ${profile.name} down`}
          disabled={index === list.length - 1}
          onClick={() => move(1)}
        />
        <IconButton
          icon={Trash}
          size="sm"
          aria-label={`Delete ${profile.name}`}
          disabled={list.length <= 1}
          tooltip={list.length <= 1 ? 'The last profile cannot be deleted' : undefined}
          onClick={() => setConfirmDelete(true)}
        />
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${profile.name}?`}
        description={`Its layout and ${widgetCount(profile)} with their settings are deleted. Bookmarks, accounts and other data are not affected.`}
        confirmLabel="Delete profile"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(profile.id);
          toast.success(`${profile.name} deleted.`);
        }}
      />
    </div>
  );
}

type StartFrom = 'empty' | 'default' | `copy:${string}`;

function CreateProfileForm({ profiles, activeId }: { profiles: Profile[]; activeId: string | null }) {
  const create = useCreateProfile();
  const activate = useActivateProfile();
  const [name, setName] = useState('');
  const [chosen, setStartFrom] = useState<StartFrom>(activeId ? `copy:${activeId}` : 'default');
  // A profile picked as the source may have been deleted since.
  const startFrom: StartFrom = chosen.startsWith('copy:') && !profiles.some((p) => `copy:${p.id}` === chosen) ? 'default' : chosen;
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = ProfileNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(NAME_ERROR);
      return;
    }
    if (profiles.some((p) => p.name.toLocaleLowerCase() === parsed.data.toLocaleLowerCase())) {
      setError('A profile with this name already exists.');
      return;
    }
    setError(null);
    const body: ProfileCreate = { name: parsed.data };
    if (startFrom === 'default') body.layout = createDefaultLayout(() => newId());
    else if (startFrom.startsWith('copy:')) body.copyFromId = startFrom.slice(5);
    try {
      const created = await create.mutateAsync(body);
      setName('');
      toast.success(`${parsed.data} created.`, {
        action: created ? { label: 'Switch to it', onClick: () => activate.mutate(created.id) } : undefined,
      });
    } catch {
      // useCreateProfile shows the error.
    }
  };

  return (
    <SettingsCard title="New profile">
      <form className={styles.formGrid} onSubmit={(event) => void submit(event)} noValidate aria-label="Create a profile">
        <FieldGrid>
          <Field label="Name" error={error} required>
            <Input
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setError(null);
              }}
              placeholder="Work"
              maxLength={80}
            />
          </Field>
          <Field label="Start from">
            <Select value={startFrom} onChange={(event) => setStartFrom(event.currentTarget.value as StartFrom)}>
              <option value="default">The default layout</option>
              <option value="empty">An empty dashboard</option>
              {profiles.map((p) => (
                <option key={p.id} value={`copy:${p.id}`}>
                  A copy of {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </FieldGrid>
        <FormFooter>
          <Button type="submit" variant="primary" icon={Plus} loading={create.isPending}>
            Create profile
          </Button>
        </FormFooter>
      </form>
    </SettingsCard>
  );
}
