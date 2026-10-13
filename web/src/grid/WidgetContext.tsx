/**
 * Per-widget frame context. Widgets use:
 *
 * - `<WidgetActions>` — renders widget-specific header buttons (refresh, "+", a stale indicator)
 *   into the frame header's actions slot (§10.3); when the header is hidden they float in the
 *   top-right corner of the widget.
 * - `useWidgetFrame()` — `{instanceId, title, openSettings}`; e.g. the weather widget's
 *   "Set location" CTA calls `openSettings()` (§10.7 #1).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface WidgetFrameContextValue {
  instanceId: string;
  title: string;
  /**
   * Opens this widget's settings dialog (no-op for the unsaved default layout). `focus` names
   * the field to start in (an element marked `data-settings-focus="<name>"`, or its first input).
   */
  openSettings(options?: { focus?: string }): void;
  /** Whether settings can be opened (the widget belongs to a saved profile). */
  canOpenSettings: boolean;
  /** The element WidgetActions renders into. */
  actionsTarget: HTMLElement | null;
}

export const WidgetFrameContext = createContext<WidgetFrameContextValue | null>(null);

const FALLBACK: WidgetFrameContextValue = {
  instanceId: '',
  title: '',
  openSettings: () => {},
  canOpenSettings: false,
  actionsTarget: null,
};

export function useWidgetFrame(): WidgetFrameContextValue {
  return useContext(WidgetFrameContext) ?? FALLBACK;
}

/** Widget-specific header buttons, rendered in the frame's actions slot. */
export function WidgetActions({ children }: { children: ReactNode }) {
  const { actionsTarget } = useWidgetFrame();
  if (!actionsTarget) return null;
  return createPortal(children, actionsTarget);
}
