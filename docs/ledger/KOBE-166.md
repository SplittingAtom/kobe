# KOBE-166: 74c T3: Paired uid pool and kobe-runas helper support

- **Status:** in review
- **Branch / worktree:** `kobe-166-paired-uid-pool` in `../Kobe-wt166`
- **Depends on:** KOBE-71, KOBE-165. Design: `docs/design/paired-tool-uid.md` (option B). Next: KOBE-167
  (executor), KOBE-168 (rollout). Migrations: none.

## Plan

Pool, helper, image, pod spec and tests only. Nothing routes a tool through the partner uid: Pi's
tools run as before, so behaviour is unchanged.

## Decisions

- **Ranges:** Pi `2000-2063` (unchanged), partner `3000-3063`; Pi identity `n` pairs with `n + 1000`
  (`partnerOf`, `PARTNER_UID_OFFSET`). uid = gid. Server constant `PARTNER_IDENTITY_BASE = 3000`.
- **Helper (`kobe-runas.c`):** both ranges accepted by every mode (exec, `--kill-all`,
  `--probe-ptrace`). Same switch for a partner: groups exactly {own gid, 1000}, umask 002, no caps,
  `no_new_privs`, `RLIMIT_NPROC`. fds: Pi keeps 3, 4 and **5** (executor relay, per the design);
  a partner keeps **stdio only** (the executor's channel is its stdio, relayed by the agent). The
  helper does not check pairing: only the agent can run it, and the agent derives the partner.
- **Allocation:** one identity from the pool = the pair. The partner is never handed out on its own,
  so it cannot be in use while its Pi identity is free. `killAll`/`killAllSync`/`reclaimFiles` act
  on both uids; the identity is released only after both succeed, and a failure on either retires
  it (same fail-closed path as KOBE-71). `partnerCommand` builds the helper argv (unused yet).
- **Rollout without a migration:** pairs are in force (`PiIdentities.paired`) only if the agent holds
  every partner group (`pairedUids`). The pod spec change (`supplementalGroups` + 16 partner groups,
  3000-3015) reaches running sandboxes through the team reconcile; an agent on the old spec behaves
  exactly as before. Paired start-up also probes one partner switch (`--probe-ptrace`) and fails
  closed if it cannot.
- **Image:** `kobe-tool-<n>` users/groups 3000-3063 (no create-home, home `/home/kobe`), root-owned
  `/etc/gitconfig` with `safe.directory = *` (not set before; also fixes uid recycling). Workspace
  stays shared by group 1000 + umask 002 + setgid dirs, no ACLs (design).
- Not touched: the KOBE-169 interim fix (agent-owned `agent/` files, sticky dir) is not on `main` yet;
  the test layout uses today's `agent/` (2770, Pi group), which a partner is outside of either way.

## Open questions

- None blocking. KOBE-167 may want more fds for a partner than stdio; change `first_closed` then.

## Evidence

| Criterion / item                                                            | Test                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 distinct partner uid per identity, allocation                          | `identities.partner.real.test.ts` "gives every Pi identity a distinct partner uid"; unit `pi/identities.test.ts` "pairs every Pi uid…"                        |
| ac-1 reclaim with the real helper                                           | real "reclaims both uids before the pair is reused" (kill-all incl. a setsid escapee, 000 dirs, reuse only after); unit kill/reclaim of both, failure retires |
| partner cannot signal/ptrace/read Pi, nor write `agent/`, read `model.json` | real "cannot signal, read or ptrace…", "cannot ptrace-attach", "cannot write, replace or read in its Pi's runtime directory" (control: Pi can)                |
| workspace shared by both uids                                               | real "shares the workspace between the two uids"                                                                                                              |
| helper switch, fds, ranges                                                  | real "starts a partner process…", "hands a partner uid stdio only", "refuses uids outside"; `test-image.sh` partner checks                                    |
| pod spec                                                                    | `manifests.test.ts` supplementalGroups                                                                                                                        |
