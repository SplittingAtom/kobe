import {
  anthropicMessagesApi,
  createAssistantMessageEventStream,
  createProvider,
  googleGenerativeAIApi,
  openAICompletionsApi,
} from "@earendil-works/pi-ai";
import { registerKobeModels, type ExtensionApiLike } from "./register.js";
import { readModelState } from "./state-file.js";

/**
 * kobe-models: the Pi 1.0.x extension that gives Pi the run's model through the Kobe model
 * gateway (spec D30; KOBE-41). kobe-sandbox-agent loads it with `--extension <root-owned path>`
 * (before kobe-policy) into every `pi --mode rpc` it starts with a model, together with
 * `--model kobe/<gateway model>` and the model file (`KOBE_MODEL_FILE`, see protocol.ts).
 *
 * Self-contained by design: node builtins, `@earendil-works/pi-ai` (Pi's own copy, aliased by
 * its extension loader) and files in this directory, because the image ships it on its own
 * (root-owned, read-only, `/opt/kobe/pi-extensions/kobe-models`).
 */
export default function kobeModels(api: ExtensionApiLike): Promise<void> {
  return registerKobeModels(api, {
    env: process.env,
    readState: readModelState,
    pi: { createProvider, createAssistantMessageEventStream },
    apis: {
      "openai-completions": openAICompletionsApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
    },
    // stderr only: stdout is Pi's RPC stream.
    warn: (message) => process.stderr.write(`${message}\n`),
  });
}
