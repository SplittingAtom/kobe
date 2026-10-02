import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "models",
  label: "Models and providers",
  description: "Provider keys and the model catalog with aliases (the ceiling for teams).",
  group: "Models and connectors",
  order: 10,
  minRole: "admin",
  status: comingIn("KOBE-44"),
});
