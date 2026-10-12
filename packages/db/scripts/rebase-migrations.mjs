#!/usr/bin/env node
// Brings this branch's Drizzle migrations up to date with another branch (default origin/main).
//
// Parallel branches that each add a migration collide on the index (two 0004_*), the journal and
// the snapshot chain; hand-merging those corrupts the chain. Instead this script:
//   1. stashes the branch's own migrations (SQL + whether each is custom, from the snapshots),
//   2. commits their removal, so the branch's net change to drizzle/ is empty,
//   3. merges the base branch (a merge, not a rebase: replaying the original commits would
//      conflict again),
//   4. regenerates: one `drizzle-kit generate` for all schema changes, then each custom migration
//      re-created with `--custom` and its saved SQL, in original order.
//
// Usage (from packages/db, clean working tree):
//   pnpm db:rebase [base]        # steps 1-4; stops after 3 if the merge has conflicts
//   pnpm db:rebase --apply       # step 4 only, after resolving conflicts and committing the merge
//
// Hand-written migrations (first line `-- kobe:hand-written`, migration-plan.mjs) keep their SQL
// and snapshot and are only renumbered; the script refuses when it can't do that safely.
//
// Generated migrations always come before custom ones after regeneration. That suits the usual
// shape (create tables, then enable RLS); a custom data migration that must sit between two
// schema changes needs splitting across branches.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  handWrittenBaseProblem,
  isHandWritten,
  rechainSnapshot,
  regenerationSteps,
  sameSchema,
} from "./migration-plan.mjs";

const DRIZZLE = "drizzle";
const JOURNAL = `${DRIZZLE}/meta/_journal.json`;
const STASH = ".migration-stash.json";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`db:rebase: ${message}`);
  process.exit(1);
}

function snapshotPath(idx) {
  return `${DRIZZLE}/meta/${String(idx).padStart(4, "0")}_snapshot.json`;
}

function readJson(path, ref) {
  const text = ref ? git("show", `${ref}:./${path}`) : readFileSync(path, "utf8");
  return JSON.parse(text);
}

/** A custom migration leaves the schema snapshot unchanged apart from its id chain. */
function isCustom(idx) {
  return sameSchema(readJson(snapshotPath(idx)), readJson(snapshotPath(idx - 1)));
}

/** The newest snapshot at `ref`. */
function lastSnapshot(ref) {
  const { entries } = readJson(JOURNAL, ref);
  return readJson(snapshotPath(entries[entries.length - 1].idx), ref);
}

function nameOf(tag) {
  return tag.slice(tag.indexOf("_") + 1);
}

function stash(base) {
  if (git("status", "--porcelain")) fail("working tree is not clean");
  if (existsSync(STASH)) fail(`${STASH} exists: run with --apply or delete it`);
  if (base.startsWith("origin/")) git("fetch", "-q", "origin", base.slice("origin/".length));
  const mergeBase = git("merge-base", "HEAD", base);
  const baseTags = new Set(readJson(JOURNAL, base).entries.map((e) => e.tag));
  const own = readJson(JOURNAL).entries.filter((e) => !baseTags.has(e.tag));
  if (own.length === 0) {
    console.log("db:rebase: no branch-only migrations; plain `git rebase` is enough");
    return null;
  }
  const migrations = own.map((e) => {
    const sql = readFileSync(join(DRIZZLE, `${e.tag}.sql`), "utf8");
    const handWritten = isHandWritten(sql);
    return {
      name: nameOf(e.tag),
      custom: !handWritten && isCustom(e.idx),
      handWritten,
      sql,
      ...(handWritten ? { snapshot: readJson(snapshotPath(e.idx)) } : {}),
    };
  });
  const problem = handWrittenBaseProblem(migrations, lastSnapshot(mergeBase), lastSnapshot(base));
  if (problem) fail(problem);
  try {
    regenerationSteps(migrations);
  } catch (error) {
    fail(error.message);
  }
  writeFileSync(STASH, `${JSON.stringify({ base, migrations }, null, 2)}\n`);
  for (const e of own) {
    rmSync(join(DRIZZLE, `${e.tag}.sql`));
    rmSync(snapshotPath(e.idx));
  }
  git("checkout", mergeBase, "--", JOURNAL);
  git("add", "-A", DRIZZLE);
  git("commit", "-q", "-m", "chore: drop branch migrations for regeneration");
  console.log(
    `db:rebase: stashed ${own.map((e) => e.tag).join(", ")} in ${STASH} ` +
      "(the originals are also in HEAD~1)",
  );
  return base;
}

function merge(base) {
  try {
    execFileSync("git", ["merge", "--no-edit", base], { stdio: "inherit" });
    return true;
  } catch {
    if (!git("diff", "--name-only", "--diff-filter=U")) {
      fail(`merging ${base} failed (see above); ${STASH} holds your migrations`);
    }
    console.error(
      "db:rebase: merge stopped on conflicts. Resolve them, commit the merge, then run " +
        "`pnpm db:rebase --apply`.",
    );
    return false;
  }
}

function drizzleGenerate(...args) {
  execFileSync("pnpm", ["exec", "drizzle-kit", "generate", ...args], { stdio: "inherit" });
}

/** Tag of the newest journal entry (the one drizzle-kit just wrote). */
function newestTag() {
  const { entries } = readJson(JOURNAL);
  return entries[entries.length - 1].tag;
}

function apply() {
  if (!existsSync(STASH)) fail(`no ${STASH}: nothing to apply`);
  if (git("status", "--porcelain", "--untracked-files=no")) fail("working tree is not clean");
  if (git("status", "--porcelain", "--", DRIZZLE)) fail(`${DRIZZLE}/ has uncommitted changes`);
  const { base, migrations } = JSON.parse(readFileSync(STASH, "utf8"));
  try {
    regenerate(migrations);
  } catch (error) {
    // Leave drizzle/ as committed so `--apply` can simply be re-run.
    git("checkout", "--", DRIZZLE);
    git("clean", "-fdq", "--", DRIZZLE);
    fail(`regeneration failed, ${DRIZZLE}/ restored: ${error.message}`);
  }
  git("add", "-A", DRIZZLE);
  git("commit", "-q", "-m", `chore: regenerate migrations on ${base}`);
  rmSync(STASH);
  console.log(
    `db:rebase: regenerated ${migrations.length} migration(s) on ${base}. ` +
      "Reset any dev database that ran the old ones.",
  );
}

function regenerate(migrations) {
  for (const step of regenerationSteps(migrations)) {
    if (step.kind === "generate") {
      drizzleGenerate("--name", step.name);
      continue;
    }
    drizzleGenerate("--custom", "--name", step.name);
    writeFileSync(join(DRIZZLE, `${newestTag()}.sql`), step.sql);
    if (step.kind === "hand-written") {
      const { entries } = readJson(JOURNAL);
      const path = snapshotPath(entries[entries.length - 1].idx);
      const placed = readJson(path);
      const kept = rechainSnapshot(step.snapshot, { id: placed.id, prevId: placed.prevId });
      writeFileSync(path, JSON.stringify(kept, null, 2));
    }
  }
}

const arg = process.argv[2];
if (arg === "--apply") {
  apply();
} else {
  const base = stash(arg ?? "origin/main");
  if (base !== null && merge(base)) apply();
}
