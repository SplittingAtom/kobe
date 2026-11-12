import { agentConnectors, type AgentFrontmatter } from "@kobe/agent-file";
import type { KobeTx } from "@kobe/db";
import { matchGlob, type RunMcpServer } from "@kobe/protocol";
import { allowedKobeTools, loadKobeAccess, loadKobeBuiltin } from "./access.js";
import { KOBE_DOCS_TOOLS } from "./docs/index.js";
import { kobePinnedTool } from "./pinned.js";

/**
 * The built-in Kobe connector in a run's `run.start.mcp` (KOBE-619, spec §3, KA7):
 *
 * - the **docs tools** (KOBE-620) are on every run whatever the agent's connector list: runs
 *   without an agent, scheduled runs, skill evals and test chats included;
 * - the **admin tools** follow the agent's connector list (`kobe` by the row's name, or `all`),
 *   only for a run a person can answer (not scheduled, not a skill eval or test chat), only the
 *   tools the person may use now (switches and permission).
 *
 * Both are filtered by the agent's tool globs, and nothing is attached while the site switch is
 * `off` or when the owner turned the connector off for the thread. Undefined: the run gets no Kobe
 * server. The MCP proxy's re-check decides every call again.
 */
export async function kobeRunServer(
  tx: KobeTx,
  run: {
    readonly teamId: string;
    readonly userId: string;
    /** A person can answer this run (user-triggered; not an eval, test chat or grantless run). */
    readonly answerable: boolean;
    /** The agent's frontmatter; undefined for a run without an agent (docs tools only). */
    readonly frontmatter: AgentFrontmatter | undefined;
    /** Connector ids the owner turned off for the thread. */
    readonly off: ReadonlySet<string>;
  },
): Promise<RunMcpServer | undefined> {
  const row = await loadKobeBuiltin(tx);
  if (!row || run.off.has(row.id)) return undefined;
  const globs = run.frontmatter?.tools;
  const allowedByAgent = (piName: string) =>
    !(globs?.deny?.some((g) => matchGlob(g, piName)) ?? false) &&
    (globs?.allow === undefined || globs.allow.some((g) => matchGlob(g, piName)));
  const admin = await adminTools(tx, row.name, run);
  const tools = [...KOBE_DOCS_TOOLS, ...admin]
    .map((t) => kobePinnedTool(row.name, t))
    .filter((t) => allowedByAgent(t.pi_name))
    .map((t) => ({ name: t.name, pi_name: t.pi_name }));
  return tools.length === 0 ? undefined : { name: row.name, connector_id: row.id, tools };
}

async function adminTools(tx: KobeTx, rowName: string, run: Parameters<typeof kobeRunServer>[1]) {
  if (!run.answerable || run.frontmatter === undefined) return [];
  const { all, names } = agentConnectors(run.frontmatter);
  if (!all && !names.includes(rowName)) return [];
  return allowedKobeTools(await loadKobeAccess(tx, run.teamId, run.userId));
}
