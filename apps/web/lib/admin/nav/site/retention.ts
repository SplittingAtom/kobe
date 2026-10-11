import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "retention",
  label: "Retention maximum",
  description: "The longest retention period any team may choose.",
  group: "Governance",
  order: 40,
  minRole: "admin",
  status: READY,
});
