/**
 * App shell: header (profile switcher, edit toggle, Add widget, shortcuts, settings), status
 * banners, the current route (dashboard grid or settings), and the footer (links, version and, in
 * the Pages build, the local server indicator, loaded on its own so the server build's bundle never
 * carries it). An "Add this page" request (`#/add-bookmark?url&title`, from the browser
 * extension's toolbar button) opens the Add bookmark dialog over the dashboard. Global hotkeys (§10.6): `e` toggles edit mode, `Esc` leaves it, `/` focuses search,
 * `?` opens the shortcut help.
 */
import { Suspense, lazy, useEffect, useState } from 'react';
import { Keyboard, Pencil, Plus, Settings as SettingsIcon } from 'lucide-react';
import { getCapabilities } from '../capabilities.ts';
import { Dashboard } from '../grid/Dashboard.tsx';
import { EditModeProvider, useEditMode } from '../grid/editMode.tsx';
import { focusSearchInput, useHotkey } from '../lib/hotkeys.ts';
import { SettingsShell } from '../settings/SettingsShell.tsx';
import { BrandMark } from '../ui/BrandMark.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { clearAddBookmarkRequest, parseAddBookmarkRequest, type AddBookmarkRequest } from '../widgets/launchpad/addRequest.ts';
import { Tooltip } from '../ui/Tooltip.tsx';
import { Footer } from './Footer.tsx';
import { ProfileSwitcher } from './ProfileSwitcher.tsx';
import { APP_VERSION } from './providers.tsx';
import { routeHref, useRoute } from './router.ts';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { StatusBanners } from './StatusBanners.tsx';
import styles from './Shell.module.css';
import { toast } from '../ui/toast.ts';

const AddPageDialog = lazy(() => import('../widgets/launchpad/AddPageDialog.tsx'));
const LocalServerStatus = lazy(() => import('./LocalServerStatus.tsx').then((m) => ({ default: m.LocalServerStatus })));

export function Shell() {
  return (
    <EditModeProvider>
      <ShellLayout />
    </EditModeProvider>
  );
}

function ShellLayout() {
  const route = useRoute();
  const onDashboard = route.name === 'home';
  const { editMode, canEdit, disabledReason, toggleEditMode, setEditMode, setAddWidgetOpen } = useEditMode();
  const [helpOpen, setHelpOpen] = useState(false);
  // Each press of the lighthouse makes its light go round once.
  const [beaconTurn, setBeaconTurn] = useState(0);
  const addRequest = useAddBookmarkRequest();

  useHotkey('e', toggleEditMode, { enabled: onDashboard && canEdit });
  useHotkey('Escape', () => setEditMode(false), { enabled: onDashboard && editMode, preventDefault: false });
  // Only swallow "/" when there is a search box to focus (it is the browser's quick find otherwise).
  useHotkey(
    '/',
    (event) => {
      if (focusSearchInput()) event.preventDefault();
    },
    { enabled: onDashboard, preventDefault: false },
  );
  useHotkey('?', () => setHelpOpen(true));

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <nav className={styles.group} aria-label="Dashboard">
          <Tooltip content="Dashboard">
            <a
              className={styles.brandHome}
              href={routeHref({ name: 'home' })}
              aria-label="Portly dashboard"
              aria-current={onDashboard ? 'page' : undefined}
              onClick={() => setBeaconTurn((n) => n + 1)}
            >
              <BrandMark size={36} turn={beaconTurn} />
            </a>
          </Tooltip>
          {onDashboard ? <ProfileSwitcher /> : null}
        </nav>
        <div className={styles.group}>
          {onDashboard && editMode ? (
            <button type="button" className={styles.chip} onClick={() => setAddWidgetOpen(true)}>
              <Plus aria-hidden="true" className={styles.chipIcon} />
              <span className={styles.chipText}>Add widget</span>
            </button>
          ) : null}
          {onDashboard ? (
            <Tooltip content={canEdit ? (editMode ? 'Done editing (E)' : 'Edit layout (E)') : (disabledReason ?? 'Editing unavailable')}>
              <button
                type="button"
                className={styles.iconChip}
                aria-label="Edit layout"
                aria-pressed={editMode}
                aria-disabled={!canEdit || undefined}
                aria-describedby={canEdit ? undefined : 'hb-edit-unavailable'}
                onClick={() => {
                  if (canEdit) toggleEditMode();
                  // A tap on a phone shows no tooltip: say why nothing happens.
                  else toast.info(disabledReason ?? 'Editing is unavailable right now');
                }}
              >
                <Pencil aria-hidden="true" />
                {canEdit ? null : (
                  <span id="hb-edit-unavailable" className="hb-visually-hidden">
                    {disabledReason ?? 'Editing is unavailable right now'}
                  </span>
                )}
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content="Keyboard shortcuts (?)">
            <button type="button" className={styles.iconChip} aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
              <Keyboard aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content="Settings">
            <a
              className={styles.iconChip}
              href={routeHref({ name: 'settings', section: 'general' })}
              aria-label="Settings"
              aria-current={route.name === 'settings' ? 'page' : undefined}
            >
              <SettingsIcon aria-hidden="true" />
            </a>
          </Tooltip>
        </div>
      </header>
      <StatusBanners onAccountsPage={route.name === 'settings' && route.section === 'accounts'} />
      <main className={styles.main}>{route.name === 'settings' ? <SettingsShell section={route.section} /> : <Dashboard />}</main>
      <Footer
        version={APP_VERSION}
        onShowShortcuts={() => setHelpOpen(true)}
        // The indicator follows the local server store itself (and renders nothing while hybrid mode
        // is off). If its code cannot be loaded, only the indicator is missing, not the page.
        serverStatus={
          getCapabilities().pagesBuild ? (
            <ErrorBoundary fallback={() => null}>
              <Suspense fallback={null}>
                <LocalServerStatus />
              </Suspense>
            </ErrorBoundary>
          ) : undefined
        }
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {addRequest.request ? (
        <ErrorBoundary fallback={() => null}>
          <Suspense fallback={null}>
            <AddPageDialog key={addRequest.key} request={addRequest.request} onDone={addRequest.done} />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </div>
  );
}

/**
 * The pending "Add this page" request: read from the address when the page loads and whenever the
 * hash changes to a new one. It stays in the address until the dialog closes, so a reload before
 * then (a backend switch, say) asks again.
 */
function useAddBookmarkRequest(): { request: AddBookmarkRequest | null; key: number; done: () => void } {
  const [state, setState] = useState(() => ({ request: parseAddBookmarkRequest(window.location.hash), key: 0 }));
  useEffect(() => {
    const onChange = () => {
      const request = parseAddBookmarkRequest(window.location.hash);
      if (request) setState((current) => ({ request, key: current.key + 1 }));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const done = () => {
    clearAddBookmarkRequest();
    setState((current) => ({ request: null, key: current.key }));
  };
  return { ...state, done };
}
