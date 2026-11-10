# Bifrost capture harness (KOBE-414)

Records what Bifrost forwards upstream for the request bodies Kobe's model gateway writes. Used for
`docs/design/bifrost-request-rewrite.md`; re-run it before any Bifrost image bump.

- `capture-server.mjs`: a dependency-free Node server standing in for every provider. It records
  each upstream request and answers with a canned response in the API's shape (JSON or SSE).
  `GET /__captured` returns and clears the record.
- `make-cases.mjs`: Pi-style bodies run through the gateway's own rewrite (`applyThinking`, then
  `withStreamUsage`, in `gateway.ts` order) for every thinking level and output limit, plus raw
  duplicate-key bodies and bodies for models without a thinking control.
- `bifrost-config.json`: Kobe's `client` settings (`charts/kobe/templates/_models.tpl`) with four
  providers (Anthropic, OpenAI, Ollama, an OpenAI-compatible custom provider) pointed at the
  capture server. Inference auth is off (no virtual keys); governance does not touch bodies.
- `drive.mjs`: sends every case to Bifrost and pairs it with what the capture server received.
- `run.sh`: one Bifrost image end to end on the Docker host `DOCKER_HOST` points at: a private
  network, the three containers (nothing published on host ports), results and Bifrost's log,
  then removes the containers and network. It leaves images alone.
- `compare.mjs`: per-case diff of sent versus forwarded (`-` removed, `+` added, `~` changed);
  given two result files it prints both versions side by side.

```bash
npx pnpm@12.8.1 --filter @kobe/model-gateway... build
node tools/bifrost-capture/make-cases.mjs > /tmp/cases.json
tools/bifrost-capture/run.sh docker.io/maximhq/bifrost@sha256:<digest> v225 /tmp/cases.json /tmp/out
tools/bifrost-capture/run.sh docker.io/maximhq/bifrost:v2.5.1 v251 /tmp/cases.json /tmp/out
node tools/bifrost-capture/compare.mjs /tmp/out/results-v225.json /tmp/out/results-v251.json
```

Needs a Node image on the Docker host (`NODE_IMAGE`, default `node:24-slim`). The model names in
the cases matter: Bifrost changes some fields per model (for example `thinking.display` only for
Opus 4.7 and later).
