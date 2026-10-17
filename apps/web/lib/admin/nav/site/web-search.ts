import { defineSiteSection, onHold } from "../types";

export default defineSiteSection({
  id: "web-search",
  label: "Web search",
  description: "Choose the web search provider and its key; off until configured.",
  group: "Models and connectors",
  order: 30,
  minRole: "admin",
  // Chris put the provider choice on hold (KOBE-291): keep the placeholder, say why.
  status: onHold("KOBE-63", "Web search is on hold while the provider is chosen."),
});
