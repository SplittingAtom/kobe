import type { Hono } from "hono";
import { z } from "zod";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { FRAME_HEADERS } from "../artifacts/serve.js";
import { mayLoadAppFrame, WEBRTC_GUARD } from "../connectors/app-frame.js";
import { uuidSchema } from "../threads/schemas.js";

/** The message type the parent page posts the output's HTML with. */
export const NOTEBOOK_OUTPUT_FRAME_MESSAGE = "kobe.notebook.html";

/**
 * The frame's whole document. It writes the HTML its parent (Kobe's page) posts, once, and then
 * is that document: the header CSP (`sandbox` without `allow-same-origin`, `connect-src 'none'`)
 * and the WebRTC guard stay in force, since `document.open` keeps the window and its policy.
 */
const SHELL =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  WEBRTC_GUARD +
  "<script>(function(){var shown=false;window.addEventListener('message',function(e){" +
  "if(shown||e.source!==window.parent)return;var d=e.data;" +
  `if(!d||d.type!==${JSON.stringify(NOTEBOOK_OUTPUT_FRAME_MESSAGE)}||typeof d.html!=='string')return;` +
  "shown=true;document.open();document.write(d.html);document.close();});})();</script>" +
  "</head><body></body></html>";

const querySchema = z.strictObject({ team: uuidSchema });

/**
 * `GET /v1/workspace/output-frame?team=` (KOBE-465, notebooks NB4): the document of the iframe a
 * notebook's HTML output (and only that) is shown in. The page never puts kernel HTML into its
 * own DOM and never uses `srcdoc` (a `srcdoc` document inherits the page's CSP and origin rules):
 * it loads this fixed shell with the artifact frame's headers, so an opaque origin with no
 * cookies and no network, and posts the HTML to it. Only for frame loads from Kobe's own page and
 * the active team the page names, like the workspace frame.
 */
export function registerNotebookOutputFrame(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
): void {
  app.get("/output-frame", (c) => {
    if (!mayLoadAppFrame(c.req.raw.headers, deps.publicUrl)) {
      return c.json({ code: "forbidden_origin", message: "Cross-origin request rejected." }, 403);
    }
    const query = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) {
      return c.json(
        { code: "invalid_request", message: "That is not a valid frame request." },
        400,
      );
    }
    const activeTeamId = c.get("team").id;
    if (query.data.team !== activeTeamId) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId,
        },
        409,
      );
    }
    return new Response(SHELL, { headers: FRAME_HEADERS });
  });
}
