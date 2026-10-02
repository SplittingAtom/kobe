# KOBE-13: Invites, SMTP, password reset, deactivation

- **Status:** in review
- **Branch / worktree:** `kobe-13-invites-lifecycle` in `../Kobe-wt13`
- **Depends on:** KOBE-12 (merged), KOBE-14 (merged)

## Acceptance criteria (derived from spec D6, D7, D8, D12, §4 U1, §5.4, §6.1; Hadron unreachable)

- **ac-1 Install invitations (D6/D7, U1).** Install Owner/Admins invite an email address into the
  install (`/v1/install/invites`: list, create, resend, revoke). The email carries a single-use
  link; the token is 256 random bits, stored only as a SHA-256 hash, expires after 72 h, is
  compared in constant time, and every failure (unknown, malformed, used, revoked, expired) gets
  one answer. Accepting creates the account (email verified by possession), sets the password and
  signs the person in; 2FA enrollment is enforced next when the install requires it; the new user
  sees no team until they accept a team invitation. Acceptance is rate-limited per IP and refused
  cross-origin. No self-sign-up remains.
- **ac-2 Team invitations (D6/D8; resolves the KOBE-14 open question).** People join a team only by
  accepting a team admin's invitation while signed in as the invited address; the team admin's
  answer is identical whether or not the address is a Kobe user (no enumeration, no add without
  consent). The direct add-by-email route is gone. Invitees list, accept (joining with the invited
  role) or decline; team admins list and revoke; expiry 14 days. Install admins still never place
  people into existing teams (KOBE-14). Team invitations are a team table under RLS.
- **ac-3 Password reset (D7).** Request answers identically for known and unknown addresses and
  mails only real, active accounts (off the request path); token single-use, hashed at rest
  (Better Auth `verification.storeIdentifier: "hashed"`), 30-minute TTL, delivered in the URL
  fragment; a reset revokes every session; rate-limited per IP (3/min) and per account
  (3 emails/hour); the password policy applies.
- **ac-4 Deactivation (D7).** Install admins deactivate and reactivate users (Admins act on Users,
  only the Owner on Admins, nobody on the Owner or themselves). Deactivation immediately deletes
  every session and pending verification, blocks every sign-in method (password, password+TOTP,
  passkey, invitation) and all API access (`requireSession` re-reads it per request), and sends no
  reset email. Memberships are kept but inert; reactivation restores sign-in and teams. A seam
  (`deps.lifecycle`) runs downstream steps (stop sandboxes KOBE-28, suspend grants KOBE-61, pause
  schedules KOBE-64/65, audit KOBE-15); failures are reported, never undo the deactivation.
- **ac-5 SMTP (D7: required Helm value).** Chart values `smtp.host`, `port`, `security`
  (`starttls` default | `tls` | `none`), `from` (required), credentials only from
  `smtp.existingSecret`; validated by the values schema and, in the server, by zod at startup
  (credentials refused over `none`; From header-safe). API server only. No SMTP server in tests
  (in-memory mailer); Mailpit is the dev/e2e sink.
- **ac-6 Tests.** Unit (config, mail), DB integration (all flows, races), DB package (trigger race,
  RLS listing, probe fixture), chart render, e2e reset mail through SMTP.

## Decisions

- **Two kinds of invitation.** Install invitations (`invitations`, install-wide, §5.4) bring a
  person into the install; team invitations (`team_invitations`, a team table) bring an existing
  user into a team with their consent. Spec D7 says "admins invite users into one or more teams";
  KOBE-14 settled that install admins don't manage membership of existing teams (break-glass
  bypass otherwise). So team placement always comes from the team's own admins, and a brand-new
  person needs both: a team admin invites the address (pending, invisible to the person until they
  have an account), an install admin invites the person to Kobe; after accepting, the person sees
  and accepts the team invitation (U1). Install invitations carry no teams.
- **Team invitations to unknown addresses are recorded, not mailed.** A team admin can't create
  install users (D6), and mailing strangers on a team admin's word would bypass invite-only. The
  uniform 202 hides whether the address exists; existing active users get a notification email
  (sent off the request path so timing doesn't leak either).
- **Invitation acceptance lives in Better Auth** as a small plugin (`/api/auth/invitation/lookup`,
  `/api/auth/invitation/accept`) to reuse its IP-based Postgres rate limits, cookie/session code
  and session hooks. Better Auth checks Origin only on requests with cookies, so `accept` (which
  sets one: login CSRF) requires the install origin explicitly.
- **Tokens in URL fragments** (`/invite#token=…`, `/reset-password#token=…`): never sent to the
  server or proxies, so never in access logs; the pages strip them from history. The reset email
  uses our own link, not Better Auth's `GET /reset-password/:token` redirect.
- **Expiry uses the database clock** (`now()`) for setting and checking, so replicas with skewed
  clocks agree (the test Postgres runs ~20 s ahead of the dev Mac).
- **Deactivation is `users.deactivated_at`** (not Better Auth's admin plugin, which brings its own
  role model). Blocked in three layers: Better Auth `databaseHooks.session.create.before` (clean
  403 `ACCOUNT_DEACTIVATED` for every sign-in method), a `sessions` trigger that takes `FOR SHARE`
  on the user row (closes the race with a concurrent deactivation — proven both orders in
  `packages/db/src/deactivation.db.test.ts`), and `requireSession` (per-request re-read). The
  deactivating transaction marks the user and deletes sessions and verifications together.
- **Memberships survive deactivation** (spec doesn't say to remove them; reactivation restores
  access; sandboxes/volumes per D12 are KOBE-28's). The last-team-admin guard now counts only
  active team admins, and deactivation reports `teamsWithoutActiveAdmin`.
- **Who may (de)activate whom** mirrors install roles: Admins act on Users; only the Owner acts on
  Admins (deactivating an Admin is a stronger form of revoking Admin, which is Owner-only); the
  Owner can't be deactivated (transfer first); nobody acts on themselves.
- **Install invite for an existing account → 409 `user_exists`.** Install admins list users anyway,
  so this reveals nothing new. Re-inviting an open address re-issues it (old link dies).
- **Install invite creation reports delivery** (`emailSent`), never returns the token: only the
  mailbox owner can accept, so acceptance proves control of the address.
- **Rate limits:** Better Auth custom rules for `/request-password-reset` (3/min/IP),
  `/reset-password` (5/min/IP), `/invitation/lookup` (10/min/IP), `/invitation/accept`
  (5/min/IP); our own Postgres limiter (`rate_limits`, keys `kobe:*`) for reset emails per account
  (3/h) and team invitations per inviter (50/h).
- `scanTeams` (db) extracts KOBE-14's per-team loop so `listMemberships` and
  `listTeamInvitationsFor` share it; `team_invitations` stays behind its one canonical policy.
- `requireTeam` is now idempotent per request (`/team/invites` is its own route module under
  `/team`, whose middleware also matches).

## For downstream tickets

- **KOBE-28 / KOBE-61 / KOBE-64 / KOBE-15:** register work on deactivation with
  `deps.lifecycle.on("deactivated", { name, run: async (userId) => … })` (and `"reactivated"`).
  Hooks run after sessions are revoked and sign-in is blocked; a throw is logged and reported in
  the response's `incompleteSteps`.
- **KOBE-15 audit seams:** `routes/install-invites.ts` (invite/resend/revoke),
  `auth/invitation-plugin.ts` (accept), `routes/team-invites.ts`, `routes/my-invites.ts`
  (accept/decline), `routes/install-users.ts` (deactivate/reactivate), Better Auth
  `onPasswordReset` for resets.
- **KOBE-20 (admin consoles):** APIs are `/v1/install/users`, `/v1/install/invites`,
  `/v1/team/invites`; the web has only the invitee-side pages (`/invite`, `/forgot-password`,
  `/reset-password`, team invitations on the home page).
- Mail: `deps.mailer.send({to, subject, text})` (plain text only); messages in `mail/messages.ts`
  keep user-supplied names on one line.

## Open questions (for Chris or the coordinator)

- **Orphaned teams.** Deactivating a team's only active team admin leaves a team nobody can
  manage until reactivation (the response lists them). Letting install admins name a replacement
  would hand them a path into any team (deactivate the admin, install an accomplice), so it is not
  built. A two-person flow (like break-glass) could solve it later.
- Should install invitations be able to propose team placements that the team's admins approve?
  Not built (adds a third state); today the team admin invites the address directly.
- Better Auth's reset request does one extra DB insert for real accounts (sub-millisecond timing
  difference); the email itself is off the request path.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/invites.db.test.ts` › "install invitations (ac-1)" (admin-only,
  hashed token + 72 h TTL, lookup/accept/sign-in, single use incl. 3 concurrent accepts, one answer
  for unknown/malformed/expired/revoked, resend rotates, `user_exists`, password policy, failed
  delivery + resend, cross-origin refused, 429 after 5/min, 2FA enrollment enforced).
- ac-2: › "team invitations (ac-2)" (identical response for known/unknown, mail only to existing
  user, no add without acceptance, only invitee sees/accepts, decline/revoke/expiry, members and
  install admins can't invite, U1 path from install invite into a team, RLS forced);
  `services/server/src/teams.db.test.ts` (team building via invitations);
  `packages/db/src/team-invitations.db.test.ts`; probe suite covers `team_invitations`.
- ac-3: `services/server/src/account-lifecycle.db.test.ts` › "password reset (ac-3)".
- ac-4: › "deactivation (ac-4)" (permission rules, sessions + JWT endpoint dead, password+TOTP and
  passkey sign-in refused with no session, no reset mail, memberships inert, active-admin count,
  users list, `teamsWithoutActiveAdmin`, reactivation restores TOTP/passkey sign-in and team
  access, failing hook reported); `packages/db/src/deactivation.db.test.ts` (trigger + both race
  orders).
- ac-5: `services/server/src/config.test.ts` › "SMTP (KOBE-13)", `src/mail/mail.test.ts`,
  `charts/kobe/tests/render.test.ts` › "SMTP (KOBE-13)", `e2e/run.sh` (reset email delivered to
  Mailpit over SMTP; none for an unknown address).
- ac-6: `pnpm build test typecheck lint format:check license:check` green (chart `helm lint`
  fails locally on Helm 4 only, pre-existing); `pnpm --filter @kobe/db test:db` 130 passed;
  `pnpm --filter @kobe/server test:db` 85 passed; `db:check` clean after commit.
