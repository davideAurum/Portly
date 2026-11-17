# Portly design system

How Portly looks, reads and behaves. Agents and people building UI start here. The binding UI
contract is ARCHITECTURE section 10.4; this folder is the brand and the usage rules on top of it.

Portly is a personal browser home page: the New Tab page becomes a dashboard of search,
bookmarks, calendar, mail, tasks and weather, running on the owner's own PC. The brand is a
harbor at dusk. The mark is **Beacon**, a lighthouse on a teal tile: the steady light you come
home to in every new tab. The tone is friendly and calm, never loud.

| Path | What |
| --- | --- |
| `README.md` | This brand book: voice, colour, type, space, motion, the mark |
| `tokens.json` | The tokens in design-system form, mirroring `web/src/styles/tokens.css` |
| `components/<Name>/README.md` | Usage guides for the core components in `web/src/ui` |
| `portly-*.svg` | The Beacon mark (below) |
| `wordmarks/` | The outlined wordmark and banners, including the porthole "o" variant |

## Tokens

- `web/src/styles/tokens.css` is the source. Features style everything through its `--pt-*`
  custom properties and never paste hex values (section 10.4).
- `tokens.json` repeats the literal values with a usage note on each, for design tools and
  agents. `web/build/brandTokens.test.ts` fails when the two disagree, so a change to a value
  in `tokens.css` goes into `tokens.json` in the same commit.
- Derived values stay in CSS only: `--pt-accent-soft`, `--pt-accent-text`, the `--pt-*-soft`
  tints, glass (`--pt-glass`, `--pt-glass-strong`, `--pt-glass-filter`), motion and the
  backdrop.
- Light values are on `:root`. Dark applies with `data-theme="dark"`, or with the OS setting
  unless light was chosen. Compact density (`data-density="compact"`) shrinks `--pt-space-3` to
  `6` by one step, `--pt-text-md` to 13px and the control heights to 32 and 26px.
- `--pt-accent` follows the user's theme (Tide by default). Anything that should follow the
  user's colour uses `--pt-accent`, `--pt-accent-soft` or `--pt-accent-text`, never the brand
  Tide.
- The `brand-*` colours in `tokens.json` (Harbor, Deep, Tide, Sky, Brass, Sun, Foam) are for
  the mark, the site, banners and docs. Inside the app, use the `--pt-*` UI tokens.

## Voice

- Write plainly in sentence case, addressing the user as "you": "Add widget", "Reconnect",
  "Your dashboard is empty".
- Name things as people know them (mail, calendar, tasks), not as the system is built (OAuth
  tokens, endpoints).
- Errors say what happened and what to do next: "The local server is not running. Start it from
  the Portly tray icon, then reload."
- No emoji in the UI. Icons come from lucide.
- The wordmark is lowercase "portly" in the lockup and "Portly" in running text and the porthole
  wordmark.

## Colour

- **Grounds.** The page sits on the user's backdrop. By default that is `--pt-backdrop`, the
  Harbor to Deep gradient at 160 degrees, which stays dark in both themes. Widgets are glass:
  `--pt-surface` at `--pt-widget-opacity` (85%) with a `--pt-glass-border` edge and
  `--pt-shadow`.
- **Text.** Use `--pt-text` for body copy and headings on `--pt-surface` and `--pt-surface-2`,
  and `--pt-text-muted` for secondary lines. Use `--pt-text-subtle` only for placeholders and
  hints, because it is below 4.5:1.
- **Text on the backdrop** (greeting, clock, frameless widgets) gets a soft halo in `--pt-bg`, so
  it stays readable on any photo.
- **Status.** Use `--pt-success`, `--pt-warning` and `--pt-danger`, each with a word or icon.
  Their soft tints colour banner and badge fills.
- **Brass and Sun are fills, never text.** Brand text is Harbor or Deep on light grounds, and
  white or Foam on dark ones.
- **Contrast.** White on Tide is about 5:1, and the link colour derived from Tide is about
  6.9:1 on white and 5:1 on the dark surface. Known gap: the dark danger button puts white text
  on `#f87171`, about 2.8:1.

| Name | Hex | Role |
| --- | --- | --- |
| Harbor | `#0B4F63` | Icon tile, wordmark, primary text on light |
| Deep | `#072F3B` | Dark backgrounds |
| Tide | `#137A85` | The rock and sea at the base, the default accent |
| Sky | `#A6DEDB` | Sea line, porthole glass, light accents |
| Brass | `#E3A82B` | Bands, roof, rail, porthole ring |
| Sun | `#FFD166` | Lantern and beams |
| Foam | `#EAF5F4` | Light backgrounds |

## Type

- The app uses the system font stack (`--pt-font-sans`: Segoe UI Variable, then system-ui) and
  loads no web fonts (section 2a). `--pt-font-mono` is for keys, code and ids.
- The app scale is `--pt-text-xs` 12, `-sm` 13, `-md` 14 (base), `-lg` 17, `-xl` 22 and `-2xl`
  30. Headings use weight 650 and line height 1.25. Body text has line height 1.5.
- Use the `pt-tabular` class (tabular numerals) for times, counts and anything that ticks.
- Fredoka (SIL Open Font License, `site/fonts/fredoka-latin.woff2`) is for the brand only: 600
  for the wordmark and headlines, 500 for subheads, on the site, banners and docs.

## Space, shape and depth

- Spacing steps are 4, 8, 12, 16, 24 and 32 (`--pt-space-1` to `-6`). Use 12 between controls,
  16 inside cards and 24 between sections.
- Radii: `--pt-radius-sm` 6 for small controls, `-md` 10 for buttons, inputs and menus, `-lg` 12
  for widgets, cards and dialogs, and `-full` for pills (badges, header chips, switches).
- Controls are 36px high (`--pt-control-h`), or 30px when small. Header chips are 36px glass
  pills.
- Shadows are soft and teal-tinted: `--pt-shadow` for widgets and popovers, `--pt-shadow-lg`
  for dialogs and toasts.
- Frosted glass (a live backdrop blur) is off by default and turns on only over a photo.

## Motion and states

- Use `--pt-duration` (160ms) with `--pt-ease` for fades and colour changes. Pressed buttons
  move down 1px.
- Hover adds `--pt-hover` and pressing adds `--pt-active`. Focus is a solid 2px `--pt-focus`
  outline with a 2px offset on every interactive element. Inputs add a 3px accent ring.
- Disabled controls fade to 50-60% opacity and keep their label.
- The signature motion is the beacon turning: the header lighthouse's light goes round once
  (about 3s) when pressed. Everything respects `prefers-reduced-motion`.

## Components

The core kit lives in `web/src/ui` and is exported from `web/src/ui/index.ts`. Each guide says
when to use the component, what the consumer provides and what to avoid:
[Button](components/Button/README.md), [IconButton](components/IconButton/README.md),
[Badge](components/Badge/README.md), [Kbd](components/Kbd/README.md),
[LetterTile](components/LetterTile/README.md), [Input](components/Input/README.md),
[Switch](components/Switch/README.md), [Checkbox](components/Checkbox/README.md),
[SegmentedControl](components/SegmentedControl/README.md), [Tabs](components/Tabs/README.md),
[Banner](components/Banner/README.md), [Spinner](components/Spinner/README.md),
[EmptyState](components/EmptyState/README.md) and [BrandMark](components/BrandMark/README.md).
The rest of `web/src/ui` (Dialog, Menu, Popover, Tooltip, toast, Field, Select, Slider,
ColorPicker, ImageUpload, Skeleton, ErrorState, the account pickers) has no guide yet: follow
the patterns of the guided ones.

## Iconography

- Use lucide icons (`lucide-react`), outline style: 16px in buttons (14px in small ones), 17px
  in header chips. They inherit `currentColor`.
- Icon-only buttons always carry an `aria-label`, which is also their tooltip.
- Bookmarks without a favicon fall back to `LetterTile`.

## The mark

| File | Use |
| --- | --- |
| `portly-icon.svg` | App icon, full detail. Use at 48 px and up. |
| `portly-icon-small.svg` | Simplified icon for 16–32 px (tabs, toolbar). Same file as `web/public/favicon.svg`. |
| `portly-icon-animated.svg` | `portly-icon.svg` with the light making one full turn (about 3 s, plays once, then rests on the still icon). For splash or loading moments at 48 px and up; shows the still icon when the viewer asks for reduced motion. |
| `portly-mark.svg` | The lighthouse without its tile, for light backgrounds. |
| `portly-lockup.svg` | Icon plus the "portly" wordmark. The wordmark is live text in Fredoka SemiBold. |

The extension PNGs (`extension/icons/icon-{16,32,48,128}.png`) and `site/icon-128.png` are drawn
by `extension/tools/generate-icons.mjs`, which mirrors these SVGs. Change both together, then run
`node extension/tools/generate-icons.mjs`.

- Keep clear space around the logo of at least the tower's width.
- Below 48 px use the simplified drawings; below 24 px use `portly-icon-small.svg`.
- Don't stretch, rotate, outline or recolor the mark.

### Wordmarks

The files in `wordmarks/` have their text outlined, so they look the same where Fredoka isn't
installed.

| File | Use |
| --- | --- |
| `portly-lockup-outlined.svg` | `portly-lockup.svg` with the text outlined: images, docs, anywhere the font may be missing. Harbor, for light grounds. |
| `portly-porthole-wordmark.svg` | "Portly" with a porthole as the "o": Brass ring and bolts, Sky glass, Sun and a Tide wave. Deep text, transparent ground, for light backgrounds. |
| `portly-porthole-banner-dark.svg`, `-light.svg` | 1500 by 500 banners: the icon and the porthole wordmark, white on the Tide to Deep gradient or Deep on Foam. |
| `portly-banner-dark.svg`, `-light.svg` | The same banners with a plain "o". |

Use the porthole wordmark large (README headers, banners, splash screens). Below about 24 px tall
its details blur, so use the plain wordmark there. It is not in the app yet.

## In the app

- Default theme: accent Tide, background the Harbor to Deep gradient at 160 degrees. Earlier
  installs that still had the old defaults (blue accent, indigo to violet gradient) move to these
  once; colors someone chose stay. The old gradient is still offered as the "Dusk" preset.
- The lighthouse (`web/src/ui/BrandMark.tsx`) is the header's home button, the empty dashboard's
  artwork and the mark on Settings > About. Pressing the header lighthouse makes its light go
  round once (the `turn` prop on `BrandMark`, the same motion as `portly-icon-animated.svg`; it
  stays still with reduced motion). The extension's fallback and options pages use the Harbor
  background too.
