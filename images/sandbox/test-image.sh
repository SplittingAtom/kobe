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
  'import pandas, numpy, duckdb, pyarrow, matplotlib, openpyxl, docx, reportlab; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.figure(); print("ok")'
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
# Pi must stream the upstream's answer, sending the token as the API key and the run id header.
check "kobe-models loads into Pi and streams a model answer through the gateway client" '^ok Bearer image-token-0123456789abcdef run=11111111-1111-4111-8111-111111111111 text=hello from upstream$' run_ws node -e '
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const seen = "Bearer " + (req.headers.authorization || "").replace(/^Bearer /, "") + " run=" + (req.headers["x-kobe-run-id"] || "-");
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
    if (m.type === "message_update" && m.assistantMessageEvent.type === "text_delta") text += m.assistantMessageEvent.delta;
    if (m.type === "message_end" && m.message.role === "assistant" && m.message.stopReason === "error") done("model error: " + m.message.errorMessage, 1);
    if (m.type === "agent_settled") done("ok " + srv.seen + " text=" + text, 0);
  });
});'
check "skills directory exists, root-owned" '^0:0$' run stat -c '%u:%g' /opt/kobe/skills
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
check "kobe-runas refuses uids outside the Pi identities" '^64 64 64$' run_ps sh -c \
  "for u in 0 1000 2064; do $R \$u id >/dev/null 2>&1; printf '%s ' \$?; done | sed 's/ \$//'"
check "--kill-all ends every process of the identity, nothing else" '^left=0 agent=alive$' run_ps sh -c \
  "sleep 60 & a=\$!; $R 2001 sleep 60 & $R 2001 sh -c 'sleep 60 & sleep 60 & wait' & sleep 1; $R 2001 --kill-all; sleep 0.3;
   echo \"left=\$(ps -eo uid=,stat= | awk '\$1==2001 && \$2 !~ /^Z/' | wc -l) agent=\$(kill -0 \$a && echo alive)\""
check "a Pi identity cannot read the agent's files or signal it" '^denied denied$' run_ps sh -c \
  "umask 077; mkdir -p /tmp/agent && echo secret > /tmp/agent/token; sleep 60 & a=\$!;
   r=\$($R 2000 cat /tmp/agent/token 2>&1 | grep -q 'Permission denied' && echo denied);
   k=\$($R 2000 sh -c \"kill -0 \$a\" 2>&1 | grep -q 'not permitted' && echo denied); echo \"\$r \$k\""
# Fail closed: an agent asked for Pi identities (KOBE_PI_RUNAS) that cannot switch uids (here: no
# capabilities, no_new_privs) refuses to start rather than run Pi as itself.
check "the agent refuses to start when it cannot run Pi under its own uid" 'cannot start processes as a Pi identity' host sh -c \
  "docker run ${HARDENED[*]} --group-add 1001 --group-add 2000 --group-add 2001 --group-add 2002 --group-add 2003 \
     --group-add 2004 --group-add 2005 --group-add 2006 --group-add 2007 \
     -e KOBE_SERVER_URL=ws://127.0.0.1:9 -e KOBE_SANDBOX_ID=11111111-1111-4111-8111-111111111111 \
     -e KOBE_PI_RUNAS=$R \"$IMAGE\" 2>&1; true"

exit "$failed"
