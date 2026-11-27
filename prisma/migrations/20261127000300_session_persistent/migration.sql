-- "Keep me signed in" per session: a persistent session gets refresh/CSRF cookies with an expiry; any other session
-- (including every staff session, which also has a shorter absolute lifetime) gets browser-session cookies.
-- Existing sessions default to non-persistent: their cookies become session cookies at the next refresh.

-- AlterTable (generated shape)
ALTER TABLE "user_sessions" ADD COLUMN "persistent" BOOLEAN NOT NULL DEFAULT false;
