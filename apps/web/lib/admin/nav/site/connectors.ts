import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "connectors",
  label: "Connector registry",
  description: "Register the MCP servers teams may enable. Tool review follows with KOBE-101.",
  group: "Models and connectors",
  order: 20,
  minRole: "admin",
  status: READY,
});
