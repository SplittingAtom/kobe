# KOBE-168: paired-uid isolation under gVisor, with sandbox.toolExecutor.enabled=true. Sourced by
# e2e/run.sh right after the KOBE-71 privilege-separation checks (needs chat_run, owner_id, TEAM_NS,
# E2E_TEAM_ID, until_ok, contains, ok, fail). Real Pi, real executor, the fake model's
# "bash: <command>" tool call: each probe below runs as a tool of a real thread, so as the
# thread's partner uid. Not run when the flag is off.
echo "==> paired tool uid: isolation under gVisor (KOBE-168)"
EXEC_DIR=e2e/executor
source e2e/executor/trials.sh # helpers (in_owner, tool_said, ...)

contains "the sandbox agent runs with the tool executor on (pod env from the chart flag)" '^true$' \
  "$(in_owner 'printenv KOBE_TOOL_EXECUTOR')"
$KUBECTL -n "$TEAM_NS" exec -i "$(owner_pod_now)" -c agent -- sh -c 'cat > /workspace/.kobe168-probe.sh && chmod 0664 /workspace/.kobe168-probe.sh' \
  <"$EXEC_DIR/probe.sh" >/dev/null 2>&1 || true
in_owner 'rm -f /workspace/.kobe168-plant-loaded' >/dev/null

# Thread B: a long tool call keeps its Pi and executor alive while thread A's tool probes.
b_out_file=$(mktemp)
chat_run "bash: echo B-started; sleep 80; echo B-finished" 200000 >"$b_out_file" &
b_pid=$!
b_running() { [[ "$(in_owner "ps -eo uid=,args= | awk '\$1 >= 3000 && \$1 <= 3063 && /sleep 80/' | wc -l")" -ge 1 ]]; }
if until_ok 120 b_running; then ok "thread B's tool runs under a partner uid (3000-3063) while A probes"
else fail "thread B's tool runs under a partner uid (3000-3063) while A probes"; fi

# Memory of the executor while B's tool runs (design open question 1): RSS in KiB, as ps reports it.
rss_line=$(in_owner "ps -eo rss=,uid=,args= | awk '\$2 >= 3000 && \$2 <= 3063 && /dist\\/exec\\/executor/ { print \$1 }' | head -1")
pi_rss=$(in_owner "ps -eo rss=,uid=,args= | awk '\$2 >= 2000 && \$2 <= 2063 { print \$1; exit }'")
echo "     executor rss: executor_rss_kb=${rss_line:-none} pi_rss_kb=${pi_rss:-none}"
contains "the executor is its own process, measured (RSS)" '^[0-9]+$' "$rss_line"
if [[ "$rss_line" =~ ^[0-9]+$ ]] && ((rss_line < 262144)); then ok "executor RSS under 256 MiB (${rss_line} KiB)"
else fail "executor RSS under 256 MiB (got ${rss_line:-none} KiB)"; fi

probe_out=$(chat_run "bash: sh /workspace/.kobe168-probe.sh" 240000)
probe=$(tool_said "$probe_out")
printf '     probe: %s\n' "$probe"
contains "thread A's run completed and the probe ran" 'END$' "$probe"
has() { contains "$1" "(^| )$2( |\$)" "$probe"; }
has "the tool runs as the partner uid of its Pi (30xx / 20xx)" 'uid=30[0-9]{2}'
has "the tool's own Pi is visible to it (the zero counts below are not vacuous)" 'own_pi=1'
has "another thread's Pi is visible to the tool too (KOBE-228)" 'other_pis=[1-9][0-9]*'
has "the agent is visible to the tool" 'agent_seen=1'
has "a tool cannot signal Pi, another thread's Pi or executor, or the agent" 'signal_ok=0'
has "a tool cannot read their environment" 'environ_ok=0'
has "a tool cannot read their memory" 'mem_ok=0'
has "a tool cannot list their file descriptors" 'fd_ok=0'
has "a tool cannot ptrace-attach to Pi, to another thread's Pi, or to the agent" 'ptrace_ok=0'
has "a tool cannot read any Pi's model.json (run token, session token)" 'model_json_ok=0'
has "a tool cannot list any Pi's agent/ directory" 'agent_dir_ok=0'
has "a tool cannot write any Pi's agent/ directory" 'agent_write_ok=0'
has "a tool cannot create files in any Pi's runtime directory" 'runtime_write_ok=0'
has "a tool cannot read the agent's bootstrap or session token files" 'agent_tokens_ok=0'
has "a tool reads its own egress token (control)" 'own_tool_token=1'
has "a tool cannot read another thread's egress token" 'other_tool_token=0'
has "Pi's private HOME and TMPDIR exist for every Pi (two threads)" 'private_dirs=[2-9]'
has "a tool cannot create or replace anything in any Pi's private HOME or TMPDIR" 'private_write_ok=0'
has "a tool can still list Pi's private TMPDIR (Full output logs stay readable)" 'private_tmp_listable=[1-9][0-9]*'
has "control: code planted in the tool's own HOME is loaded by the tool" 'plant_control=[1-9][0-9]*'
has "workspace: a file the tool creates is owned by the partner uid, group 1000, group-writable" 'ws_file=30[0-9]{2}:1000:66[46]'
has "workspace: the tool can read the files its Pi wrote" 'pi_file_readable=1'

# Thread B must be untouched by A's probe.
wait "$b_pid" || true
b_out=$(cat "$b_out_file")
rm -f "$b_out_file"
contains "thread B completed with its tool output intact" 'B-started B-finished' "$(tool_said "$b_out")"
contains "thread B ended run.completed" '^terminal=run.completed$' "$b_out"

# The other half of workspace sharing, from the agent's and a Pi uid's side.
contains "workspace: the agent (uid 1000) can append to the tool's file" '^appended$' \
  "$(in_owner 'echo agent >> /workspace/kobe168/from-tool.txt && echo appended')"
contains "workspace: a Pi uid can append to the tool's file (shared by group 1000)" '^appended$' \
  "$(in_owner 'R=/opt/kobe/bin/kobe-runas; $R 2015 sh -c "echo pi >> /workspace/kobe168/from-tool.txt" && echo appended')"
contains "workspace: the directory is setgid group 1000 so new files stay shared" '^[0-9]*:1000:2775$' \
  "$(in_owner 'stat -c "%u:%g:%a" /workspace/kobe168')"

# Planted code is not loaded by a later Pi: thread C starts a fresh Pi, which must not run the
# module thread A's tool left in the tool's HOME (and records no uid in 2000-2063 if it did).
c_out=$(chat_run "hello-plant-$RANDOM" 240000)
contains "a later thread's Pi starts and answers" '^terminal=run.completed$' "$c_out"
plant_log=$(in_owner 'cat /workspace/.kobe168-plant-loaded 2>/dev/null | sort -u | tr "\n" " "')
contains "the plant exists and only the tool's own control run loaded it (no Pi uid)" '^30[0-9]{2} $' "$plant_log"
