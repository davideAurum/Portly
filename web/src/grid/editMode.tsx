/**
 * Dashboard edit state shared by the header (toggle, Add widget) and the grid: whether edit mode
 * is on, whether it is available (a saved profile, a wide enough screen) and the Add Widget
 * dialog. Edit mode is never persisted — every new tab starts in view mode.
 *
 * While edit mode is on, `<html data-homebase-editing="true">` says so to code outside React: the
 * local server controller (hybrid mode) does not reload the page for a backend switch while the
 * user is editing the layout.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface EditModeState {
  editMode: boolean;
  /** False when the layout cannot be edited (unsaved default layout, narrow screen). */
  canEdit: boolean;
  /** Why editing is unavailable (for the header tooltip). */
  disabledReason: string | null;
  setEditMode(on: boolean): void;
  toggleEditMode(): void;
  addWidgetOpen: boolean;
  setAddWidgetOpen(open: boolean): void;
  /** Called by the dashboard to report whether editing is possible. */
  setAvailability(canEdit: boolean, reason: string | null): void;
}

const EditModeContext = createContext<EditModeState | null>(null);

export function EditModeProvider({ children }: { children: ReactNode }) {
  const [requested, setRequested] = useState(false);
  const [addWidgetOpen, setAddWidgetOpenState] = useState(false);
  const [availability, setAvailabilityState] = useState<{ canEdit: boolean; reason: string | null }>({
    canEdit: false,
    reason: 'Loading…',
  });

  const setAvailability = useCallback((canEdit: boolean, reason: string | null) => {
    setAvailabilityState((prev) => (prev.canEdit === canEdit && prev.reason === reason ? prev : { canEdit, reason }));
    // Losing the ability to edit (e.g. the window became narrow) ends edit mode for good.
    if (!canEdit) {
      setRequested(false);
      setAddWidgetOpenState(false);
    }
  }, []);

  const editMode = requested && availability.canEdit;

  useEffect(() => {
    if (!editMode) return;
    const root = document.documentElement;
    root.dataset.homebaseEditing = 'true';
    return () => {
      delete root.dataset.homebaseEditing;
    };
  }, [editMode]);

  const setEditMode = useCallback((on: boolean) => {
    setRequested(on);
    if (!on) setAddWidgetOpenState(false);
  }, []);

  const toggleEditMode = useCallback(() => setEditMode(!editMode), [editMode, setEditMode]);

  const setAddWidgetOpen = useCallback((open: boolean) => {
    if (open) setRequested(true);
    setAddWidgetOpenState(open);
  }, []);

  const value = useMemo<EditModeState>(
    () => ({
      editMode,
      canEdit: availability.canEdit,
      disabledReason: availability.canEdit ? null : availability.reason,
      setEditMode,
      toggleEditMode,
      addWidgetOpen: addWidgetOpen && availability.canEdit,
      setAddWidgetOpen,
      setAvailability,
    }),
    [addWidgetOpen, availability, editMode, setAddWidgetOpen, setAvailability, setEditMode, toggleEditMode],
  );

  return <EditModeContext.Provider value={value}>{children}</EditModeContext.Provider>;
}

const NOOP_STATE: EditModeState = {
  editMode: false,
  canEdit: false,
  disabledReason: null,
  setEditMode: () => {},
  toggleEditMode: () => {},
  addWidgetOpen: false,
  setAddWidgetOpen: () => {},
  setAvailability: () => {},
};

/** The edit state (a read-only default outside the provider, e.g. in isolated widget tests). */
export function useEditMode(): EditModeState {
  return useContext(EditModeContext) ?? NOOP_STATE;
}
