import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routesFromPages } from "./routes.ts";

describe("routesFromPages", () => {
  it("maps app/ page files to routes, sorted, marking dynamic and signed-out ones", () => {
    const routes = routesFromPages([
      "threads/page.tsx",
      "page.tsx",
      "admin/site/[section]/page.tsx",
      "me/agents/[id]/cases/[caseId]/page.tsx",
      "sign-in/page.tsx",
      "admin/site/users/page.tsx",
      "api/healthz/route.ts",
    ]);
    assert.deepEqual(routes, [
      { route: "/", dynamic: false, signedOut: false },
      { route: "/admin/site/[section]", dynamic: true, signedOut: false },
      { route: "/admin/site/users", dynamic: false, signedOut: false },
      { route: "/me/agents/[id]/cases/[caseId]", dynamic: true, signedOut: false },
      { route: "/sign-in", dynamic: false, signedOut: true },
      { route: "/threads", dynamic: false, signedOut: false },
    ]);
  });

  it("accepts Windows separators and leaves out route groups", () => {
    assert.deepEqual(routesFromPages(["(chat)\\threads\\page.tsx"]), [
      { route: "/threads", dynamic: false, signedOut: false },
    ]);
  });
});
