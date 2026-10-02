import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const server = serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ msg: "listening", service: "server", port: info.port }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "shutting down", service: "server", signal }));
  server.close((err) => {
    if (err)
      console.error(
        JSON.stringify({ msg: "shutdown error", service: "server", error: String(err) }),
      );
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
