-- 005_oauth_state_capabilities — the services a pending sign-in asked for (ARCHITECTURE 4.7).
-- A JSON array of capabilities ("calendar", "mail"). The callback uses it for the scope it
-- redeems the code with and for which granted services start switched on. NULL (a sign-in
-- started before this migration) means every service the provider offers, as before.

ALTER TABLE oauth_states ADD COLUMN capabilities TEXT NULL;
