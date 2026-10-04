import { createFakeLlm } from "./fake-llm.js";

/**
 * e2e only: `node dist/testing/fake-llm-main.js` serves the fake model provider on $PORT (default
 * 8080). Never started by the shim itself.
 */
const port = Number(process.env.PORT ?? 8080);
createFakeLlm().listen(port, () => {
  process.stdout.write(`fake llm upstream listening on ${port}\n`);
});
