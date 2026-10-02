import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "web-search",
  label: "Web search",
  description: "Choose the web search provider and its key; off until configured.",
  group: "Models and connectors",
  order: 30,
  minRole: "admin",
  status: comingIn("KOBE-63"),
});
