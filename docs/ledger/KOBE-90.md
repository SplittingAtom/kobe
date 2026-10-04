# KOBE-90: Orbit export mapper, validated against Orbit's loader

- **Status:** in review
- **Branch / worktree:** `kobe-90-orbit-mapper` in `../Kobe-wt90`
- **Depends on:** KOBE-46 (versions, frozen manifest). Used by KOBE-91 (endpoint).

## Plan

Pure `mapAgentVersionToOrbit({definition, toolManifest, version, mcpTools?})` in
`services/server/src/agents/orbit/` plus `orbitExportToYaml`. Tests first (13 unit tests), a captured
strict schema (`orbit-schema.ts`), golden fixtures, and a CI job that loads the fixtures with Orbit.

## Decisions

- **Licenses (checked first):** Orbit (github.com/wlanderson0/orbit) is Apache-2.0; Inspect AI
  (UKGovernmentBEIS/inspect_ai) is MIT. Both are in the allowed family. Orbit is not an npm
  dependency: it only runs in the CI job (and later the eval Job image).
- **Pin:** Orbit v1.0.3, commit `588b3035f9…`. `ORBIT_PIN` in `orbit-schema.ts` and the commit in
  `ci.yml` must move together; re-check the captured schema when bumping.
- **Format:** Orbit's YAML = `ExperimentConfig` (`orbit/configs/experiment.py`, `extra="forbid"`)
  with `setup.agents[]` = `AgentSpec` (`setup.py`, also forbid). Loader:
  `orbit.wrapper.yaml_loader.load_experiment_config` (`yaml.safe_load` + Pydantic). The export writes
  `name`, `description`, `setup.agents[0]` (`name`, `role`, `model`, `system_prompt`, `tools`),
  `setup.edges: []`, `metadata.kobe`. No scenario/attacks/scheduler: KOBE-91/eval Job add those.
- **Tools = the frozen manifest** (`toolManifest.tools[].name`), never the file's `tools.allow` (ac-2).
  Orbit validates tool names (`[A-Za-z0-9_-]{1,64}`, not its runtime names such as `submit`) but does
  not resolve them at load; the eval Job supplies implementations through `tool_bindings`.
- **MCP tools** are plain Inspect tool names (`mcp__<server>__<tool>`, as Pi names them). The manifest
  only freezes connector names, so the caller passes names from the pinned connector snapshots
  (D27). A name outside the version's connectors throws; a name Orbit cannot accept (too long, bad
  characters) is dropped with a warning (fewer tools, never more).
- **Model:** only provider ids (`provider/model`) carry over. Kobe catalog aliases (`fast`, `smart`)
  mean nothing to Orbit and are dropped with a warning (Orbit then uses the task model).
- **Agent/experiment names:** `slugFromName(name)` and `kobe-<slug>-v<n>`.
- **Provenance** in `metadata.kobe`: version, effective approval mode, connectors, manifest format.
- **CI:** own job `orbit-loader` (not in `checks`, runs in parallel). Dependencies via
  `pip --require-hashes` from `uv export` of Orbit's `uv.lock` (`ci/orbit/requirements.txt`), Orbit
  itself from the commit tarball with `--no-deps`. `ci/orbit/check-fixtures.py` also asserts the loader
  rejects an unknown key, so a loader that stops validating is noticed.
- `yaml` added to `@kobe/server` (already used by `@kobe/agent-file`; MIT/ISC family).

## Open questions (for Chris or the coordinator)

- Should `orbit-loader` become a required status check? It is a separate job, so it is advisory
  until branch protection lists it.
- `ci/orbit/requirements.txt` is ~1900 lines (Orbit's full lock incl. Inspect extras); regenerate with
  the command in its header when bumping Orbit. A leaner subset would need re-resolving by hand.
- Model aliases are dropped, not resolved: KOBE-91 may want to pass the catalog's resolved id.
- Starters, skills and approval policy have no Orbit setup-layer field; skills are not exported.

## Evidence (acceptance criteria → test or command output)

- ac-1 (loads in Orbit without errors): `ci/orbit/check-fixtures.py` run locally (Python 3.12, Orbit
  v1.0.3 from the hashed install): `ok full.yaml`, `ok minimal.yaml`, `ok loader rejects unknown keys`;
  same step in CI job `orbit-loader`. Unit: "output satisfies the captured Orbit schema".
- ac-2 (tools match the frozen manifest): `orbit-export.test.ts` "ac-2: tools are exactly the frozen
  manifest's"; fixtures test pins the full output.
