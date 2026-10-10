# KOBE-168: cold start and workspace sync with the paired tool uid. Sourced by e2e/run.sh near the
# end of the suite (needs chat_run, owner_id, TEAM_NS, E2E_TEAM_ID, psql_kobe, until_ok, contains,
# ok, fail). `executor_first_token_trials` runs with the flag off (suite shard) and on (executor
# shard), so CI prints both for the ledger; `executor_sync_checks` only with the flag on.
owner_claim_uid() { $KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
owner_pod_now() { $KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(owner_claim_uid)" -o name 2>/dev/null | head -1; }
in_owner() { $KUBECTL -n "$TEAM_NS" exec "$(owner_pod_now)" -c agent -- sh -c "$1" 2>&1 || true; }
tool_said() { printf '%s\n' "$1" | sed -n 's/^text=fake-openai: tool said: //p' | head -1; } # chat_run output → the tool's one line
EXEC_LABEL=$([[ "${KOBE_E2E_TOOL_EXECUTOR:-}" == 1 ]] && echo on || echo off)
owner_lifecycle() { # hibernate|wake → the CLI's answer
  $KUBECTL -n "$NS" exec deploy/kobe-server -c server -- node dist/cli/lifecycle.js "$1" \
    --team-id "$E2E_TEAM_ID" --user-id "$owner_id" 2>&1 | grep -E '^\{"(hibernated|woken)"' || true
}
owner_claim_id() { $KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
owner_pod_gone() { [[ -z "$($KUBECTL -n "$TEAM_NS" get pods -l "agents.x-k8s.io/claim-uid=$(owner_claim_id)" -o name 2>/dev/null)" ]]; }
percentile() { # p (0-100) values... → nearest-rank percentile
  local p=$1
  shift
  printf '%s\n' "$@" | sort -n | awk -v p="$p" '{ a[NR] = $1 } END { i = int((p / 100) * NR + 0.999999); if (i < 1) i = 1; print a[i] }'
}
field_of() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; } # key, chat_run output → value

# Hibernated → first token (a hello through the real wake path), then the first tool call of the
# woken sandbox (a new thread: its Pi and, with the flag on, its executor start cold).
executor_first_token_trials() {
  local n="${KOBE_E2E_FT_TRIALS:-8}" i out ft tool_ms hib
  local -a fts=() tools=()
  echo "==> cold start: hibernated → first token, executor ${EXEC_LABEL} (KOBE-168)"
  for ((i = 1; i <= n; i++)); do
    hib=$(owner_lifecycle hibernate)
    until_ok 120 owner_pod_gone || true
    out=$(chat_run "hello-ft-$RANDOM" 300000)
    ft=$(field_of first_token_ms "$out")
    out=$(chat_run "bash: true" 300000)
    tool_ms=$(field_of terminal_ms "$out")
    echo "     trial $i: hibernate=${hib:+ok} first_token_ms=${ft:-none} tool_run_ms=${tool_ms:-none}"
    [[ "$ft" =~ ^[0-9]+$ ]] && fts+=("$ft")
    [[ "$tool_ms" =~ ^[0-9]+$ ]] && tools+=("$tool_ms")
  done
  if ((${#fts[@]} == n)); then
    echo "     first-token (executor ${EXEC_LABEL}): n=$n p50=$(percentile 50 "${fts[@]}") ms p95=$(percentile 95 "${fts[@]}") ms"
    echo "     tool-run (executor ${EXEC_LABEL}, first tool after wake): n=${#tools[@]} p50=$(percentile 50 "${tools[@]}") ms p95=$(percentile 95 "${tools[@]}") ms"
    if (($(percentile 95 "${fts[@]}") <= ${KOBE_COLD_START_P95_MS:-8000})); then
      ok "hibernated → first token p95 within ${KOBE_COLD_START_P95_MS:-8000} ms (executor ${EXEC_LABEL})"
    else fail "hibernated → first token p95 within ${KOBE_COLD_START_P95_MS:-8000} ms (executor ${EXEC_LABEL})"; fi
  else fail "every cold-start trial produced a first token (${#fts[@]} of $n; executor ${EXEC_LABEL})"; fi
}

# KOBE-27 with tools running as the partner uid: a file the tool writes is pushed on hibernate,
# survives losing the volume, and the restored tree is still writable by a tool.
executor_sync_checks() {
  local content="kobe-168 $(date +%s) $RANDOM" out claim old_pvc new_pvc row
  echo "==> workspace sync with the paired tool uid (KOBE-168)"
  out=$(chat_run "bash: mkdir -p /workspace/kobe168-sync/sub && printf '%s' '$content' > /workspace/kobe168-sync/q3.md && stat -c %u /workspace/kobe168-sync/q3.md" 240000)
  contains "a tool wrote the report as a partner uid" '^text=fake-openai: tool said: 30[0-9]{2}$' "$out"
  contains "the idle sandbox hibernates" '"hibernated":true' "$(owner_lifecycle hibernate)"
  until_ok 120 owner_pod_gone || true
  sync_row_of() { psql_kobe "SELECT sha256 FROM workspace_files WHERE team_id = '$E2E_TEAM_ID' AND user_id = '$owner_id' AND path = 'kobe168-sync/q3.md' AND NOT deleted"; }
  row_ready() { [[ "$(sync_row_of)" =~ ^[0-9a-f]{64}$ ]]; }
  if until_ok 60 row_ready; then ok "hibernation pushed the tool-written file to the durable copy"
  else fail "hibernation pushed the tool-written file to the durable copy: got [$(sync_row_of)]"; fi
  claim=$($KUBECTL -n "$TEAM_NS" get sandboxclaim "u-$owner_id" -o jsonpath='{.status.sandbox.name}' 2>/dev/null || true)
  old_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
  $KUBECTL -n "$TEAM_NS" delete pvc "workspace-${claim:-none}" --wait=true --timeout=120s >/dev/null 2>&1 || true
  new_pvc=$($KUBECTL -n "$TEAM_NS" get pvc "workspace-${claim:-none}" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
  if [[ -n "$old_pvc" && "$new_pvc" != "$old_pvc" ]]; then ok "the workspace volume is destroyed"
  else fail "the workspace volume is destroyed (uid ${old_pvc:-none} → ${new_pvc:-none})"; fi
  contains "the sandbox is woken onto a new volume" '"woken":true' "$(owner_lifecycle wake)"
  # A tool of a new Pi reads the restored file, appends to it and adds a file in the restored directory.
  out=$(chat_run "bash: cat /workspace/kobe168-sync/q3.md && echo ' appended' >> /workspace/kobe168-sync/q3.md && echo new > /workspace/kobe168-sync/sub/new.txt && echo writable" 300000)
  contains "the file is back after the volume was lost, readable by a tool" "tool said: $content writable" "$out"
  contains "the restored file is group 1000 and group-writable (agent-owned, shared with every tool uid)" '^1000:66[46]$' \
    "$(in_owner 'stat -c "%g:%a" /workspace/kobe168-sync/q3.md')"
}
