import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "connectors",
  label: "Connector registry",
  description: "Register MCP servers, review pinned tools and re-approve drifted ones.",
  group: "Models and connectors",
  order: 20,
  minRole: "admin",
  status: comingIn("KOBE-59"),
});
