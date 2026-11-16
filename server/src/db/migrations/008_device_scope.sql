-- 008_device_scope: what a connected device may do (security/devices.ts, shared/src/devices.ts).
-- 'full' is what every device could do until now, so each existing PC stays as it is. 'reporter'
-- is a helper app on a phone: it may report what is playing and disconnect itself, nothing else.

ALTER TABLE devices ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'reporter'));
ALTER TABLE device_requests ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'reporter'));
