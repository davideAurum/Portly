/**
 * Todoist widget (§10.8 Todoist, §10.7): tasks of a Todoist filter with natural-language quick
 * add, one-click completion with Undo, due / priority / project / label chips and a sort menu.
 *
 * - Filter: the widget's own `config.filter`, else `settings.todoist.defaultFilter`. Filter edits
 *   (the settings dialog previews live) settle for a moment before a request goes out.
 * - Completing is optimistic: a normal task disappears at once and an Undo toast reopens it; a
 *   recurring task stays and is refetched with its next date (Todoist advances it upstream).
 * - Content is shown as plain text (markdown links → their label, never HTML); the task opens in
 *   Todoist through `safeHref`.
 * - Not set up → CTA to Todoist in Settings → Accounts (`#/settings/accounts?focus=todoist`); token
 *   rejected → the same CTA; vault locked → Accounts.
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  CircleCheckBig,
  ExternalLink as ExternalLinkIcon,
  FunnelX,
  KeyRound,
  Plus,
  RefreshCw,
  Repeat,
  Settings2,
  Tag,
} from 'lucide-react';
import { DEFAULT_TODOIST_FILTER, type Project, type Task } from '@portly/shared';
import { ApiError, isApiError } from '../../api/client.ts';
import { qk } from '../../api/keys.ts';
import { useSettings } from '../../api/settings.ts';
import { useQuickAddTask, useTaskActions, useTodoistProjects, useTodoistTasks, useTodoistToken } from '../../api/todoist.ts';
import { WidgetActions, useWidgetFrame } from '../../grid/WidgetContext.tsx';
import { safeColor } from '../../lib/color.ts';
import { useFormatters, type Formatters } from '../../lib/format.ts';
import { linkProps, openUrl, safeHref } from '../../lib/openUrl.ts';
import { useNow } from '../../lib/useNow.ts';
import { Button, IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { ErrorState, StaleIndicator } from '../../ui/ErrorState.tsx';
import { Input } from '../../ui/Input.tsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../../ui/Menu.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { Spinner } from '../../ui/Spinner.tsx';
import { errorMessage, toast, toastError, toastUndo } from '../../ui/toast.ts';
import type { WidgetProps } from '../types.ts';
import type { TodoistConfig } from './index.ts';
import {
  descriptionPreview,
  dueStatus,
  formatDue,
  listTitle,
  plainTaskText,
  priorityLabel,
  sortTasks,
  type TaskSort,
} from './model.ts';
import styles from './Todoist.module.css';

export const TODOIST_APP_URL = 'https://app.todoist.com/app/today';
/** Todoist in Settings → Accounts: its connect dialog, or its Manage dialog (token, default filter) once connected. */
export const SETTINGS_ROUTE = '#/settings/accounts?focus=todoist';
/** How long a changed filter must stay unchanged before it is fetched (live settings preview). */
export const FILTER_SETTLE_MS = 600;

const SORT_OPTIONS: readonly { value: TaskSort; label: string }[] = [
  { value: 'todoist', label: 'Todoist order' },
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
];

/** `value`, but changes only take effect after `delayMs` without further changes (null → value is immediate). */
function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    if (settled === null) {
      setSettled(value);
      return;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);
  return settled;
}

function shorten(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Shown (without asking for tasks) while the persisted token status says Todoist is not connected. */
const NOT_CONNECTED = new ApiError(409, 'not_configured', 'Todoist is not connected yet');

export default function TodoistWidget({ config, setConfig, size }: WidgetProps<TodoistConfig>) {
  const settings = useSettings();
  const own = config.filter.trim();
  const fallback = settings.data?.todoist.defaultFilter ?? (settings.isError ? DEFAULT_TODOIST_FILTER : null);
  const filter = useSettledValue<string | null>(own || fallback, FILTER_SETTLE_MS);
  // Known not to be connected: no tasks request (it could only answer 409), no skeleton.
  const token = useTodoistToken();
  const notConnected = token.data?.configured === false;
  const tasks = useTodoistTasks(notConnected ? null : filter);
  const compact = size.h <= 3 || size.w <= 3;

  const sorted = useMemo(() => (tasks.data ? sortTasks(tasks.data, config.sort) : []), [tasks.data, config.sort]);

  if (notConnected) {
    return (
      <div className={styles.root}>
        <TasksError error={NOT_CONNECTED} onRetry={() => void token.refetch()} compact={compact} ownFilter={own !== ''} />
      </div>
    );
  }

  // Setup problems can't fix themselves: show them instead of a stale list.
  const blocked = tasks.isError && (isApiError(tasks.error, 'not_configured') || isApiError(tasks.error, 'reauth_required'));

  if (filter === null || tasks.data === undefined || blocked) {
    return (
      <div className={styles.root}>
        {tasks.isError ? (
          <TasksError error={tasks.error} onRetry={() => void tasks.refetch()} compact={compact} ownFilter={own !== ''} />
        ) : (
          <SkeletonList rows={Math.max(1, Math.min(5, size.h - 2))} />
        )}
      </div>
    );
  }

  const actions = (
    <WidgetActions>
      {tasks.isError ? (
        <StaleIndicator updatedAt={tasks.dataUpdatedAt} error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <IconButton icon={ArrowUpDown} size="sm" tooltip={false} aria-label="Sort and task options" />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuLabel>Sort by</MenuLabel>
          <MenuRadioGroup
            value={config.sort}
            onValueChange={(next) => {
              const option = SORT_OPTIONS.find((o) => o.value === next);
              if (option) void setConfig({ sort: option.value });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={<RefreshCw aria-hidden="true" />} onSelect={() => void tasks.refetch()}>
            Refresh
          </MenuItem>
          <MenuItem icon={<ExternalLinkIcon aria-hidden="true" />} onSelect={() => void openUrl(TODOIST_APP_URL)}>
            Open Todoist
          </MenuItem>
        </MenuContent>
      </Menu>
    </WidgetActions>
  );

  return (
    <div className={styles.root}>
      {actions}
      <div className={styles.top}>
        {compact ? null : (
          <div className={styles.heading}>
            <h3 className={styles.title} title={filter}>
              {listTitle(config.title, filter)}
            </h3>
            <span className={styles.count} aria-label={`${sorted.length} ${sorted.length === 1 ? 'task' : 'tasks'}`}>
              {sorted.length}
            </span>
          </div>
        )}
        <QuickAdd filter={filter} />
      </div>
      {sorted.length === 0 ? (
        <div className={styles.state}>
          <EmptyState icon={CircleCheckBig} title="All clear" body={`Nothing matches “${filter}”.`} compact={compact} />
        </div>
      ) : (
        <TaskList tasks={sorted} filter={filter} showProject={config.showProject} showDue={config.showDue} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

interface TasksErrorProps {
  error: unknown;
  onRetry: () => void;
  compact: boolean;
  /** The widget has its own filter (else it uses the default filter, set under Todoist in Settings → Accounts). */
  ownFilter: boolean;
}

function TasksError({ error, onRetry, compact, ownFilter }: TasksErrorProps) {
  const frame = useWidgetFrame();
  // Todoist can't parse the filter: retrying won't help, editing the filter will.
  if (isApiError(error, 'validation_failed') && (error.details as { reason?: unknown } | undefined)?.reason === 'invalid_filter') {
    const settingsHref = safeHref(SETTINGS_ROUTE);
    let action: ReactNode;
    if (ownFilter && frame.canOpenSettings) {
      action = (
        <Button size="sm" icon={Settings2} onClick={() => frame.openSettings()}>
          Edit filter
        </Button>
      );
    } else if (!ownFilter && settingsHref) {
      action = (
        <a className={styles.cta} href={settingsHref}>
          <Settings2 aria-hidden="true" />
          Edit default filter
        </a>
      );
    }
    return (
      <div className={styles.state}>
        <EmptyState icon={FunnelX} compact={compact} title="Check the filter" body={errorMessage(error)} action={action} />
      </div>
    );
  }
  // The vault is locked (no account involved): the fix is in Settings → Accounts.
  if (isApiError(error, 'reauth_required') && !error.accountId) {
    const href = safeHref('#/settings/accounts');
    return (
      <div className={styles.state}>
        <EmptyState
          icon={KeyRound}
          compact={compact}
          title="Saved credentials are locked"
          body="Portly can't unlock its stored credentials. Reset them in Settings → Accounts, then add your Todoist token again."
          action={
            href ? (
              <a className={styles.cta} href={href}>
                <KeyRound aria-hidden="true" />
                Open settings
              </a>
            ) : undefined
          }
        />
      </div>
    );
  }
  let title: string | undefined;
  if (isApiError(error, 'not_configured')) {
    const details = error.details as { reason?: unknown } | undefined;
    title = details?.reason === 'token_rejected' ? 'Todoist token rejected' : 'Connect Todoist';
  }
  return (
    <div className={styles.state}>
      <ErrorState error={error} onRetry={onRetry} setupHref={SETTINGS_ROUTE} setupLabel="Set up Todoist" title={title} compact={compact} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

function QuickAdd({ filter }: { filter: string }) {
  const add = useQuickAddTask();
  const client = useQueryClient();
  const fmt = useFormatters();
  const [text, setText] = useState('');
  const hintId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value === '' || add.isPending) return;
    try {
      const task = await add.mutateAsync(value);
      setText('');
      // The lists were refetched before mutateAsync resolved: is the new task in this one?
      const inList = task ? (client.getQueryData<Task[]>(qk.todoist.tasks(filter))?.some((t) => t.id === task.id) ?? false) : true;
      const details: string[] = [];
      if (task?.due) details.push(formatDue(task.due, new Date(), fmt));
      if (!inList) details.push("It doesn't match this list's filter.");
      const name = shorten(plainTaskText(task?.content ?? value));
      toast.success(`Added “${name}”`, details.length > 0 ? { description: details.join(' · ') } : undefined);
    } catch (error) {
      toastError(error, 'The task could not be added.');
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Quick add task">
      <Input
        size="sm"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && text !== '') {
            event.preventDefault();
            event.stopPropagation();
            setText('');
          }
        }}
        readOnly={add.isPending}
        placeholder="Add a task…"
        aria-label="Add a task"
        aria-describedby={hintId}
        maxLength={1000}
        enterKeyHint="done"
        autoComplete="off"
        spellCheck
        leading={<Plus aria-hidden="true" className={styles.quickIcon} />}
        trailing={add.isPending ? <Spinner size={14} label="Adding task" /> : null}
      />
      <span id={hintId} className="hb-visually-hidden">
        Press Enter to add. Todoist understands dates like “tomorrow 5pm”, #project, %label and priorities p1 to p4.
      </span>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

interface TaskListProps {
  tasks: Task[];
  filter: string;
  showProject: boolean;
  showDue: boolean;
}

function TaskList({ tasks, filter, showProject, showDue }: TaskListProps) {
  const client = useQueryClient();
  const actions = useTaskActions();
  const fmt = useFormatters();
  const now = useNow(60_000);
  const projects = useTodoistProjects(showProject);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const projectById = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data]);

  const mark = (id: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const complete = async (task: Task) => {
    if (pending.has(task.id)) return;
    mark(task.id, true);
    const name = shorten(plainTaskText(task.content));
    try {
      const result = await actions.complete(task);
      if (task.due?.isRecurring) {
        await result.refreshed;
        const next = client.getQueryData<Task[]>(qk.todoist.tasks(filter))?.find((t) => t.id === task.id)?.due;
        // Only a date that actually moved is the next one (a failed refetch leaves the old date).
        const moved = next && task.due && (next.date !== task.due.date || next.datetime !== task.due.datetime);
        toast.success(`Completed “${name}”`, {
          description: moved ? `Next: ${formatDue(next, new Date(), fmt)}` : 'It moves on to its next date.',
        });
      } else {
        toastUndo(`Completed “${name}”`, { onUndo: () => actions.undo(task, result) });
      }
    } catch (error) {
      toastError(error, 'The task could not be completed.');
    } finally {
      mark(task.id, false);
    }
  };

  return (
    <ul className={styles.list} aria-label="Tasks">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          project={showProject ? projectById.get(task.projectId) : undefined}
          showDue={showDue}
          now={now}
          fmt={fmt}
          pending={pending.has(task.id)}
          onComplete={(t) => void complete(t)}
        />
      ))}
    </ul>
  );
}

interface TaskRowProps {
  task: Task;
  project: Project | undefined;
  showDue: boolean;
  now: Date;
  fmt: Formatters;
  pending: boolean;
  onComplete(task: Task): void;
}

function TaskRow({ task, project, showDue, now, fmt, pending, onComplete }: TaskRowProps) {
  const text = plainTaskText(task.content).trim() || 'Untitled task';
  const description = descriptionPreview(task.description);
  const link = linkProps(task.url);
  const status = task.due ? dueStatus(task.due, now) : null;
  const projectColor = project ? safeColor(project.color) : null;

  return (
    <li className={styles.item}>
      <div className={styles.task} data-done={pending ? 'true' : undefined}>
        <button
          type="button"
          role="checkbox"
          aria-checked={pending}
          aria-label={`Complete “${text}”`}
          className={styles.check}
          data-priority={task.priority}
          disabled={pending}
          onClick={() => onComplete(task)}
        >
          <Check aria-hidden="true" />
        </button>
        <div className={styles.main}>
          {link ? (
            <a {...link} className={styles.content}>
              {text}
              <span className="hb-visually-hidden"> (open in Todoist)</span>
            </a>
          ) : (
            <span className={styles.content}>{text}</span>
          )}
          {description ? <p className={styles.description}>{description}</p> : null}
          <div className={styles.meta}>
            {task.priority > 1 ? <span className="hb-visually-hidden">{priorityLabel(task.priority)}</span> : null}
            {showDue && task.due && status ? (
              <span className={`${styles.chip} ${styles.due}`} data-status={status} title={task.due.string || undefined}>
                <CalendarDays aria-hidden="true" />
                <span className={styles.chipText}>
                  {status === 'overdue' ? <span className="hb-visually-hidden">Overdue: </span> : null}
                  {formatDue(task.due, now, fmt)}
                </span>
                {task.due.isRecurring ? (
                  <>
                    <Repeat aria-hidden="true" className={styles.recurring} />
                    <span className="hb-visually-hidden">, repeats</span>
                  </>
                ) : null}
              </span>
            ) : null}
            {project ? (
              <span className={`${styles.chip} ${styles.project}`}>
                <span className={styles.projectDot} style={projectColor ? { backgroundColor: projectColor } : undefined} aria-hidden="true" />
                <span className={styles.chipText}>{project.name}</span>
              </span>
            ) : null}
            {task.labels.map((label) => (
              <span key={label} className={`${styles.chip} ${styles.label}`}>
                <Tag aria-hidden="true" />
                <span className={styles.chipText}>{label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}
