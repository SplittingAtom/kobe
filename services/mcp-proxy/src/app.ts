import { Hono } from "hono";

const SERVICE = "mcp-proxy";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok", service: SERVICE }));
  app.get("/readyz", (c) => c.json({ status: "ready", service: SERVICE }));
  return app;
}
