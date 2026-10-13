# Portly brand

The Portly mark is **Beacon**: a lighthouse on the harbor, the steady light you come home to in
every new tab. Colors and type are shared with the earlier "Porthole" exploration.

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

## Colors

| Name | Hex | Role |
| --- | --- | --- |
| Harbor | `#0B4F63` | Icon tile, wordmark, primary text on light |
| Deep | `#072F3B` | Dark backgrounds |
| Tide | `#137A85` | The rock and sea at the base, secondary accents |
| Sky | `#A6DEDB` | Sea line, light accents |
| Brass | `#E3A82B` | Bands, roof, rail |
| Sun | `#FFD166` | Lantern and beams |
| Foam | `#EAF5F4` | Light backgrounds |

## Type

Fredoka (Google Fonts, SIL Open Font License): 600 for the wordmark and headlines, 500 for
subheads. Inside the app, text stays in the system UI font.

## Rules

- Keep clear space around the logo of at least the tower's width.
- Below 48 px use the simplified drawings; below 24 px use `portly-icon-small.svg`.
- Brass and Sun are fills, never text colors. Text is Harbor or Deep.
- Don't stretch, rotate, outline or recolor the mark.

## In the app

- Default theme: accent Tide, background the Harbor to Deep gradient at 160 degrees. Earlier
  installs that still had the old defaults (blue accent, indigo to violet gradient) move to these
  once; colors someone chose stay. The old gradient is still offered as the "Dusk" preset.
- The lighthouse (`web/src/ui/BrandMark.tsx`) is the header's home button, the empty dashboard's
  artwork and the mark on Settings > About. Pressing the header lighthouse makes its light go
  round once (the `turn` prop on `BrandMark`, the same motion as `portly-icon-animated.svg`; it
  stays still with reduced motion). The extension's fallback and options pages use the Harbor
  background too.
- Contrast: white on Tide is about 5:1; the link color derived from Tide is about 6.9:1 on white
  and 5:1 on the dark surface.
