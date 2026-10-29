# KOBE-510 — chart tests are linted

- `@kobe/chart` `lint` is now `eslint tests && helm lint …` (helm args unchanged), so turbo's `pnpm lint` covers
  charts/kobe/tests. No eslint config change needed (the root flat config already matches `**/*.test.ts`; no
  type-aware rules, so no tsconfig project).
- render.test.ts: the four `!` assertions (isolation preflight RBAC test) replaced by a local `must(value, what)`
  helper that throws a named error; no other findings in charts/kobe/tests.
- Bite check: a temporary `tests/zz-bite.test.ts` with `x!` made `pnpm --filter @kobe/chart lint` fail
  (no-non-null-assertion, exit 1); file removed.
- Checks: chart lint green, chart tests 194/194 with helm 3.19, root `pnpm lint` 27/27, prettier clean.
