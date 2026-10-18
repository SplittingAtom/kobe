// KOBE-255: "Site" replaced "Install" in the API and code; KOBE-256 in the database and the drizzle
// objects that mirror it. Fails when code (tests included) under the scanned areas still names the
// scope "install" in an identifier, an API path, a permission or a file name. Kept on purpose: the
// historical audit action names (hash-chained rows keep them), stored values, and the verb (helm install, installMemoryHooks). Run by check-site-wording.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "drizzle"]);
const SOURCE = /\.(ts|tsx|mts|mjs|js|sh)$/;

/** Identifiers that mean installing something (a verb), not the scope. */
const ALLOWED = new Set(["installMemoryHooks"]);

/** Audit actions recorded before the rename (HISTORICAL_AUDIT_ACTIONS); readers accept them. */
const HISTORICAL = /^(?:install\.settings\.updated|identity\.install_role\.(?:granted|revoked))$/;

/** camelCase, PascalCase or UPPER_CASE names with the scope in them (not snake_case DB names). */
const IDENTIFIER = /[a-z0-9]Install|^install[A-Z]|^Install[A-Z]|INSTALL_|_INSTALL|^INSTALL$/;

const PATTERNS = [
  { what: "API path", re: /\/v1\/install\b|[?&]level=install\b/g, keep: () => true },
  { what: "permission", re: /\binstall\.[a-z_]+\.[a-z_]+\b/g, keep: () => true },
  {
    what: "module path",
    re: /\binstall-(?!gvisor|agent-sandbox)[\w-]+\.(?:js|ts|tsx)\b/g,
    keep: () => true,
  },
  {
    // KOBE-256 renamed the tables, types and columns: SQL in code must use the site_* names.
    what: "database name",
    re: /\binstall_(?:settings|roles|role(?![.\w])|model_\w+|budget_\w+|tool_rules|agent\w*|skill\w*)\b/g,
    keep: () => true,
  },
  {
    // KOBE-307 renamed personal skills' site_skill* tables to personal_skill*; the site skill
    // blocklist (skill_blocklist, siteSkillBlocklistRoutes) is the Site's and keeps its name.
    what: "personal skill name",
    re: /\bsite_skill(?:s|_versions?|_scans?)(?:_\w+)?\b|\b[sS]iteSkill(?:s|Versions?|Scans?)\b/g,
    keep: () => true,
  },
  {
    what: "identifier",
    re: /[\w$]*(?:install|Install|INSTALL)[\w$]*/g,
    keep: (t) => IDENTIFIER.test(t),
  },
];

/** A line that refers to an old name on purpose (e.g. a test that it is gone) says so. */
const ALLOW_MARK = "site-identifiers: allow";
/** A whole file about the rename itself (its upgrade tests) says so once, with the reason. */
const ALLOW_FILE_MARK = "site-identifiers: allow-file";

/** Every place a source text names the scope "install" in code. */
export function identifierFindings(source) {
  if (source.includes(ALLOW_FILE_MARK)) return [];
  const code = source
    .split("\n")
    .filter((line) => !line.includes(ALLOW_MARK))
    .join("\n");
  return PATTERNS.flatMap(({ what, re, keep }) =>
    [...code.matchAll(re)]
      .map((m) => m[0])
      .filter((token) => keep(token) && !ALLOWED.has(token) && !HISTORICAL.test(token))
      .map((token) => `${what} ${token}`),
  );
}

/** A file or directory named after the scope (install-*.ts, …/install/…). */
export function isInstallPath(path) {
  return /(?:^|\/)install(?:\/|$|-(?!gvisor|agent-sandbox))|-install\.\w/.test(path);
}

export function selfTestIdentifiers() {
  const bad = [
    'app.use(requireInstallPermission("install.users.manage"))',
    'fetch("/v1/install/users")',
    "const INSTALL_SECTIONS = []",
    "apiRequest('/v1/memory/settings?level=install')",
    "export function InstallUsagePage() {}",
    'await import("/app/dist/invitations/install-invites.js")',
    "db.select().from(installRoles)",
    "SELECT value FROM install_settings WHERE key = $1",
    "JOIN install_agents a ON a.id = t.site_agent_id",
    "db.select().from(siteSkills).innerJoin(siteSkillVersions, on)",
    "INSERT INTO site_skill_scans (skill_id) VALUES ($1)",
    'ALTER TABLE personal_skills DROP CONSTRAINT "site_skills_pkey"',
    "DROP TRIGGER site_skill_versions_immutable ON personal_skill_versions",
  ];
  const good = [
    "db.select().from(siteRoles).where(eq(siteSettings.key, k))",
    'action: "install.settings.updated", // historical',
    "helm install kobe charts/kobe; installMemoryHooks(pi)",
    "INSERT INTO site_tool_rules; scope: 'install'",
    'action: "memory.install_settings_changed", // historical',
    'db.select().from(personalSkills); api.route("/site/skill-blocklist", siteSkillBlocklistRoutes(d))',
    "SELECT value FROM site_skill_settings; db.select().from(siteSkillSettings)",
  ];
  const missed = bad.filter((s) => identifierFindings(s).length === 0);
  const flagged = good.filter((s) => identifierFindings(s).length > 0);
  const paths = [
    isInstallPath("services/server/src/routes/install-users.ts"),
    isInstallPath("apps/web/components/admin/install/users-page.tsx"),
    !isInstallPath("scripts/install-gvisor-k3s.sh"),
    !isInstallPath("services/server/src/routes/site-users.ts"),
  ];
  if (missed.length || flagged.length || paths.includes(false)) {
    console.error("site identifiers: self-test failed", { missed, flagged, paths });
    process.exit(2);
  }
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? [path, ...files(path)] : [path];
  });
}

/** Findings under `areas` (relative to `root`), one line each. */
export function siteIdentifierHits(root, areas) {
  return areas.flatMap((area) =>
    files(join(root, area)).flatMap((path) => {
      const rel = relative(root, path);
      const named = isInstallPath(rel) ? [`${rel}: file name`] : [];
      if (!SOURCE.test(path)) return named;
      const found = identifierFindings(readFileSync(path, "utf8")).map((f) => `${rel}: ${f}`);
      return [...named, ...found];
    }),
  );
}
