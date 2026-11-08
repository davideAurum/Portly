/**
 * Mail widget (§10.8): total unread in the header; recent messages merged newest-first or grouped
 * by account; rows with the account color, sender, subject, snippet (when the provider has one),
 * relative time and unread weight. Hover/focus actions: read/unread (toast + Undo), archive (when
 * the account supports it) and trash — all optimistic. With several accounts a collapsible left
 * sidebar lists them with visibility switches (`hiddenAccountIds`, `sidebarCollapsed` in config). A row opens the message (or the account's
 * webmail) in a new tab through `safeHref`. Accounts that fail show their own error row
 * (Reconnect for `reauth_required`); no mail account at all → a CTA to Settings › Accounts.
 * Everything provider-supplied is rendered as plain React text. An account whose error changes is
 * recorded as a `widget` diagnostic event (`diagnostics.ts`), from answers fetched in this page
 * load only (a restored cache only repeats an old state).
 */
import { useEffect, useId, useMemo } from 'react';
import {
  Archive,
  CircleAlert,
  ExternalLink as ExternalLinkIcon,
  Mail,
  MailCheck,
  MailOpen,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  Trash2,
  Unplug,
} from 'lucide-react';
import type { MailAccountSummary } from '@portly/shared';
import { isApiError } from '../../api/client.ts';
import { useAccounts } from '../../api/accounts.ts';
import { useMailActions, useMailSummary, type MailActionInput, type MailSummaryParams } from '../../api/mail.ts';
import { useWidgetFrame, WidgetActions } from '../../grid/WidgetContext.tsx';
import { linkProps } from '../../lib/openUrl.ts';
import { accountColor } from '../../ui/accounts/AccountBadge.tsx';
import { ReconnectButton } from '../../ui/accounts/ReconnectButton.tsx';
import { Badge } from '../../ui/Badge.tsx';
import { Button, IconButton } from '../../ui/Button.tsx';
import { EmptyState } from '../../ui/EmptyState.tsx';
import { QueryView, StaleIndicator, type QueryViewMeta } from '../../ui/ErrorState.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { SkeletonList } from '../../ui/Skeleton.tsx';
import { Switch } from '../../ui/Toggles.tsx';
import type { WidgetProps } from '../types.ts';
import { reportMailAccountErrors } from './diagnostics.ts';
import type { MailConfig } from './index.ts';
import {
  accountGroups,
  failedAccounts,
  mergedRows,
  rowHref,
  senderLabel,
  toggleHidden,
  totalUnread,
  visibleSummaries,
  type MailRow,
} from './view.ts';
import styles from './Mail.module.css';

type RunAction = (input: MailActionInput) => void;

function countLabel(n: number): string {
  return n > 999 ? '999+' : String(n);
}

export default function MailWidget({ config, setConfig, size }: WidgetProps<MailConfig>) {
  const frame = useWidgetFrame();
  // Short or narrow cards use the one-line states (DoD #5: renders at the 3×4 minimum).
  const compact = size.h <= 3 || size.w <= 3;
  const noneSelected = Array.isArray(config.accountIds) && config.accountIds.length === 0;
  const params = useMemo<MailSummaryParams>(
    () => ({ maxMessages: config.maxMessages, unreadOnly: config.unreadOnly, accountIds: config.accountIds }),
    [config.maxMessages, config.unreadOnly, config.accountIds],
  );
  // The (persisted) account list tells a new tab at once when there is no mail account at all,
  // so the summary is not requested (it could only answer 409) and no skeleton flashes.
  const accounts = useAccounts();
  const noMailAccount = accounts.data !== undefined && !accounts.data.some((a) => a.capabilities.includes('mail') && a.enabledCapabilities.includes('mail'));
  const query = useMailSummary(params, { enabled: !noneSelected && !noMailAccount });
  const { run } = useMailActions();
  const fetched = query.isFetchedAfterMount ? query.data : undefined;
  useEffect(() => {
    if (fetched !== undefined) reportMailAccountErrors(fetched);
  }, [fetched]);

  if (noMailAccount) return <NotConfigured compact={compact} />;
  if (noneSelected) return <NoAccountsSelected compact={compact} canOpenSettings={frame.canOpenSettings} openSettings={frame.openSettings} />;
  // No mail account at all (also when the last one was removed while data was cached).
  if (isApiError(query.error, 'not_configured')) return <NotConfigured compact={compact} />;

  return (
    <QueryView
      query={query}
      compact={compact}
      skeleton={<SkeletonList rows={Math.min(6, Math.max(2, size.h - 2))} />}
      setupHref="#/settings/accounts"
      setupLabel="Connect an account"
    >
      {(summaries, meta) =>
        summaries.length === 0 ? (
          <NoAccountsSelected compact={compact} canOpenSettings={frame.canOpenSettings} openSettings={frame.openSettings} />
        ) : (
          <MailContent summaries={summaries} config={config} meta={meta} run={run} compact={compact} setConfig={setConfig} />
        )
      }
    </QueryView>
  );
}

interface MailContentProps {
  summaries: MailAccountSummary[];
  config: MailConfig;
  meta: QueryViewMeta;
  run: RunAction;
  compact: boolean;
  setConfig: (patch: Partial<MailConfig>) => Promise<void>;
}

function MailContent({ summaries: all, config, meta, run, compact, setConfig }: MailContentProps) {
  const multi = all.length > 1;
  const summaries = multi ? visibleSummaries(all, config.hiddenAccountIds) : all;
  const showSidebar = multi && !compact;
  const body =
    summaries.length === 0 ? (
      <AllHidden compact={compact} onShowAll={() => void setConfig({ hiddenAccountIds: [] })} />
    ) : (
      <MailBody summaries={summaries} config={config} meta={meta} run={run} compact={compact} />
    );
  if (!showSidebar) return body;
  return (
    <div className={styles.shell}>
      <AccountSidebar
        summaries={all}
        hiddenIds={config.hiddenAccountIds}
        collapsed={config.sidebarCollapsed}
        onCollapsedChange={(sidebarCollapsed) => void setConfig({ sidebarCollapsed })}
        onVisibleChange={(accountId, visible) =>
          void setConfig({
            hiddenAccountIds: toggleHidden(
              config.hiddenAccountIds,
              accountId,
              visible,
              all.map((s) => s.accountId),
            ),
          })
        }
        onShowAll={() => void setConfig({ hiddenAccountIds: [] })}
      />
      <div className={styles.shellBody}>{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account sidebar
// ---------------------------------------------------------------------------

interface AccountSidebarProps {
  summaries: MailAccountSummary[];
  hiddenIds: readonly string[];
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onVisibleChange: (accountId: string, visible: boolean) => void;
  onShowAll: () => void;
}

function AccountSidebar({ summaries, hiddenIds, collapsed, onCollapsedChange, onVisibleChange, onShowAll }: AccountSidebarProps) {
  const listId = useId();
  const hidden = new Set(hiddenIds);
  const hiddenCount = summaries.filter((s) => hidden.has(s.accountId)).length;
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <nav className={styles.sidebar} data-collapsed={collapsed ? 'true' : undefined} aria-label="Mail accounts" data-no-grid-drag="">
      <div className={styles.sidebarHead}>
        {collapsed ? null : <span className={styles.sidebarTitle}>Accounts</span>}
        <IconButton
          size="sm"
          icon={ToggleIcon}
          aria-label={collapsed ? 'Expand account sidebar' : 'Collapse account sidebar'}
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => onCollapsedChange(!collapsed)}
        />
      </div>
      <ul id={listId} className={styles.sidebarList}>
        {summaries.map((summary) => {
          const visible = !hidden.has(summary.accountId);
          const color = accountColor({ id: summary.accountId, color: summary.color });
          const unread = !summary.error && summary.unread > 0 ? summary.unread : 0;
          return (
            <li key={summary.accountId} className={styles.sidebarItem} data-hidden={visible ? undefined : 'true'}>
              {collapsed ? (
                <button
                  type="button"
                  className={styles.railButton}
                  aria-pressed={visible}
                  aria-label={`${visible ? 'Hide' : 'Show'} ${summary.label}${unread > 0 ? `, ${unread} unread` : ''}`}
                  title={`${summary.label}${visible ? '' : ' (hidden)'}`}
                  onClick={() => onVisibleChange(summary.accountId, !visible)}
                >
                  <span className={styles.dot} style={{ backgroundColor: color }} aria-hidden="true" />
                </button>
              ) : (
                <>
                  <span className={styles.dot} style={{ backgroundColor: color }} aria-hidden="true" />
                  <span className={styles.sidebarLabel} title={summary.email ?? summary.label}>
                    {summary.label}
                  </span>
                  {summary.error ? <CircleAlert className={styles.sidebarWarn} aria-label="Has a problem" /> : null}
                  {unread > 0 ? (
                    <span className={styles.sidebarCount} title={`${unread} unread`}>
                      {countLabel(unread)}
                    </span>
                  ) : null}
                  <Switch
                    size="sm"
                    checked={visible}
                    onCheckedChange={(next) => onVisibleChange(summary.accountId, next)}
                    aria-label={`Show ${summary.label}`}
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && !collapsed ? (
        <Button size="sm" variant="ghost" onClick={onShowAll}>
          Show all
        </Button>
      ) : null}
    </nav>
  );
}

function AllHidden({ compact, onShowAll }: { compact: boolean; onShowAll: () => void }) {
  return (
    <EmptyState
      icon={Mail}
      compact={compact}
      title="All accounts hidden"
      body="Switch an account on in the sidebar to see its mail."
      action={
        <Button size="sm" onClick={onShowAll}>
          Show all
        </Button>
      }
    />
  );
}

function MailBody({ summaries, config, meta, run, compact }: Omit<MailContentProps, 'setConfig'>) {
  const total = totalUnread(summaries);
  const header = (
    <WidgetActions>
      <span className={styles.headerActions}>
        <StaleIndicator updatedAt={meta.updatedAt} error={meta.stale ? meta.error : undefined} onRetry={meta.refetch} />
        {total > 0 ? (
          <Badge tone="accent" title={`${total} unread`}>
            {countLabel(total)}
            <span className="hb-visually-hidden"> unread</span>
          </Badge>
        ) : null}
      </span>
    </WidgetActions>
  );

  if (config.grouping === 'byAccount') {
    return (
      <div className={styles.root}>
        {header}
        {accountGroups(summaries, config.maxMessages).map(({ summary, rows }) => (
          <AccountGroup key={summary.accountId} summary={summary} rows={rows} unreadOnly={config.unreadOnly} run={run} onRetry={meta.refetch} />
        ))}
      </div>
    );
  }

  const failed = failedAccounts(summaries);
  const rows = mergedRows(summaries, config.maxMessages);
  const multiAccount = summaries.length > 1;
  return (
    <div className={styles.root}>
      {header}
      {failed.length > 0 ? (
        <ul className={styles.notices} aria-label="Accounts with problems">
          {failed.map((summary) => (
            <li key={summary.accountId}>
              <AccountNotice summary={summary} onRetry={meta.refetch} />
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.list} aria-label="Recent messages">
          {rows.map((row) => (
            <MessageRow key={`${row.summary.accountId}:${row.message.id}`} row={row} run={run} showAccount={multiAccount} />
          ))}
        </ul>
      ) : failed.length < summaries.length ? (
        <div className={styles.fill}>
          <InboxEmpty unreadOnly={config.unreadOnly} compact={compact} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function MessageRow({ row, run, showAccount }: { row: MailRow; run: RunAction; showAccount: boolean }) {
  const { message, summary } = row;
  const sender = senderLabel(message.from);
  const subject = message.subject || '(no subject)';
  const color = accountColor({ id: summary.accountId, color: summary.color });
  const link = linkProps(rowHref(row));
  const act = (action: MailActionInput['action']) => run({ accountId: summary.accountId, messageId: message.id, action });

  const content = (
    <>
      <span className={styles.dot} style={{ backgroundColor: color }} title={showAccount ? summary.label : undefined} aria-hidden="true" />
      <span className={styles.main}>
        {/* The {' '} text nodes are ignored by flex/grid layout but separate words in the link's accessible name. */}
        <span className={styles.line1}>
          {message.unread ? (
            <>
              <span className="hb-visually-hidden">Unread,</span>{' '}
            </>
          ) : null}
          <span className={styles.sender} title={message.from.address || undefined}>
            {sender}
          </span>{' '}
          <RelativeTime className={styles.time} date={message.date} />
        </span>{' '}
        <span className={styles.line2}>
          <span className={[styles.subject, message.subject ? '' : styles.noSubject].filter(Boolean).join(' ')}>{subject}</span>
          {message.snippet ? (
            <>
              {' '}
              <span className={styles.snippet}>{message.snippet}</span>
            </>
          ) : null}
        </span>
        {showAccount ? <span className="hb-visually-hidden">, {summary.label}</span> : null}
      </span>
    </>
  );

  return (
    <li className={styles.row} data-unread={message.unread ? 'true' : undefined}>
      {link ? (
        <a className={styles.link} {...link}>
          {content}
        </a>
      ) : (
        <div className={styles.link}>{content}</div>
      )}
      <div className={styles.actions} role="group" aria-label={`Actions for "${subject}"`} data-no-grid-drag="">
        <IconButton
          size="sm"
          icon={message.unread ? MailOpen : Mail}
          aria-label={message.unread ? 'Mark as read' : 'Mark as unread'}
          onClick={() => act(message.unread ? 'read' : 'unread')}
        />
        {summary.canArchive ? <IconButton size="sm" icon={Archive} aria-label="Archive" onClick={() => act('archive')} /> : null}
        {/* §4.10: no resolvable trash target → no action (absent = available). */}
        {summary.canTrash !== false ? <IconButton size="sm" icon={Trash2} aria-label="Move to trash" onClick={() => act('trash')} /> : null}
      </div>
    </li>
  );
}

interface AccountGroupProps {
  summary: MailAccountSummary;
  rows: MailRow[];
  unreadOnly: boolean;
  run: RunAction;
  onRetry: () => void;
}

function AccountGroup({ summary, rows, unreadOnly, run, onRetry }: AccountGroupProps) {
  const headingId = useId();
  const webmail = linkProps(summary.webmailUrl);
  return (
    <section className={styles.group} aria-labelledby={headingId}>
      <header className={styles.groupHeader}>
        <span className={styles.dot} style={{ backgroundColor: accountColor({ id: summary.accountId, color: summary.color }) }} aria-hidden="true" />
        <h3 id={headingId} className={styles.groupTitle} title={summary.email ?? undefined}>
          {summary.label}
        </h3>
        {!summary.error && summary.unread > 0 ? (
          <Badge tone="accent" title={`${summary.unread} unread`}>
            {countLabel(summary.unread)}
            <span className="hb-visually-hidden"> unread</span>
          </Badge>
        ) : null}
        {webmail && webmail.href.startsWith('http') ? (
          <a className={styles.iconLink} {...webmail} aria-label={`Open ${summary.label} in webmail`} title="Open webmail">
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        ) : null}
      </header>
      {summary.error ? (
        <AccountNotice summary={summary} onRetry={onRetry} />
      ) : rows.length > 0 ? (
        <ul className={styles.list} aria-labelledby={headingId}>
          {rows.map((row) => (
            <MessageRow key={row.message.id} row={row} run={run} showAccount={false} />
          ))}
        </ul>
      ) : (
        <p className={styles.groupEmpty}>{unreadOnly ? 'No unread messages' : 'No messages'}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function AccountNotice({ summary, onRetry }: { summary: MailAccountSummary; onRetry: () => void }) {
  const error = summary.error;
  if (!error) return null;
  const reauth = error.code === 'reauth_required';
  const Icon = reauth ? Unplug : CircleAlert;
  return (
    <div className={styles.notice} data-tone={reauth ? undefined : 'danger'} data-testid="mail-account-error">
      <Icon className={styles.noticeIcon} aria-hidden="true" />
      <div className={styles.noticeText}>
        <strong>{summary.label}</strong>
        <span className={styles.noticeMessage}>{error.message}</span>
      </div>
      <div className={styles.noticeAction}>
        {reauth ? (
          <ReconnectButton accountId={summary.accountId} variant="secondary" />
        ) : (
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

function InboxEmpty({ unreadOnly, compact }: { unreadOnly: boolean; compact: boolean }) {
  return (
    <EmptyState
      icon={MailCheck}
      compact={compact}
      title={unreadOnly ? 'No unread mail' : 'Your inbox is empty'}
      body={unreadOnly ? "You're all caught up." : 'New messages will show up here.'}
    />
  );
}

function NotConfigured({ compact }: { compact: boolean }) {
  return (
    <EmptyState
      icon={Mail}
      compact={compact}
      title="Connect your mail"
      body="See unread counts and recent messages from Gmail, Outlook.com, Yahoo or any IMAP account."
      action={
        <a className={styles.setupLink} href="#/settings/accounts">
          <Settings2 aria-hidden="true" />
          Connect an account
        </a>
      }
    />
  );
}

function NoAccountsSelected({ compact, canOpenSettings, openSettings }: { compact: boolean; canOpenSettings: boolean; openSettings: () => void }) {
  return (
    <EmptyState
      icon={Mail}
      compact={compact}
      title="No accounts selected"
      body="Choose which mail accounts this widget shows."
      action={
        canOpenSettings ? (
          <Button size="sm" icon={Settings2} onClick={openSettings}>
            Choose accounts
          </Button>
        ) : undefined
      }
    />
  );
}
