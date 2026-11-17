# LetterTile

A coloured square holding a label's first letter. It stands in for a missing icon on bookmarks and accounts.

Pass `label` (the bookmark or account name). The colour is stable per label unless `color` is given as a hex. The text colour is picked for contrast automatically. `size` defaults to 32. It is decorative (`aria-hidden`), so the name must also appear as text nearby.

Source: `web/src/ui/Badge.tsx`.
