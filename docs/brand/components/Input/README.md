# Input

A single-line text field (`web/src/ui/Input.tsx`).

Pair it with a visible label (the app uses Field). Placeholders show an example in `--pt-text-subtle` and never replace the label. Set `aria-invalid` to show an error border in `--pt-danger`, and put the error message in text below. `readOnly` fills with `--pt-surface-2`. The focus state is an accent border with a 3px accent ring. `size="sm"` is 30px high. `leading` takes decorative content such as a search icon, and `trailing` takes a unit or a small button. Use `PasswordInput` for secrets (a show/hide toggle, never autofilled), `TextArea` for several lines, and `Select` (a styled native select) for short lists. Inside a Field it gets its id and description wiring automatically.
