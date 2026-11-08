import { AgentsPage } from "../../components/agents/agents-page";
import { agentTabParam } from "../../lib/agents/tabs";

/** The Agents page (KOBE-569, AR1); `?tab=` opens Personal, Team or Site, else the last one used. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tab = agentTabParam((await searchParams).tab);
  // Keyed by the tab: a link to another ?tab= while on the page opens that tab.
  return <AgentsPage key={tab ?? "remembered"} requestedTab={tab} />;
}
