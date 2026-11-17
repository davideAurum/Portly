# Button

The app's text button, in four variants and two sizes.

Use `primary` once per view for the main action (Save, Add widget). Use `secondary` (the default) for other actions, `ghost` for low-weight actions in toolbars and dialog footers (Cancel), and `danger` for destructive actions (Delete board) that the user then confirms.

- Labels are verbs in sentence case: "Add widget", "Reconnect", not "OK" or "Submit".
- `loading` shows a spinner, disables the button and sets `aria-busy`. Keep the label ("Saving") so its width doesn't jump.
- `icon` takes a lucide icon and draws it at 16px (14px when `sm`) before the label.
- Heights come from `--pt-control-h` (36px) and `--pt-control-h-sm` (30px); radius `--pt-radius-md`, or `--pt-radius-sm` when small.
- Primary fills with `--pt-accent` and uses `--pt-accent-contrast` text (about 5:1 on Tide).
- Known gap from the source: in dark mode, `danger` puts white text on `--pt-danger` (`#f87171`), only about 2.8:1. Kept exact; fix it in the code if you change it.

The consumer provides the children (the label), `onClick`, and `type="submit"` inside forms (the default is `button`).

Source: `web/src/ui/Button.tsx`.
