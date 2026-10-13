-- 004_beacon_defaults — the Beacon brand's new appearance defaults for existing installs.
-- Settings are stored with their defaults filled in, so an accent or background still equal to
-- the old default (blue #2563eb; the #1e3a8a -> #6d28d9 gradient at 160deg) was never chosen:
-- move it to the new default (Tide #137a85; Harbor #0b4f63 -> Deep #072f3b). Anything the user
-- picked is left alone. Mirrors upgradeLegacyThemeDefaults() in shared/src/theme.ts.
UPDATE settings
SET value = json_set(value, '$.accent', '#137a85'),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE namespace = 'appearance'
  AND json_valid(value)
  AND lower(json_extract(value, '$.accent')) = '#2563eb';

UPDATE settings
SET value = json_set(value, '$.background', json('{"type":"gradient","angle":160,"stops":[{"color":"#0b4f63","at":0},{"color":"#072f3b","at":100}]}')),
    updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
WHERE namespace = 'appearance'
  AND json_valid(value)
  AND json_extract(value, '$.background.type') = 'gradient'
  AND json_extract(value, '$.background.angle') = 160
  AND json_array_length(value, '$.background.stops') = 2
  AND lower(json_extract(value, '$.background.stops[0].color')) = '#1e3a8a'
  AND json_extract(value, '$.background.stops[0].at') = 0
  AND lower(json_extract(value, '$.background.stops[1].color')) = '#6d28d9'
  AND json_extract(value, '$.background.stops[1].at') = 100;
