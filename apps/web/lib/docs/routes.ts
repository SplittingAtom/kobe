import { webConfig } from "../config";
import { getSiteBranding } from "../theme/branding-server";
import type { LlmsContext } from "./llms";
import { publicOrigin } from "./public-origin";

/**
 * What the guide's text routes (KOBE-616: /llms.txt, /llms-full.txt, /docs/<slug>.md) need from
 * the deployment: the site branding's app name and the public origin. They need no session: the
 * guide holds no team or user data, and the web has no auth gate in front of routes (each page's
 * data comes from the server's API with the browser's cookie).
 */
export async function llmsContext(request: Request): Promise<LlmsContext> {
  const { appName } = await getSiteBranding();
  return { appName, origin: publicOrigin(request, webConfig().publicUrl) };
}
