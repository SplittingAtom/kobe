# KOBE-261: two-replica budget overshoot (550 vs 100): root cause revisited

- **Status:** done (fixed by KOBE-278 and KOBE-286); real remaining cause fixed by KOBE-443
- **Ledgers:** `KOBE-278.md` (the duplicate, fixed together), `KOBE-286.md`, `KOBE-443.md`

## Root cause, as recorded then (KOBE-278)

A product race: stale cached spend plus settled holds that ended before a queued check ran. The
gate admitted calls on spend that was too low, once for each stale member. KOBE-286 removed the
cause: `kobe_reserve_budget` reads the spend itself, in one snapshot with the reservations.

## Root cause still open after KOBE-286 (found 2026-10-19, KOBE-443)

The overshoot came back in PR #317's merge queue (`two-replicas.db.test.ts`: limit 683, 12 calls
of 65 admitted, overshoot 97). Its cause was in the reservation function itself, not in the gate's
caching:
the live holds on a shared line were counted per member only up to the member share (25 %) of
what is left. Once the spend is read fresh (KOBE-286), that share shrinks while calls are in
flight, so holds taken at a larger share were undercounted and a call was admitted although spend
plus the live holds already reached the limit. KOBE-443 counts every live hold in full (migration
`0152_reserve_full_holds`, and the same change in the memory store). The interleaving and the
tests are in `KOBE-443.md`.

The KOBE-278/286 changes stay correct and are needed. This was a second, independent undercount.
