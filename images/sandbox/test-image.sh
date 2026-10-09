#!/usr/bin/env bash
# Acceptance checks for the Kobe sandbox image (KOBE-21). Usage: test-image.sh <image>
# Runs the image like a sandbox pod: uid 1000, read-only root filesystem, all capabilities dropped,
# no-new-privileges, with writable /tmp, $HOME and (where a check needs it) /workspace.
set -euo pipefail
IMAGE="${1:?usage: $0 <image>}"
failed=0
HARDENED=(--rm --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000
  --tmpfs /tmp --tmpfs /home/kobe:uid=1000,gid=1000)

run() { docker run "${HARDENED[@]}" --entrypoint "$1" "$IMAGE" "${@:2}"; }
run_ws() { docker run "${HARDENED[@]}" --tmpfs /workspace:uid=1000,gid=1000 --entrypoint "$1" "$IMAGE" "${@:2}"; }

check() { # name, expected-regex, runner, command...
  local name="$1" expect="$2" runner="$3" out
  shift 3
  if out="$("$runner" "$@" 2>&1)" && grep -Eq "$expect" <<<"$out"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: ${out}"
    failed=1
  fi
}

check "runs as non-root uid 1000" '^1000$' run id -u
host() { "$@"; }
check "image default user is 1000:1000" '^1000:1000$' host docker image inspect --format '{{.Config.User}}' "$IMAGE"
check "pi is 1.0.x" '(^|[^0-9])1\.0\.[0-9]+' run pi --version
check "node is 22.x (>= 22.19)" '^v22\.(19|[2-9][0-9])\.' run node --version
check "python is 3.12" '^Python 3\.12\.' run python3 --version
check "python data stack imports" '^ok$' run python3 -c \
  'import pandas, numpy, duckdb, pyarrow, matplotlib, openpyxl, docx, reportlab, pypdf; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.figure(); print("ok")'
check "duckdb queries" '^42$' run python3 -c 'import duckdb; print(duckdb.sql("select 42").fetchone()[0])'
check "git and CLIs present" '^ok$' run sh -c 'for b in git curl jq rg unzip zip file; do command -v $b >/dev/null || { echo "missing $b"; exit 1; }; done; echo ok'
# The agent must start and refuse to run without its server URL (exits non-zero by design).
check "kobe-sandbox-agent installed" 'KOBE_SERVER_URL must be a ws' run sh -c 'node /opt/kobe/sandbox-agent/dist/index.js 2>&1; true'
check "agent ships only dist, deps and manifest" '^ok$' run sh -c \
  'cd /opt/kobe/sandbox-agent && [ "$(ls -A | sort | tr "\n" " ")" = "dist node_modules package.json " ] && echo ok || ls -A'
check "entrypoint is tini, then the hardened launcher" '^\[/usr/bin/tini -- /opt/kobe/entrypoint.sh\]$' host \
  docker image inspect --format '{{.Config.Entrypoint}}' "$IMAGE"
check "tini is PID 1 under the entrypoint" '^tini$' run /usr/bin/tini -- sh -c 'cat /proc/1/comm'
check "launcher: no core dumps, NODE_OPTIONS dropped, --disable-sigusr1" '^ok$' run sh -c \
  'f=/opt/kobe/entrypoint.sh; grep -q "^ulimit -c 0$" $f && grep -q "^unset NODE_OPTIONS$" $f && grep -q "exec node --disable-sigusr1 " $f && [ "$(stat -c %u:%a $f)" = "0:555" ] && echo ok'
check "node honours --disable-sigusr1" '^undefined$' run node --disable-sigusr1 -e \
  'process.kill(process.pid,"SIGUSR1");setTimeout(()=>console.log(String(require("inspector").url())),300)'
# Through the real entrypoint: tini → launcher → agent, which fails fast without configuration.
check "agent starts through the entrypoint" 'KOBE_SERVER_URL must be a ws' host sh -c \
  "docker run ${HARDENED[*]} -e NODE_OPTIONS=--inspect=0.0.0.0:9229 \"$IMAGE\" 2>&1; true"
check "no baked-in Pi config dir (each Pi gets a private one under /tmp, KOBE-41)" '^absent$' run sh -c \
  '[ -e /opt/kobe/pi-agent ] && echo present || echo absent'
check "kobe-models extension: root-owned, read-only, .js only" '^0:0 555 ok$' run sh -c \
  'd=/opt/kobe/pi-extensions/kobe-models; echo "$(stat -c "%u:%g %a" $d) $(for f in $d/*; do case "$f" in *.js) [ "$(stat -c "%u:%g %a" "$f")" = "0:0 444" ] || echo "bad $f";; *) echo "extra $f";; esac; done; [ -f $d/index.js ] && echo ok)"'
check "agent accepts the baked kobe-models file" '^ok$' run node --input-type=module -e \
  'import { checkExtensionFile as c } from "/opt/kobe/sandbox-agent/dist/policy/extension-file.js"; await c("/opt/kobe/pi-extensions/kobe-models/index.js", "kobe-models"); console.log("ok")'
check "kobe-policy extension: root-owned, read-only, .js only" '^0:0 555 0:0 555 ok$' run sh -c \
  'd=/opt/kobe/pi-extensions/kobe-policy; echo "$(stat -c "%u:%g %a" ${d%/*}) $(stat -c "%u:%g %a" $d) $(for f in $d/*; do case "$f" in *.js) [ "$(stat -c "%u:%g %a" "$f")" = "0:0 444" ] || echo "bad $f";; *) echo "extra $f";; esac; done; [ -f $d/index.js ] && echo ok)"'
check "agent accepts the baked kobe-policy file" '^ok$' run node --input-type=module -e \
  'import { checkPolicyExtensionFile as c } from "/opt/kobe/sandbox-agent/dist/policy/extension-file.js"; await c("/opt/kobe/pi-extensions/kobe-policy/index.js"); console.log("ok")'
check "kobe-tools extension: root-owned, read-only, .js only" '^0:0 555 0:0 555 ok$' run sh -c \
  'd=/opt/kobe/pi-extensions/kobe-tools; echo "$(stat -c "%u:%g %a" ${d%/*}) $(stat -c "%u:%g %a" $d) $(for f in $d/*; do case "$f" in *.js) [ "$(stat -c "%u:%g %a" "$f")" = "0:0 444" ] || echo "bad $f";; *) echo "extra $f";; esac; done; [ -f $d/index.js ] && echo ok)"'
check "agent accepts the baked kobe-tools file" '^ok$' run node --input-type=module -e \
  'import { checkExtensionFile as c } from "/opt/kobe/sandbox-agent/dist/policy/extension-file.js"; await c("/opt/kobe/pi-extensions/kobe-tools/index.js", "kobe-tools"); console.log("ok")'
check "the image turns kobe-tools on (KOBE_TOOLS_EXTENSION names the baked file)" '^/opt/kobe/pi-extensions/kobe-tools/index.js$' run sh -c 'echo $KOBE_TOOLS_EXTENSION'
check "kobe-exec extension (KOBE-167): root-owned, read-only, .js only" '^0:0 555 0:0 555 ok$' run sh -c \
  'd=/opt/kobe/pi-extensions/kobe-exec; echo "$(stat -c "%u:%g %a" ${d%/*}) $(stat -c "%u:%g %a" $d) $(for f in $d/*; do case "$f" in *.js) [ "$(stat -c "%u:%g %a" "$f")" = "0:0 444" ] || echo "bad $f";; *) echo "extra $f";; esac; done; [ -f $d/index.js ] && echo ok)"'
check "agent accepts the baked kobe-exec file" '^ok$' run node --input-type=module -e \
  'import { checkExtensionFile as c } from "/opt/kobe/sandbox-agent/dist/policy/extension-file.js"; await c("/opt/kobe/pi-extensions/kobe-exec/index.js", "kobe-exec"); console.log("ok")'
check "the image turns kobe-exec on (KOBE_EXEC_EXTENSION names the baked file)" '^/opt/kobe/pi-extensions/kobe-exec/index.js$' run sh -c 'echo $KOBE_EXEC_EXTENSION'
# kobe-tools (KOBE-128) as the agent starts it: fd 3 the policy socket, fd 4 the kobe-tools socket.
# A scripted model (pi-ai faux provider, in /tmp) calls create_artifact; this script plays kobe-policy
# (allows) and the agent's end of fd 4 (answers artifact.put), and the tool result must carry the
# artifact id and version. Without fd 4 (KOBE_TOOLS_FD unset) the tool must not exist.
KOBE_TOOLS_PROBE='
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.argv[1];
const withFd4 = mode !== "nofd4";
const leak = mode === "leak";
fs.mkdirSync("/tmp/pi-agent", { recursive: true });
fs.writeFileSync("/tmp/faux.mjs", `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
  const f = fauxProvider({ provider: "kobe-faux", models: [{ id: "scripted" }] });
  f.setResponses([
    fauxAssistantMessage(${leak ? `fauxToolCall("bash", { command: "ls -l /proc/$$/fd/" }, { id: "ca1" })` : `fauxToolCall("create_artifact", { kind: "markdown", title: "T", content: "# hi" }, { id: "ca1" })`}, { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  pi.registerProvider(f.provider);
  const select = async (_e, ctx) => { if (ctx.model?.provider !== "kobe-faux") await pi.setModel(f.getModel()); };
  pi.on("session_start", select);
  pi.on("input", select);
}`);
const env = { PATH: process.env.PATH, HOME: "/home/kobe", PI_CODING_AGENT_DIR: "/tmp/pi-agent",
  PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", KOBE_POLICY_FD: "3" };
if (withFd4) env.KOBE_TOOLS_FD = "4";
const p = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-approve", "--no-context-files",
  "--extension", "/tmp/faux.mjs", "--extension", "/opt/kobe/pi-extensions/kobe-tools/index.js",
  "--extension", "/opt/kobe/pi-extensions/kobe-policy/index.js"], { cwd: "/workspace", env,
  stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"] });
const done = (msg, code) => { console.log(msg); p.kill("SIGKILL"); process.exit(code); };
setTimeout(() => done("timeout", 1), 60000);
const sock = (n) => withFd4 ? fs.readlinkSync("/proc/" + p.pid + "/fd/" + n) : "";
const lines = (stream, onLine) => { let b = ""; stream.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { onLine(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } }); };
lines(p.stdio[3], (m) => {
  if (m.type === "channel.ready") p.stdin.write(JSON.stringify({ type: "prompt", id: "p", message: "go" }) + "\n");
  if (m.type === "policy.check") p.stdio[3].write(JSON.stringify({ type: "policy.result", request_id: m.request_id, tool_call_id: m.tool_call_id, decision: "allow", reasons: [] }) + "\n");
});
p.stdio[3].write(JSON.stringify({ type: "channel.hello", nonce: "image-test" }) + "\n");
lines(p.stdio[4], (m) => {
  if (m.op === "artifact.put" && m.tool === "create_artifact" && m.tool_call_id === "ca1")
    p.stdio[4].write(JSON.stringify({ id: m.id, ok: true, artifact_id: "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a", version: 1 }) + "\n");
});
lines(p.stdout, (m) => {
  if (m.type !== "tool_execution_end" || m.toolCallId !== "ca1") return;
  const text = m.result.content.map((c) => c.text).join("");
  if (leak) {
    // The tool lists its own fds: neither of Pi'"'"'s sockets (fd 3 policy, fd 4 kobe-tools) may show.
    const leaked = !text.includes("->") || text.includes(sock(3)) || text.includes(sock(4));
    done(leaked ? "LEAKED " + text : "ok no pi sockets", leaked ? 1 : 0);
  }
  done((m.isError ? "error " : "ok ") + text, m.isError === !withFd4 ? 0 : 1);
});'
check "kobe-tools: create_artifact goes through kobe-policy, then fd 4; the result carries artifact_id and version" \
  '^ok \{"artifact_id":"7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a","version":1\}$' run_ws node -e "$KOBE_TOOLS_PROBE" fd4
# Fail closed: a Pi without the channel (an agent that does not offer artifacts) has no such tool.
check "kobe-tools: without fd 4 no artifact tool is registered" '^error Tool create_artifact not found$' run_ws node -e "$KOBE_TOOLS_PROBE" nofd4
check "tools Pi runs do not inherit the kobe-tools socket (fd 4) or the policy socket" '^ok no pi sockets$' run_ws node -e "$KOBE_TOOLS_PROBE" leak
# Pi as the agent starts it (lockdown flags, read-only config dir), fd 3 a socket pair: kobe-policy
# must load, read channel.hello and answer channel.ready with the nonce.
check "kobe-policy loads into Pi and reports ready over fd 3" '"type":"channel.ready","nonce":"image-test","extension":"kobe-policy"' run_ws node -e '
const { spawn } = require("node:child_process");
const p = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-approve", "--no-context-files",
  "--no-skills", "--extension", "/opt/kobe/pi-extensions/kobe-policy/index.js"], { cwd: "/workspace",
  env: { PATH: process.env.PATH, HOME: "/home/kobe", PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", KOBE_POLICY_FD: "3" },
  stdio: ["pipe", "ignore", "inherit", "pipe"] });
p.stdio[3].write(JSON.stringify({ type: "channel.hello", nonce: "image-test" }) + "\n");
p.stdio[3].on("data", (d) => { process.stdout.write(d); p.kill("SIGKILL"); process.exit(0); });
setTimeout(() => { console.log("no answer from kobe-policy"); p.kill("SIGKILL"); process.exit(1); }, 30000);'
# A tool Pi runs must not hold Pi's policy socket (fd 3). A scripted model (pi-ai faux provider, in
# /tmp) makes Pi run `ls -l /proc/$$/fd/` through bash; kobe-policy asks, this script allows, and
# the listing must not show the socket Pi has on fd 3. (Pi needs a writable config dir to use any
# provider, hence /tmp/pi-agent here.)
check "tools Pi runs do not inherit the policy socket (fd 3)" '^ok socket:\[[0-9]+\]$' run_ws node -e '
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.mkdirSync("/tmp/pi-agent", { recursive: true });
fs.writeFileSync("/tmp/faux.mjs", `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
  const f = fauxProvider({ provider: "kobe-faux", models: [{ id: "scripted" }] });
  f.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "ls -l /proc/$$/fd/" }, { id: "fd1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  pi.registerProvider(f.provider);
  const select = async (_e, ctx) => { if (ctx.model?.provider !== "kobe-faux") await pi.setModel(f.getModel()); };
  pi.on("session_start", select);
  pi.on("input", select);
}`);
const p = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-approve", "--no-context-files",
  "--extension", "/tmp/faux.mjs", "--extension", "/opt/kobe/pi-extensions/kobe-policy/index.js"], { cwd: "/workspace",
  env: { PATH: process.env.PATH, HOME: "/home/kobe", PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", KOBE_POLICY_FD: "3" },
  stdio: ["pipe", "pipe", "inherit", "pipe"] });
const done = (msg, code) => { console.log(msg); p.kill("SIGKILL"); process.exit(code); };
setTimeout(() => done("timeout", 1), 60000);
const sock = fs.readlinkSync("/proc/" + p.pid + "/fd/3");
const lines = (stream, onLine) => { let b = ""; stream.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { onLine(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } }); };
lines(p.stdio[3], (m) => {
  if (m.type === "channel.ready") p.stdin.write(JSON.stringify({ type: "prompt", id: "p", message: "go" }) + "\n");
  if (m.type === "policy.check") p.stdio[3].write(JSON.stringify({ type: "policy.result", request_id: m.request_id, tool_call_id: m.tool_call_id, decision: "allow", reasons: [] }) + "\n");
});
p.stdio[3].write(JSON.stringify({ type: "channel.hello", nonce: "image-test" }) + "\n");
lines(p.stdout, (m) => {
  if (m.type !== "tool_execution_end" || m.toolCallId !== "fd1") return;
  const text = m.result.content.map((c) => c.text).join("");
  if (m.isError || !text.includes("->")) done("tool failed: " + text, 1);
  done((text.includes(sock) ? "LEAKED " : "ok ") + sock, text.includes(sock) ? 1 : 0);
});'
# kobe-models (KOBE-41) as the agent starts it: a private writable config dir, the model file with
# a token and run id, a local fake OpenAI-compatible upstream standing in for the model gateway.
# Pi must stream the upstream's answer, sending the token as the API key and the run id header, and the run
# token (KOBE-118) the extension fetched from the "agent" over RPC as x-kobe-run-token.
check "kobe-models loads into Pi and streams a model answer through the gateway client" '^ok Bearer image-token-0123456789abcdef run=11111111-1111-4111-8111-111111111111 tok=krt1.image-run-token text=hello from upstream$' run_ws node -e '
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const seen = "Bearer " + (req.headers.authorization || "").replace(/^Bearer /, "") + " run=" + (req.headers["x-kobe-run-id"] || "-") + " tok=" + (req.headers["x-kobe-run-token"] || "-");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
    res.write(chunk({ role: "assistant", content: "" }, null)); res.write(chunk({ content: "hello from upstream" }, null)); res.write(chunk({}, "stop")); res.end("data: [DONE]\n\n");
    srv.seen = seen;
  });
});
srv.listen(0, "127.0.0.1", () => {
  const dir = fs.mkdtempSync("/tmp/pi-");
  fs.mkdirSync(dir + "/agent", { mode: 0o700 });
  fs.writeFileSync(dir + "/model.json", JSON.stringify({ v: 1, gateway_url: "http://127.0.0.1:" + srv.address().port,
    model: { gateway_model: "openai/gpt-fake", api: "openai-completions" }, token: "image-token-0123456789abcdef",
    run_id: "11111111-1111-4111-8111-111111111111" }), { mode: 0o600 });
  const p = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-approve", "--no-context-files",
    "--extension", "/opt/kobe/pi-extensions/kobe-models/index.js", "--extension", "/opt/kobe/pi-extensions/kobe-policy/index.js"], { cwd: "/workspace",
    env: { PATH: process.env.PATH, HOME: "/home/kobe", PI_CODING_AGENT_DIR: dir + "/agent", KOBE_MODEL_FILE: dir + "/model.json",
      PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", KOBE_POLICY_FD: "3" },
    stdio: ["pipe", "pipe", "inherit", "pipe"] });
  const done = (msg, code) => { console.log(msg); p.kill("SIGKILL"); process.exit(code); };
  setTimeout(() => done("timeout", 1), 60000);
  const lines = (stream, onLine) => { let b = ""; stream.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { onLine(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } }); };
  lines(p.stdio[3], (m) => { if (m.type === "channel.ready") p.stdin.write(JSON.stringify({ type: "prompt", id: "p", message: "hi" }) + "\n"); });
  p.stdio[3].write(JSON.stringify({ type: "channel.hello", nonce: "image-test" }) + "\n");
  let text = "";
  lines(p.stdout, (m) => {
    // KOBE-118: the extension asks the agent for the run token over RPC (memory only, no file); answer as the agent does.
    if (m.type === "extension_ui_request" && m.method === "input" && m.title === "kobe.run_token") p.stdin.write(JSON.stringify({ type: "extension_ui_response", id: m.id, value: "krt1.image-run-token" }) + "\n");
    if (m.type === "message_update" && m.assistantMessageEvent.type === "text_delta") text += m.assistantMessageEvent.delta;
    if (m.type === "message_end" && m.message.role === "assistant" && m.message.stopReason === "error") done("model error: " + m.message.errorMessage, 1);
    if (m.type === "agent_settled") done("ok " + srv.seen + " text=" + text, 0);
  });
});'
check "egress BASH_ENV script: root-owned, read-only (KOBE-39)" '^0:0 444$' run stat -c '%u:%g %a' /opt/kobe/egress-env.sh
check "agent accepts the baked egress script" '^ok$' run node --input-type=module -e \
  'import { checkExtensionFile as c } from "/opt/kobe/sandbox-agent/dist/policy/extension-file.js"; await c("/opt/kobe/egress-env.sh", "egress-env"); console.log("ok")'
check "a tool shell gets HTTPS_PROXY from the token file through BASH_ENV (KOBE-39)" \
  '^http://9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:image.token-1@egress-proxy.kobe.internal:80$' run sh -c \
  'printf "image.token-1\n" > /tmp/egress-token && env -i PATH=/usr/bin:/bin BASH_ENV=/opt/kobe/egress-env.sh KOBE_EGRESS_TOKEN_FILE=/tmp/egress-token KOBE_EGRESS_PROXY=http://egress-proxy.kobe.internal:80 KOBE_THREAD_ID=9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d bash -c '"'"'printf "%s\n" "$HTTPS_PROXY"'"'"' < /dev/null'
check "skills directory exists, root-owned" '^0:0$' run stat -c '%u:%g' /opt/kobe/skills
# KOBE-88: built-in gallery skills. Baked read-only (root-owned, no write bit anywhere, so neither
# the agent, Pi nor a tool uid can change them) and every sample script works with no network.
SK=/opt/kobe/skills
check "built-in skills: the seven bundles with a matching SKILL.md name" '^ok$' run sh -c \
  'for n in data-analysis charts docx pdf xlsx code-review skill-creator; do grep -q "^name: $n\$" '$SK'/$n/SKILL.md || { echo "bad $n"; exit 1; }; done; echo ok'
check "built-in skills: root-owned, no write bit, nothing writable by uid 1000" '^none$' run sh -c \
  'f=$(find '$SK' \( -not -user 0 -o -not -group 0 -o -perm /222 -o -writable \) | head -3); [ -z "$f" ] && echo none || echo "$f"'
offline() { docker run "${HARDENED[@]}" --network none --workdir /tmp --entrypoint "$1" "$IMAGE" "${@:2}"; }
check "built-in skills: no skill script needs the network or a writable skills dir (--network none)" '^ok$' offline sh -c '
set -e; S='$SK'; cd /tmp; export PYTHONDONTWRITEBYTECODE=1
python $S/data-analysis/scripts/describe.py $S/data-analysis/scripts/sample.csv | grep -q "rows: 6"
python $S/data-analysis/scripts/sql.py "select region, sum(amount) a from s group by 1 order by 1" --table s=$S/data-analysis/scripts/sample.csv --out r.csv | grep -q "310.35"
python $S/charts/scripts/chart.py $S/charts/scripts/sample.csv --kind bar --x region --y amount --agg sum --title t --out c.png >/dev/null
[ "$(head -c 8 c.png | od -An -tx1 | tr -d " \n")" = 89504e470d0a1a0a ] && [ "$(wc -c < c.png)" -gt 5000 ]
python $S/docx/scripts/md_to_docx.py $S/docx/scripts/sample.md s.docx --title T >/dev/null
python $S/docx/scripts/docx_text.py s.docx | grep -q "^| south | 310.35 |"
python $S/pdf/scripts/md_to_pdf.py $S/pdf/scripts/sample.md s.pdf --title T >/dev/null
python $S/pdf/scripts/pdf_text.py s.pdf | grep -q "Sample report"
python $S/pdf/scripts/pdf_pages.py m.pdf s.pdf s.pdf:1 | grep -q "2 pages"
python $S/skill-creator/scripts/init_skill.py demo --dir /tmp/sk --scripts | grep -q "created /tmp/sk/demo/SKILL.md"
python $S/skill-creator/scripts/validate.py /tmp/sk/demo | grep -q "0 errors"
python $S/skill-creator/scripts/package.py /tmp/sk/demo --out d.zip | grep -q "Name:         demo"
python -c "import zipfile; assert zipfile.ZipFile(\"d.zip\").namelist() == [\"SKILL.md\"]"
python $S/xlsx/scripts/csv_to_xlsx.py $S/xlsx/scripts/sample.csv s.xlsx --total-row >/dev/null
python $S/xlsx/scripts/xlsx_dump.py s.xlsx --formulas | grep -q "=SUM(D2:D7)"
python $S/code-review/scripts/scan.py $S/code-review/scripts/sample.py | grep -q "4 finding"
echo ok'
check "/workspace in the image is owned by uid 1000" '^1000:1000$' run stat -c '%u:%g' /workspace
check "workspace (volume) is writable" '^ok$' run_ws sh -c 'touch /workspace/x && echo ok'
check "no setuid/setgid binaries" '^none$' run sh -c 'f=$(find / -xdev -perm /6000 -type f 2>/dev/null); [ -z "$f" ] && echo none || echo "$f"'
check "nothing outside /workspace, /tmp, \$HOME is writable by uid 1000" '^none$' run sh -c \
  'f=$(find /bin /sbin /lib /usr /opt /etc /root /var /srv -xdev -writable 2>/dev/null | grep -v "^/var/tmp" | head -5); [ -z "$f" ] && echo none || echo "$f"'
check "no private keys or credential files baked in" '^none$' run sh -c \
  'f=$( (grep -rlI "PRIVATE KEY" /opt/kobe /home/kobe /etc --exclude-dir=ssl 2>/dev/null; find /opt/kobe /home /etc -xdev \( -name ".env*" -o -name ".npmrc" -o -name "*.pem" -o -name "id_rsa*" \) -not -path "/etc/ssl/*" 2>/dev/null) | head -5); [ -z "$f" ] && echo none || echo "$f"'
check "no secrets in the environment" '^ok$' run sh -c 'env | grep -Eiq "(api_?key|token|secret|password)=" && echo leaked || echo ok'

# KOBE-71: Pi identities. The pod adds SETUID/SETGID and allows privilege escalation, and gives the
# agent (uid 1000) the groups kobe-agent (1001) and the Pi identities' groups (2000+).
PRIVSEP=(--rm --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID --user 1000:1000
  --group-add 1001 --group-add 2000 --group-add 2001 --tmpfs /tmp --tmpfs /home/kobe:uid=1000,gid=1000)
run_ps() { docker run "${PRIVSEP[@]}" --entrypoint "$1" "$IMAGE" "${@:2}"; }
R=/opt/kobe/bin/kobe-runas
check "kobe-runas: the only file with capabilities, setuid+setgid, root:kobe-agent 0750" \
  "^$R cap_setgid,cap_setuid=ep root:kobe-agent 750\$" run sh -c \
  "getcap -r /bin /sbin /lib /usr /opt /etc 2>/dev/null | tr '\n' ' '; stat -c '%U:%G %a' $R"
check "kobe-runas starts a Pi identity: own uid/gid, workspace group, no capabilities, no_new_privs, umask 002" \
  '^uid=2000 gid=2000 groups=1000,2000 caps=0000000000000000/0000000000000000 nnp=1 umask=0002$' run_ps \
  $R 2000 sh -c 'echo "uid=$(id -u) gid=$(id -g) groups=$(id -G | tr " " "\n" | sort -n | paste -sd,) caps=$(awk "/^CapPrm/{p=\$2} /^CapEff/{e=\$2} END{print p \"/\" e}" /proc/self/status) nnp=$(awk "/^NoNewPrivs/{print \$2}" /proc/self/status) umask=$(umask)"'
check "kobe-runas hands Pi fd 3 (policy), fd 4 (kobe-tools) and fd 5 (executor relay) and closes everything above" '^open3 open4 open5 closed6 closed7$' run_ps sh -c \
  "exec 3<>/dev/null 4<>/dev/null 5<>/dev/null 6<>/dev/null 7<>/dev/null; $R 2000 sh -c 'for n in 3 4 5 6 7; do if [ -e /proc/self/fd/\$n ]; then printf \"open%s \" \$n; else printf \"closed%s \" \$n; fi; done' | sed 's/ \$//'"
check "kobe-reclaim: root-owned, read-only" '^root:root 555$' run stat -c '%U:%G %a' /opt/kobe/bin/kobe-reclaim
check "as an identity, a process cannot ptrace or read the memory of its parent (--probe-ptrace)" '^probe=0$' run_ps \
  sh -c "$R 2000 --probe-ptrace; echo probe=\$?"
check "a Pi identity's processes are capped (RLIMIT_NPROC 1024)" 'Max processes +1024 +1024' run_ps $R 2000 grep 'Max processes' /proc/self/limits
check "kobe-reclaim gives an identity's private files to the workspace group" '^1000 660$' run_ps sh -c \
  "$R 2000 sh -c 'umask 077; echo s > /tmp/f'; $R 2000 /opt/kobe/bin/kobe-reclaim 1000 /tmp; stat -c '%g %a' /tmp/f"
check "kobe-reclaim reaches files inside owner-only (000) directories" '^1000 660 1000 770$' run_ps sh -c \
  "$R 2000 sh -c 'umask 077; mkdir -p /tmp/d/e; echo s > /tmp/d/e/f; echo s > /tmp/d/g; chmod 000 /tmp/d/e /tmp/d';
   $R 2000 /opt/kobe/bin/kobe-reclaim 1000 /tmp; echo \$(stat -c '%g %a' /tmp/d/e/f) \$(stat -c '%g %a' /tmp/d/e)"
check "kobe-reclaim deletes what the identity left in the runtime root (a purge dir)" '^left=0 other=kept rc=0$' run_ps sh -c \
  "mkdir -m 3777 /tmp/rt; echo keep > /tmp/rt/agent-file;
   $R 2000 sh -c 'umask 077; echo s > /tmp/rt/x; mkdir /tmp/rt/dd; echo s > /tmp/rt/dd/f; chmod 000 /tmp/rt/dd';
   $R 2000 /opt/kobe/bin/kobe-reclaim 1000 /tmp -- /tmp/rt; rc=\$?;
   echo left=\$(ls /tmp/rt | grep -vc '^agent-file\$') other=\$(cat /tmp/rt/agent-file >/dev/null && echo kept) rc=\$rc"
check "kobe-reclaim exits 70 when something the identity owns cannot be reclaimed" '^rc=70$' run_ps sh -c \
  "mkdir -m 1777 /tmp/p; $R 2000 sh -c 'echo s > /tmp/p/x'; chmod 755 /tmp/p;
   $R 2000 /opt/kobe/bin/kobe-reclaim 1000 -- /tmp/p 2>/dev/null; echo rc=\$?"
check "a Pi identity cannot run kobe-runas" 'Permission denied' run_ps sh -c "$R 2000 $R 2001 id 2>&1; true"
check "kobe-runas refuses anyone but the agent" 'only the sandbox agent' host sh -c \
  "docker run --rm --cap-drop ALL --cap-add SETUID --cap-add SETGID --user 2000:1001 --entrypoint $R \"$IMAGE\" 2001 id 2>&1; true"
check "kobe-runas refuses uids outside the Pi and partner ranges" '^64 64 64 64 64 64$' run_ps sh -c \
  "for u in 0 1000 1999 2064 2999 3064; do $R \$u id >/dev/null 2>&1; printf '%s ' \$?; done | sed 's/ \$//'"
check "--kill-all ends every process of the identity, nothing else" '^left=0 agent=alive$' run_ps sh -c \
  "sleep 60 & a=\$!; $R 2001 sleep 60 & $R 2001 sh -c 'sleep 60 & sleep 60 & wait' & sleep 1; $R 2001 --kill-all; sleep 0.3;
   echo \"left=\$(ps -eo uid=,stat= | awk '\$1==2001 && \$2 !~ /^Z/' | wc -l) agent=\$(kill -0 \$a && echo alive)\""
check "a Pi identity cannot read the agent's files or signal it" '^denied denied$' run_ps sh -c \
  "umask 077; mkdir -p /tmp/agent && echo secret > /tmp/agent/token; sleep 60 & a=\$!;
   r=\$($R 2000 cat /tmp/agent/token 2>&1 | grep -q 'Permission denied' && echo denied);
   k=\$($R 2000 sh -c \"kill -0 \$a\" 2>&1 | grep -q 'not permitted' && echo denied); echo \"\$r \$k\""
# KOBE-166: partner (tool) uids 3000-3063, one per Pi identity (uid + 1000).
PAIRED=("${PRIVSEP[@]}" --group-add 3000 --group-add 3001)
run_pair() { docker run "${PAIRED[@]}" --entrypoint "$1" "$IMAGE" "${@:2}"; }
check "passwd and group have the 64 Pi identities and their 64 partners, paired by number" '^64 64 ok$' run sh -c \
  'p=$(getent passwd | grep -c "^kobe-pi-"); t=$(getent passwd | grep -c "^kobe-tool-"); ok=ok;
   for n in 0 17 63; do [ "$(id -u kobe-pi-$n)" = "$((2000+n))" ] && [ "$(id -u kobe-tool-$n)" = "$((3000+n))" ] \
     && [ "$(id -g kobe-tool-$n)" = "$((3000+n))" ] && [ "$(id -G kobe-tool-$n)" = "$((3000+n))" ] || ok=bad; done; echo "$p $t $ok"'
check "kobe-runas starts a partner uid: own uid/gid, workspace group only, no capabilities, no_new_privs, umask 002" \
  '^uid=3001 gid=3001 groups=1000,3001 caps=0000000000000000/0000000000000000 nnp=1 umask=0002$' run_pair \
  $R 3001 sh -c 'echo "uid=$(id -u) gid=$(id -g) groups=$(id -G | tr " " "\n" | sort -n | paste -sd,) caps=$(awk "/^CapPrm/{p=\$2} /^CapEff/{e=\$2} END{print p \"/\" e}" /proc/self/status) nnp=$(awk "/^NoNewPrivs/{print \$2}" /proc/self/status) umask=$(umask)"'
check "kobe-runas hands a partner uid stdio only (no fd 3, 4 or 5)" '^closed3 closed4 closed5$' run_pair sh -c \
  "exec 3<>/dev/null 4<>/dev/null 5<>/dev/null; $R 3000 sh -c 'for n in 3 4 5; do if [ -e /proc/self/fd/\$n ]; then printf \"open%s \" \$n; else printf \"closed%s \" \$n; fi; done' | sed 's/ \$//'"
check "the tool executor (KOBE-167) runs as a partner uid, from the agent's dist, and answers on its stdio" \
  '^\{"id":"a","ok":true,"kind":"dir","size":[0-9]+\}$' run_pair sh -c \
  "printf '{\"id\":\"a\",\"op\":\"stat\",\"path\":\"/tmp\"}\n' | $R 3000 node /opt/kobe/sandbox-agent/dist/exec/executor/main.js"
check "as a partner uid, a process cannot ptrace or read the memory of its parent (--probe-ptrace)" '^probe=0$' run_pair \
  sh -c "$R 3000 --probe-ptrace; echo probe=\$?"
check "a partner uid cannot run kobe-runas" 'Permission denied' run_pair sh -c "$R 3000 $R 2000 id 2>&1; true"
check "a partner uid cannot signal its Pi, write the Pi's private dir or read its /proc environ" '^denied denied denied$' run_pair sh -c \
  "mkdir -m 2770 /tmp/pidir; chgrp 2000 /tmp/pidir; $R 2000 sleep 60 & sleep 0.5; p=\$(pgrep -u 2000 sleep);
   k=\$($R 3000 kill -9 \$p 2>&1 | grep -q 'not permitted' && echo denied);
   w=\$($R 3000 sh -c 'echo x > /tmp/pidir/f' 2>&1 | grep -q 'Permission denied' && echo denied);
   e=\$($R 3000 cat /proc/\$p/environ 2>&1 | grep -q 'Permission denied' && echo denied); echo \"\$k \$w \$e\""
check "--kill-all ends every process of a partner uid, nothing else" '^left=0 pi=alive$' run_pair sh -c \
  "$R 2000 sleep 60 & $R 3000 sleep 60 & $R 3000 sh -c 'sleep 60 & sleep 60 & wait' & sleep 1; $R 3000 --kill-all; sleep 0.3;
   echo \"left=\$(ps -eo uid=,stat= | awk '\$1==3000 && \$2 !~ /^Z/' | wc -l) pi=\$([ \$(pgrep -cu 2000 sleep) -ge 1 ] && echo alive)\""
check "kobe-reclaim gives a partner uid's private files to the workspace group" '^1000 660$' run_pair sh -c \
  "$R 3000 sh -c 'umask 077; echo s > /tmp/f'; $R 3000 /opt/kobe/bin/kobe-reclaim 1000 /tmp; stat -c '%g %a' /tmp/f"
run_pair_ws() { docker run "${PAIRED[@]}" --tmpfs /workspace:uid=1000,gid=1000 --entrypoint "$1" "$IMAGE" "${@:2}"; }
check "git trusts repositories owned by another uid under /workspace only (system safe.directory, root-owned)" \
  '^trusted untrusted root:root$' run_pair_ws sh -c \
  "mkdir -p /workspace/a/b /tmp/r && git init -q /workspace/a/b && git init -q /tmp/r;
   $R 3000 git -C /workspace/a/b status >/dev/null 2>&1 && printf 'trusted ' || printf 'bad-workspace ';
   $R 3000 git -C /tmp/r status >/dev/null 2>&1 && printf 'bad-tmp ' || printf 'untrusted ';
   stat -c '%U:%G' /etc/gitconfig"
# Fail closed: an agent asked for Pi identities (KOBE_PI_RUNAS) that cannot switch uids (here: no
# capabilities, no_new_privs) refuses to start rather than run Pi as itself.
check "the agent refuses to start when it cannot run Pi under its own uid" 'cannot start processes as a Pi identity' host sh -c \
  "docker run ${HARDENED[*]} --group-add 1001 --group-add 2000 --group-add 2001 --group-add 2002 --group-add 2003 \
     --group-add 2004 --group-add 2005 --group-add 2006 --group-add 2007 \
     -e KOBE_SERVER_URL=ws://127.0.0.1:9 -e KOBE_SANDBOX_ID=11111111-1111-4111-8111-111111111111 \
     -e KOBE_PI_RUNAS=$R \"$IMAGE\" 2>&1; true"

check "built-in skills: no compiled .pyc or __pycache__ baked in" '^none$' run sh -c \
  'f=$(find '$SK' \( -name "*.pyc" -o -name __pycache__ \) | head -3); [ -z "$f" ] && echo none || echo "$f"'
check "built-in skills: a Pi identity can read but not write them" '^read-ok write-denied$' run_ps sh -c \
  "$R 2000 cat $SK/charts/SKILL.md >/dev/null && printf 'read-ok '; $R 2000 sh -c 'echo x > $SK/charts/x' 2>/dev/null || echo write-denied"

exit "$failed"
