import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "appearance",
  label: "Appearance",
  description: "The site's name, logo, favicon and colours, shown on every page and at sign-in.",
  group: "System",
  order: 25,
  minRole: "admin",
  status: READY,
});
