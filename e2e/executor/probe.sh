#!/bin/sh
# KOBE-168 tool-side probe. Runs as the `bash` tool of one thread (so as the thread's partner uid,
# with the executor on) and prints ONE line of key=value words: the fake model repeats a tool
# result as a single line. Every `*_ok` count is the number of attempts that SUCCEEDED, so 0 is
# the isolated answer. "other" = a different thread's Pi or executor.
# Usage: probe.sh   (reads nothing; uses ps, /proc, /run/kobe-pi, /tmp/kobe-pi-*, /workspace)
me=$(id -u)
pi=$((me - 1000))
printf 'uid=%s pi_uid=%s' "$me" "$pi"

n_pi=0 n_other=0 n_otherpi=0 sig_ok=0 env_ok=0 mem_ok=0 fd_ok=0 pt_ok=0
agent_pid=$(ps -eo pid=,uid=,args= | awk '$2 == 1000 && $3 == "node" && /sandbox-agent/ { print $1; exit }')
targets=$(ps -eo pid=,uid= | awk -v me="$me" '($2 >= 2000 && $2 <= 2063) || ($2 >= 3000 && $2 <= 3063 && $2 != me) { print $1 ":" $2 }')
for t in $targets $agent_pid:1000; do
  pid=${t%%:*}
  tuid=${t##*:}
  [ -n "$pid" ] || continue
  if [ "$tuid" = "$pi" ]; then n_pi=$((n_pi + 1)); else n_other=$((n_other + 1)); fi
  if [ "$tuid" -ge 2000 ] && [ "$tuid" -le 2063 ] && [ "$tuid" != "$pi" ]; then n_otherpi=$((n_otherpi + 1)); fi
  kill -0 "$pid" 2>/dev/null && sig_ok=$((sig_ok + 1))
  cat "/proc/$pid/environ" >/dev/null 2>&1 && env_ok=$((env_ok + 1))
  head -c 1 "/proc/$pid/mem" >/dev/null 2>&1 && mem_ok=$((mem_ok + 1))
  ls "/proc/$pid/fd" >/dev/null 2>&1 && fd_ok=$((fd_ok + 1))
  r=$(python3 -c 'import ctypes,sys
l=ctypes.CDLL(None,use_errno=True)
r=l.ptrace(16,int(sys.argv[1]),0,0)
print("attached" if r==0 else "denied")
if r==0: l.ptrace(17,int(sys.argv[1]),0,0)' "$pid" 2>/dev/null)
  [ "$r" = attached ] && pt_ok=$((pt_ok + 1))
done
# own_pi: my Pi is there (so the counts below are not vacuous); other_pis: another thread's Pi too.
printf ' agent_seen=%s own_pi=%s other_pis=%s others=%s signal_ok=%s environ_ok=%s mem_ok=%s fd_ok=%s ptrace_ok=%s' \
  "$([ -n "$agent_pid" ] && echo 1 || echo 0)" "$n_pi" "$n_otherpi" "$n_other" "$sig_ok" "$env_ok" "$mem_ok" "$fd_ok" "$pt_ok"

# Pi runtime directories (model.json, agent/): read and write attempts, own Pi's and the others'.
model_ok=0 agent_ls_ok=0 agent_w_ok=0 top_w_ok=0 own_tool_token=0 other_tool_token=0
for d in /run/kobe-pi/*; do
  [ -d "$d" ] || continue
  case $d in
    *-tool)
      if [ "$(stat -c %g "$d" 2>/dev/null)" = "$me" ]; then
        cat "$d/egress-token" >/dev/null 2>&1 && own_tool_token=$((own_tool_token + 1))
      else
        cat "$d/egress-token" >/dev/null 2>&1 && other_tool_token=$((other_tool_token + 1))
      fi
      ;;
    *)
      cat "$d/model.json" >/dev/null 2>&1 && model_ok=$((model_ok + 1))
      ls "$d/agent" >/dev/null 2>&1 && agent_ls_ok=$((agent_ls_ok + 1))
      { true >"$d/agent/settings.json"; } 2>/dev/null && agent_w_ok=$((agent_w_ok + 1))
      { true >"$d/planted"; } 2>/dev/null && top_w_ok=$((top_w_ok + 1))
      ;;
  esac
done
tok_ok=0
for f in /run/kobe-agent/bootstrap/bootstrap-token /var/run/kobe/sandbox-wire/token; do
  cat "$f" >/dev/null 2>&1 && tok_ok=$((tok_ok + 1))
done
printf ' model_json_ok=%s agent_dir_ok=%s agent_write_ok=%s runtime_write_ok=%s agent_tokens_ok=%s' \
  "$model_ok" "$agent_ls_ok" "$agent_w_ok" "$top_w_ok" "$tok_ok"
printf ' own_tool_token=%s other_tool_token=%s' "$own_tool_token" "$other_tool_token"

# Pi's private HOME and TMPDIR (KOBE-196): nothing may be created, replaced or listed there.
priv=0 priv_w=0 priv_ls=0
for d in /tmp/kobe-pi-*; do
  [ -d "$d" ] || continue
  priv=$((priv + 1))
  for s in home tmp; do
    { true >"$d/$s/planted"; } 2>/dev/null && priv_w=$((priv_w + 1))
    mkdir "$d/$s/planted.d" 2>/dev/null && priv_w=$((priv_w + 1))
    ls "$d/$s" >/dev/null 2>&1 && priv_ls=$((priv_ls + 1))
  done
  { true >"$d/planted"; } 2>/dev/null && priv_w=$((priv_w + 1))
done
printf ' private_dirs=%s private_write_ok=%s' "$priv" "$priv_w"
# A "Full output" log of the tool stays readable to the read tool: tmp is listable, home is not.
tmp_ls=0
for d in /tmp/kobe-pi-*; do [ -d "$d/tmp" ] && ls "$d/tmp" >/dev/null 2>&1 && tmp_ls=$((tmp_ls + 1)); done
printf ' private_tmp_listable=%s' "$tmp_ls"

# Plant code where Pi (or a later Pi) might load it: the tool's own HOME and TMPDIR work, Pi's do not
# use them. The module records the uid that loads it; control = this very process loads it.
plant=/workspace/.kobe168-plant-loaded
mkdir -p "$HOME/.node_modules/bufferutil" "${TMPDIR:-/tmp}/jiti" "${TMPDIR:-/tmp}/node-compile-cache" 2>/dev/null
cat >"$HOME/.node_modules/bufferutil/index.js" 2>/dev/null <<JS
require("fs").appendFileSync("$plant", process.getuid() + "\n");
module.exports = {};
JS
node -e 'try { require("bufferutil") } catch {}' 2>/dev/null
printf ' plant_control=%s' "$(grep -c "^$me\$" "$plant" 2>/dev/null || echo 0)"

# Workspace sharing: a file made here is group-shared; Pi's session files are readable here.
mkdir -p /workspace/kobe168 && echo "from-tool $me" >/workspace/kobe168/from-tool.txt 2>/dev/null
printf ' ws_file=%s' "$(stat -c '%u:%g:%a' /workspace/kobe168/from-tool.txt 2>/dev/null)"
sess=$(find /workspace -path '*/sessions/*' -type f -user "$pi" 2>/dev/null | head -1)
if [ -n "$sess" ] && cat "$sess" >/dev/null 2>&1; then printf ' pi_file_readable=1'; else printf ' pi_file_readable=0'; fi
printf ' END\n'
