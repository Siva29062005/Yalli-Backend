-- Sessions record whether they were issued to a browser in cookie mode. Only those get the refresh grace window
-- (AuthService.refresh): a body-mode (API / mobile) session keeps strict reuse detection even when a client presents
-- its token in a Cookie header. Existing sessions default to false (no grace until the next sign-in).

-- AlterTable (generated shape)
ALTER TABLE "user_sessions" ADD COLUMN "cookie_mode" BOOLEAN NOT NULL DEFAULT false;
