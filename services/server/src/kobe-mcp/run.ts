import { agentConnectors, type AgentFrontmatter } from "@kobe/agent-file";
import type { KobeTx } from "@kobe/db";
import { matchGlob, type RunMcpServer } from "@kobe/protocol";
import { allowedKobeTools, loadKobeAccess, loadKobeBuiltin } from "./access.js";
import { kobePinnedTool } from "./pinned.js";

/**
 * The built-in Kobe connector in a run's `run.start.mcp` (KOBE-619, spec §3, KA7): admin tools
 * follow the agent's connector list (`kobe` by the row's name, or `all`), only for a run a person
 * can answer (not scheduled, not a skill eval or test chat), only the tools the person may use now
 * (switches and permission), filtered by the agent's tool globs, and not when the owner turned the
 * connector off for the thread. Undefined: the run gets no Kobe server. The MCP proxy's re-check
 * decides every call again.
 */
export async function kobeRunServer(
  tx: KobeTx,
  run: {
    readonly teamId: string;
    readonly userId: string;
    /** A person can answer this run (user-triggered; not an eval, test chat or grantless run). */
    readonly answerable: boolean;
    readonly frontmatter: AgentFrontmatter;
    /** Connector ids the owner turned off for the thread. */
    readonly off: ReadonlySet<string>;
  },
): Promise<RunMcpServer | undefined> {
  if (!run.answerable) return undefined;
  const row = await loadKobeBuiltin(tx);
  if (!row || run.off.has(row.id)) return undefined;
  const { all, names } = agentConnectors(run.frontmatter);
  if (!all && !names.includes(row.name)) return undefined;
  const access = await loadKobeAccess(tx, run.teamId, run.userId);
  const globs = run.frontmatter.tools;
  const allowedByAgent = (piName: string) =>
    !(globs?.deny?.some((g) => matchGlob(g, piName)) ?? false) &&
    (globs?.allow === undefined || globs.allow.some((g) => matchGlob(g, piName)));
  const tools = allowedKobeTools(access)
    .map((t) => kobePinnedTool(row.name, t))
    .filter((t) => allowedByAgent(t.pi_name))
    .map((t) => ({ name: t.name, pi_name: t.pi_name }));
  return tools.length === 0 ? undefined : { name: row.name, connector_id: row.id, tools };
}
