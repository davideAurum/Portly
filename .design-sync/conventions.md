# Building with Portly UI

Portly is a browser home page: a dashboard of glass widgets (weather, calendar, mail, feeds,
links) over a full-page backdrop. Build screens from `window.PortlyUI.*` and style your own layout
glue with the `--hb-*` CSS custom properties. There are no utility classes.

## Setup
- Link `styles.css` once. It carries the tokens, the base styles and every component's styles. No
  theme wrapper is needed; components are styled as soon as the stylesheet is on the page.
- `ErrorState`, `ReconnectButton`, `QueryView` and `AccountPicker` read server state through React
  Query and throw without a client. Wrap the screen once in `<PortlyQueryProvider>` (exported by
  the bundle); the other components don't need it.
- `base.css` paints the page backdrop on `body::before` (`--hb-backdrop`, a dark teal gradient by
  default). Text placed straight on the page has no surface behind it. Put content on a glass panel
  (below), as Portly's widgets do.
- Theme switches are attributes on `<html>`: `data-theme="dark"` (or none, which follows the OS),
  `data-density="compact"`, `data-glass="frosted"`. Never hard-code colours for dark mode; the
  tokens change.
- Icons are `lucide-react` components. `Button`/`IconButton` take the component (`icon={Plus}`);
  `MenuItem` takes an element (`icon={<Pencil />}`). `IconButton` requires `aria-label`, which also
  becomes its tooltip.
- Overlays (`Dialog`, `ConfirmDialog`, `Popover`, `Menu`, `Tooltip`) are Radix-based and compose like
  Radix: `<Menu><MenuTrigger asChild>...</MenuTrigger><MenuContent>...</MenuContent></Menu>`.

## Styling idiom: tokens only
Components style themselves through hashed CSS Modules. Don't target their classes, and don't
invent your own class vocabulary. For layout, use inline styles or your own CSS with these tokens:

| Family | Tokens |
| --- | --- |
| Surfaces | `--hb-bg`, `--hb-surface`, `--hb-surface-2`, `--hb-surface-3`, `--hb-surface-raised`, `--hb-glass`, `--hb-glass-strong`, `--hb-glass-border` |
| Text | `--hb-text`, `--hb-text-muted`, `--hb-text-subtle` |
| Lines | `--hb-border`, `--hb-border-strong` |
| Brand / status | `--hb-accent`, `--hb-accent-soft`, `--hb-accent-text`, `--hb-accent-contrast`, `--hb-danger(-soft)`, `--hb-warning(-soft)`, `--hb-success(-soft)` |
| Spacing | `--hb-space-1` 4px, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32 |
| Radius | `--hb-radius-sm` 6, `-md` 10, `-lg` 12, `-full` |
| Type | `--hb-font-sans`, `--hb-font-mono`, `--hb-text-xs` 12, `-sm` 13, `-md` 14, `-lg` 17, `-xl` 22, `-2xl` 30 |
| Elevation | `--hb-shadow`, `--hb-shadow-lg`, `--hb-overlay` |
| Controls / motion | `--hb-control-h` 36px, `--hb-control-h-sm` 30px, `--hb-duration`, `--hb-ease` |

The only global helper classes are `hb-visually-hidden` (screen-reader-only text) and `hb-tabular`
(tabular numbers).

## Where the truth lives
- `styles.css` and its imports (`_ds_bundle.css` holds the token definitions at the top, then the
  component styles). Read it before styling.
- `components/<group>/<Name>/<Name>.prompt.md` for usage and `<Name>.d.ts` for the props contract.

## Example
```jsx
const { Banner, Button } = window.PortlyUI;
const panel = {
  display: 'flex', flexDirection: 'column', gap: 'var(--hb-space-3)', padding: 'var(--hb-space-4)',
  borderRadius: 'var(--hb-radius-lg)', border: '1px solid var(--hb-glass-border)',
  background: 'var(--hb-glass)', boxShadow: 'var(--hb-shadow)', color: 'var(--hb-text)',
};

<div style={panel}>
  <Banner tone="warning" title="Mail account needs attention"
    actions={<Button size="sm" variant="primary">Reconnect</Button>}>
    Access was revoked on the provider's side. Reconnect to resume syncing.
  </Banner>
  <div style={{ display: 'flex', gap: 'var(--hb-space-2)', justifyContent: 'flex-end' }}>
    <Button variant="ghost">Skip for now</Button>
    <Button variant="primary">Save changes</Button>
  </div>
</div>
```
