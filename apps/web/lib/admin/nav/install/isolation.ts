import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "isolation",
  label: "Isolation",
  description: "Whether agents can run: the gVisor or Kata runtime check and how to fix it.",
  group: "System",
  order: 10,
  minRole: "admin",
  status: READY,
});
