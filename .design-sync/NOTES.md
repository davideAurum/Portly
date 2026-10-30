# Design-sync notes (Portly UI -> claude.ai/design)

Project: "Portly UI" (projectId in config.json). Shape: package, no Storybook.

## How the build is wired
- Portly ships no UI library build. `.design-sync/pkg/` is a wrapper "package" (`@portly/ui`) whose
  `index.ts` re-exports `web/src/ui/index.ts`. `cfg.entry` points at it; PKG_DIR is `.design-sync/pkg`,
  so package-relative config paths (`srcDir`, `extraFonts`) start with `../`.
- `cfg.buildCmd` (`node .design-sync/pkg/prepare.mjs`) must run before the converter: it emits
  `.d.ts` files for `web/src/ui` with the repo's TypeScript (7.x) into `.design-sync/.cache/types`
  (the wrapper's `types` field points there) and copies Cascadia Code/Mono from `%WINDIR%\Fonts`.
- `.design-sync/pkg/env.ts` sets the Vite `define` constants (`__PORTLY_STATIC__` = false,
  `__PORTLY_LOCAL_SERVER__` = '', `__APP_VERSION__`, `__APP_UPDATED__`) as globals before the kit
  loads. Without it every card throws `ReferenceError: __PORTLY_STATIC__ is not defined`.
  If vite.config.ts gains a new `define`, add it there.
- `index.ts` imports `web/src/styles/tokens.css` then `base.css` (same order as `main.tsx`), so the
  `--hb-*` tokens and base styles ride in `_ds_bundle.css` with the CSS-module styles.
- Render check: no Playwright browser cache on this PC; run with
  `DS_CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"` (playwright library
  only, installed into `.ds-sync/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).
- npm here runs with ignore-scripts; esbuild's skipped postinstall is harmless.
- Upload: `_ds_bundle.js` (~2 MB) must go in its own `write_files` call; bundled together with
  `_vendor/` and `fonts/` the call hit the 60 s timeout. Component files go fine 132 per call.

## Fonts
- Portly uses system font stacks only (no web fonts). The user chose to ship Cascadia Code /
  Cascadia Mono (OFL, from the Windows font folder) so the mono stack renders as intended. Segoe UI
  is not shipped; off Windows the sans stack falls back to system-ui.

## Preview authoring
- `body::before` paints the user's backdrop (dark teal gradient by default), so cards are dark.
  Previews put controls on a glass widget panel (inline styles with `--hb-glass`,
  `--hb-glass-border`, `--hb-shadow`, `--hb-radius-lg`, `--hb-space-4`), matching WidgetFrame.
- Icons: import from `lucide-react` in previews; `icon` props take the component (`icon={Plus}`),
  MenuItem's `icon` takes an element (`icon={<Pencil />}`).
- Overlays (Menu, Dialog, ConfirmDialog, Popover, Tooltip) render open via `defaultOpen` /
  `open`, `modal={false}` where supported, with `cardMode: single` + a viewport in `cfg.overrides`.
  - Tooltip has no `open`/`defaultOpen` (it wraps its own Radix Root): previews open it with
    `autoFocus` on the trigger (Radix opens on keyboard focus). Keep tooltip text short and on
    `side="top"`/`"bottom"`; a long `side="right"` tooltip is cut off in the 420x200 viewport.
  - Dialog doesn't forward `modal`, so the overlay always draws; pass `open` + a no-op
    `onOpenChange`. ConfirmDialog requires `open`, `onOpenChange` and `onConfirm`.
  - Popover is the raw Radix Root (`defaultOpen` works, non-modal). Pass
    `onOpenAutoFocus={(e) => e.preventDefault()}` to PopoverContent to avoid a focus ring.
- IconButton wraps itself in a Radix Tooltip; pass `tooltip={false}` in static cells.
- Row panels of a few small controls: add `width: 'fit-content'` so the panel hugs them.
- Field passes label, help and `aria-invalid` to Input/Select/TextArea/Slider through context: show
  errors with `<Field error="...">`. In a FieldGrid give every field help text, or none, or the
  controls don't line up.
- Checkbox/Switch are controlled: static cells pass `checked` + `onCheckedChange={() => {}}`.
- SettingsCard paints its own `--hb-surface` card; no glass Panel around it.
- React Query: ErrorState and ReconnectButton call `useAccount()` and throw "No QueryClient set"
  without a provider. `.design-sync/pkg/QueryProvider.tsx` exports `PortlyQueryProvider` from the
  bundle; the ErrorState preview wraps itself in it (imported from '@portly/ui', so it shares the
  bundle's react-query copy; importing `@tanstack/react-query` in a preview bundles a second copy
  with a separate context). It is not `cfg.provider`, which would re-key every graded preview.
- ErrorState previews show only the generic error branch: the reauth / not-configured / offline
  branches check `instanceof ApiError`, which the kit doesn't export.
- AccountBadge takes a plain account object (`id`, `kind`, `label`, `email`, `color`, `status`);
  `color: null` uses the stable fallback colour. Use fictional accounts (alex@example.com).
- Write preview files with the Write tool: multi-file bash heredocs with JSX quotes failed to parse.
- A preview-rebuild + capture of ~7 components took 10+ minutes with three batches running at once.

## Kit gaps found while authoring (web/src/ui, not fixed here)
- A disabled Slider looks identical to an enabled one: `Toggles.module.css` has no disabled rule
  for the range input (Switch and SegmentedControl dim to 0.55). No Disabled cell in Slider.tsx.
- A disabled TabsTrigger looks like any inactive tab: `.tab` in `Popover.module.css` has no
  `[data-disabled]` rule. No disabled-tab story in Tabs.tsx.

## Known render warns
- [RENDER_THIN] on floor cards for layout/sub-part exports with no content of their own:
  BrandMark (icon only), FieldGrid, FieldGroup, FormFooter, MenuGroup, MenuLabel, MenuRadioGroup.

## Re-sync risks
- `.design-sync/.cache/types` and `.cache/fonts` are regenerated by `prepare.mjs`; a stale types
  folder (prepare not re-run) silently ships old prop contracts.
- `env.ts` duplicates the Vite defines by hand; values can drift from vite.config.ts.
- `__APP_VERSION__` in env.ts is hard-coded; bump it with package.json.
- Components that need app context (AccountPicker, ReconnectButton, QueryView, ErrorBoundary)
  ship floor cards; they were not exercised beyond the floor render.
