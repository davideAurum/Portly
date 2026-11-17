# IconButton

A square button with only an icon. Its required `aria-label` is also its tooltip.

Use it in toolbars and the header (edit layout, shortcuts, settings, refresh). It is `ghost` by default. Pass `pressed` for toggles: it sets `aria-pressed` and fills with `--pt-accent-soft`. It shares Button's variants, sizes and `loading`. Pass `tooltip={false}` only when another element already shows the name.

Source: `web/src/ui/Button.tsx`.
