# SegmentedControl

Pick exactly one of two to five short options, as a row of segments (radio-group semantics, arrow keys).

Use it for views and modes (Agenda, Week or Month; Light or Dark). Give it `aria-label` unless it sits in a Field. Options can have an `icon`, and `iconOnly` hides the text while keeping it as the accessible name. Use `block` to fill the width. For more than five options, use a Select.

Source: `web/src/ui/Toggles.tsx`.
