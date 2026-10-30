#!/usr/bin/env bash
# ac-5 of e2e/gate2.sh: the secret scan of a running sandbox (also U7 of e2e/gate4.sh: SCAN_LABEL,
# SBX_WHO and T2 name the check and the user). Sourced; uses its helpers (ok, fail,
# contains, in_sbx, sbx_pod, sbx_summary, client, chat, ...) and variables (KUBECTL, NS, TNS, TEAM, T2, BASE, WORK).
#
# The secrets are collected on the CI side only and never printed or sent into the sandbox: the
# site's Kubernetes Secrets (every value of the release namespace and of its dependencies'
# namespaces: internal signing/sealing keys, database and S3 credentials, the Bifrost admin
# password), the plaintext provider API keys (opened in a server pod with the site's own key),
# and any extra values in KOBE_GATE2_EXTRA_SECRETS_FILE (connector tokens, a real provider key kept
# outside the cluster). What the sandbox holds is copied out and searched with `grep -F -f`; a hit is
# reported by the secret's label and the file it was found in, never by value.

SCAN_MIN_LEN=12
# Files of the sandbox that legitimately hold Kobe's own session tokens (see docs/gates/gate-2.md).
JWT_RE='eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
# Generic key shapes; label=regex (PCRE: `grep -P`). Kobe session tokens (JWT shape) are judged
# separately. The provider-key shape starts at a boundary: `sk-` is also a substring of random
# base64url, and a Kobe session token once carried one (CI 2026-10-30, the sandbox's mcp-token).
GENERIC_PATTERNS=(
  'openai-or-anthropic-key=(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}'
  'aws-access-key=AKIA[0-9A-Z]{16}'
  'github-token=gh[pousr]_[A-Za-z0-9]{30,}'
  'slack-token=xox[abprs]-[A-Za-z0-9-]{10,}'
  'google-api-key=AIza[0-9A-Za-z_-]{35}'
  'private-key-block=-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'bearer-credential=[Bb]earer [A-Za-z0-9._~+/=-]{24,}'
  'basic-url-credential=[a-z]+://[^/[:space:]:@]+:[^/[:space:]@]{6,}@'
)

b64d() { base64 -d 2>/dev/null || base64 -D 2>/dev/null; }

# Writes one file per secret value (>= SCAN_MIN_LEN, one line per file line) under $1/values and
# its label in $1/labels (n<TAB>label).
add_secret_value() { # dir label value-file
  local dir="$1" label="$2" file="$3" n
  # PEM armour lines (-----BEGIN/END ...-----) are the same in every key and certificate, so only
  # a PEM value's body lines are searched for; otherwise any CA bundle in the image would match.
  [[ "$(awk '!/^-----(BEGIN|END) / && length($0) >= '"$SCAN_MIN_LEN"' { c++ } END { print c + 0 }' "$file")" == 0 ]] && return 0
  n=$(($(wc -l <"$dir/labels") + 1))
  awk '!/^-----(BEGIN|END) / && length($0) >= '"$SCAN_MIN_LEN" "$file" >"$dir/values/$n"
  printf '%s\t%s\n' "$n" "$label" >>"$dir/labels"
}

collect_k8s_secrets() { # dir namespace...
  local dir="$1" ns name type key val tmp="$1/tmp"
  shift
  for ns in "$@"; do
    $KUBECTL get namespace "$ns" >/dev/null 2>&1 || continue
    while IFS=$'\t' read -r name type; do
      case "$type" in helm.sh/release.v1 | kubernetes.io/service-account-token) continue ;; esac
      while read -r key val; do
        # Public material is not a secret: certificates, CA bundles and the session keys' public
        # halves (`<audience>.pub`, KOBE-513; the verifiers hold the same bytes in a ConfigMap).
        case "$key" in tls.crt | ca.crt | *.crt | *.pem | *.pub | ca-bundle*) continue ;; esac
        [[ -z "$val" ]] && continue
        printf '%s' "$val" | b64d >"$tmp" || continue
        add_secret_value "$dir" "secret $ns/$name/$key" "$tmp"
      done < <($KUBECTL -n "$ns" get secret "$name" -o go-template='{{range $k, $v := .data}}{{$k}} {{$v}}{{"\n"}}{{end}}' 2>/dev/null)
    done < <($KUBECTL -n "$ns" get secrets -o go-template='{{range .items}}{{.metadata.name}}{{"\t"}}{{.type}}{{"\n"}}{{end}}' 2>/dev/null)
  done
}

collect_provider_keys() { # dir
  local dir="$1" line id val
  while read -r line; do
    case "$line" in providerkey\ *) ;; *) continue ;; esac
    read -r _ id val <<<"$line"
    printf '%s' "$val" | b64d >"$dir/tmp" || continue
    add_secret_value "$dir" "provider API key $id" "$dir/tmp"
  done < <(client '{"mode":"provider-keys","base":"'"$BASE"'"}')
}

# The tools run as Pi's own identity: a script (written by the agent user) that the bash tool runs,
# so what Pi's tools can see of /proc is scanned too, not only what the agent can.
PROC_DUMP='for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  printf "## %s comm=%s uid=%s\n" "$pid" "$(cat $p/comm 2>/dev/null)" "$(awk "/^Uid:/{print \$2}" $p/status 2>/dev/null)"
  if [ -r $p/environ ]; then echo "-- environ"; tr "\\0" "\\n" <$p/environ 2>/dev/null; else echo "-- environ UNREADABLE"; fi
  if [ -r $p/cmdline ]; then echo "-- cmdline"; tr "\\0" " " <$p/cmdline 2>/dev/null; echo; fi
done'

# The files of the sandbox that sandbox code can write or that are mounted into it: workspace,
# tmp, home, run, var, etc, /opt/kobe, every other mount point from /proc/self/mountinfo.
FS_DUMP='roots="/workspace /tmp /home /run /var /etc /root /srv /mnt /opt/kobe"
for m in $(awk "{print \$5}" /proc/self/mountinfo); do
  case "$m" in /|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*) ;; *) roots="$roots $m" ;; esac
done
find $roots -xdev -type f -size -2048k -not -path "/var/lib/apt/*" -not -path "/var/cache/*" -print0 2>/dev/null | tar --null -T - -cf - 2>/dev/null'

# Allowed shapes (each reviewed, see docs/gates/gate-2.md):
# - `Bearer <jwt>` and `scheme://user:<jwt>@`: Kobe's own session tokens; every JWT in the sandbox
#   is judged by jwt_class, so these shapes add nothing here. The egress token reaches Pi's tools
#   as HTTPS_PROXY=http://<thread id>:<token>@<proxy> (KOBE-39; "egress token visible in env
#   output" is accepted LOW in docs/ledger/KOBE-39.md).
# - /opt/kobe/egress-env.sh itself: the root-owned script that builds that URL from variables
#   (`http://${user}:${token}@${host}`), a template without a value.
# - Library documentation and tests inside the image, by exact path (seen in the first CI runs):
#   pino's docs/transports.md (an example URL), zod's test files (example URLs and the jwt.io sample
#   token for "John Doe"). Nothing else under node_modules is excluded.
FIXTURE_RE='fs/tmp/node-compile-cache/[^:]*:|fs/opt/kobe/sandbox-agent/node_modules/\.pnpm/(pino@[0-9.]+/node_modules/pino/docs/transports\.md|zod@[0-9.]+/node_modules/zod/src/[a-z0-9/]*tests/[a-z-]+\.test\.ts):'
generic_unexpected() { # pattern name; "file:match" lines on stdin → those not allowed above
  grep -a -v -E "$FIXTURE_RE" | generic_unexpected_by_kind "$1"
}
generic_unexpected_by_kind() {
  case "$1" in
    bearer-credential) grep -a -v -E 'Bearer eyJ' || true ;;
    basic-url-credential) grep -a -v -E '^[^:]*fs/opt/kobe/egress-env\.sh:|://[^:/]+:eyJ' || true ;;
    # The skills store's directories are `sk-<sha256>` (sandbox-agent skills/store.ts): since
    # Kobe's catalog skills (KOBE-317) every run's prompt, so Pi's session files, names them. A
    # provider key is never 64 lowercase hex digits, and the real keys are matched by value above.
    openai-or-anthropic-key) grep -a -v -E ':sk-[0-9a-f]{64}$' || true ;;
    *) cat ;;
  esac
}

# Controls and verdicts (KOBE-193). A failing control (no values collected, no dump, a planted canary
# not found) makes every "nothing found" result of the scan meaningless: those print INVALID, never
# ok, and the scan ends with one FAIL naming the failed controls.
SCAN_BAD=""
scan_control() { # name regex actual: a precondition of the scan
  if grep -Eq "$2" <<<"$3"; then
    ok "$1"
  else
    fail "$1: got [$(printf '%s\n' "$3" | tail -3)]"
    SCAN_BAD="${SCAN_BAD:+$SCAN_BAD; }$1"
  fi
}
scan_ok() { # name: a negative result, ok only when every control passed
  if [[ -n "$SCAN_BAD" ]]; then echo "INVALID $1 (not shown: a control failed)"; else ok "$1"; fi
}
scan_check() { # name regex actual: like contains, with scan_ok for the pass
  if grep -Eq "$2" <<<"$3"; then scan_ok "$1"; else fail "$1: got [$(printf '%s\n' "$3" | tail -3)]"; fi
}
scan_verdict() {
  [[ -z "$SCAN_BAD" ]] && return 0
  fail "${SCAN_LABEL:-ac-5} INVALID: the scan's own controls failed ($SCAN_BAD); its INVALID lines above prove nothing"
}

jwt_class() { # token → "own <aud>" for this sandbox's user and team, else "foreign"
  local payload pad json
  payload=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  case $((${#payload} % 4)) in 2) pad="==" ;; 3) pad="=" ;; *) pad="" ;; esac
  json=$(printf '%s%s' "$payload" "$pad" | b64d 2>/dev/null || true)
  if [[ "$json" == *'"iss":"kobe-server"'* && "$json" == *"\"user_id\":\"$T2\""* && "$json" == *"\"team_id\":\"$TEAM\""* ]]; then
    echo "own $(printf '%s' "$json" | sed -n 's/.*"aud":"\([^"]*\)".*/\1/p')"
  elif [[ "$json" == *'"aud":["kobe.sandbox-bootstrap"]'* && "$json" == *"system:serviceaccount:$TNS:"* ]]; then
    # The pod's projected bootstrap token (manifests.ts: audience kobe.sandbox-bootstrap, which the
    # Kubernetes API rejects): the agent trades it for session tokens. Cluster-issued, sub = this
    # team namespace's sandbox ServiceAccount.
    echo "own bootstrap-serviceaccount-token(aud kobe.sandbox-bootstrap)"
  else
    echo "foreign claims=$(printf '%s' "$json" | tr -cd '[:print:]' | sed -E 's/"(jti|nonce)":"[^"]*"//g' | cut -c1-400)"
  fi
}

run_secret_scan() {
  local dir="$WORK/scan-${SBX_WHO:-t2}" pod labels n label hits canary canary_file ctl spec
  SCAN_BAD=""
  mkdir -p "$dir/values" "$dir/files"
  chmod 700 "$dir"
  : >"$dir/labels"
  pod=$(sbx_pod)
  if [[ -z "$pod" ]]; then
    fail "${SCAN_LABEL:-ac-5} INVALID: ${SBX_WHO:-t2}'s sandbox has no Running pod to scan ($(sbx_summary))"
    return
  fi

  # 1. What is to be looked for.
  local deps=(kobe-deps "$NS-deps" ${KOBE_GATE2_DEPS_NS:-})
  collect_k8s_secrets "$dir" "$NS" "${deps[@]}"
  collect_provider_keys "$dir"
  if [[ -n "${KOBE_GATE2_EXTRA_SECRETS_FILE:-}" ]]; then
    [[ -r "$KOBE_GATE2_EXTRA_SECRETS_FILE" ]] || { fail "${SCAN_LABEL:-ac-5}: KOBE_GATE2_EXTRA_SECRETS_FILE is not readable"; return; }
    add_secret_value "$dir" "extra secrets file" "$KOBE_GATE2_EXTRA_SECRETS_FILE"
  fi
  n=$(wc -l <"$dir/labels" | tr -d ' ')
  scan_control "the site's secret values were collected (CI side only: $n secrets/keys; values never printed)" '^[1-9][0-9]*$' "$n"
  scan_control "the site's provider API keys were collected from the sealed store" '^provider API key' \
    "$(cut -f2 "$dir/labels" | grep -m1 '^provider API key' || echo 'none (no provider key in the install)')"

  # 2. Positive controls: a canary in a file and in a process environment must be found.
  canary="gate2-canary-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  canary_file="/tmp/gate2-canary-file"
  in_sbx "printf '%s\n' '$canary' > $canary_file; GATE2_CANARY='$canary' setsid nohup sleep 900 >/dev/null 2>&1 &" >/dev/null

  # 3. What the sandbox holds: the processes (as the agent, and as Pi's tools) and the files.
  in_sbx "$PROC_DUMP" >"$dir/files/procs-agent.txt"
  scan_control "the agent user's view lists the sandbox's processes" '^## [0-9]+ comm=' "$(head -c 20000 "$dir/files/procs-agent.txt")"
  procs=$(grep -c '^## ' "$dir/files/procs-agent.txt" || true)
  unreadable=$(grep -c 'environ UNREADABLE' "$dir/files/procs-agent.txt" || true)
  echo "     agent view: $procs processes, environment unreadable for $unreadable (other identities)"
  $KUBECTL -n "$TNS" exec "$pod" -c agent -- sh -c "$FS_DUMP" >"$dir/files/fs.tar" 2>/dev/null || true
  mkdir -p "$dir/files/fs"
  tar -xf "$dir/files/fs.tar" -C "$dir/files/fs" 2>/dev/null || true
  rm -f "$dir/files/fs.tar"
  scan_control "the sandbox's writable and mounted files were copied out" '^[1-9][0-9]*$' "$(find "$dir/files/fs" -type f | wc -l | tr -d ' ')"
  scan_as_pi "$dir" "$pod"

  # 4. Controls first: the scan must be able to find a planted value.
  ctl=$(awk -v can="$canary" '/^## /{sec=$0} index($0, can) {print sec}' "$dir/files/procs-agent.txt" | grep -c ' comm=sleep ' || true)
  scan_control "control: a canary in a process environment is found in /proc/<pid>/environ" '^[1-9]' "$ctl"
  scan_control "control: a canary in a file is found in the file scan" '^[1-9]' "$(grep -rlaF -- "$canary" "$dir/files/fs" 2>/dev/null | wc -l | tr -d ' ')"
  # An unreadable pod spec reads as empty, which step 7 would take for "no Secret": a control too.
  spec=$($KUBECTL -n "$TNS" get pod "$pod" -o jsonpath='{.metadata.name}' 2>/dev/null || true)
  scan_control "control: the sandbox pod's spec can be read" "^$pod\$" "$spec"
  in_sbx "rm -f $canary_file; kill \$(for p in /proc/[0-9]*; do [ \"\$(cat \$p/comm 2>/dev/null)\" = sleep ] && echo \${p#/proc/}; done) 2>/dev/null; true" >/dev/null

  # 5. The check: no secret value anywhere (every value, every file).
  hits=0
  while IFS=$'\t' read -r n label; do
    found=$(grep -rlaF -f "$dir/values/$n" "$dir/files" 2>/dev/null | sed "s#^$dir/files/##" | head -5 || true)
    if [[ -n "$found" ]]; then
      hits=$((hits + 1))
      fail "${SCAN_LABEL:-ac-5}: $label is in the sandbox: $(printf '%s' "$found" | tr '\n' ' ')"
    fi
  done <"$dir/labels"
  ((hits == 0)) && scan_ok "no secret value of the install (internal keys, credentials, provider keys) is in the sandbox: $(wc -l <"$dir/labels" | tr -d ' ') values searched in $(find "$dir/files" -type f | wc -l | tr -d ' ') files, every process's environment and command line"

  # 6. Generic key shapes, and which Kobe tokens the sandbox holds.
  local entry pat name generic=0 matches
  for entry in "${GENERIC_PATTERNS[@]}"; do
    name=${entry%%=*}
    pat=${entry#*=}
    matches=$(grep -raoP -- "$pat" "$dir/files" 2>/dev/null | generic_unexpected "$name" | sed -E "s#^$dir/files/##; s#(://[^:/]+:)[^@]*@#\\1***@#" | sort -u | cut -c1-200 | head -3 | tr '\n' ' ' || true)
    if [[ -n "$matches" ]]; then generic=1; fail "${SCAN_LABEL:-ac-5}: a $name-shaped value is in the sandbox: $matches"; fi
  done
  ((generic == 0)) && scan_ok "no generic API key, private key or credential-bearing URL shape is in the sandbox"
  tokens_ok=1
  auds=""
  while IFS=: read -r tokfile tok; do
    [[ -z "$tok" ]] && continue
    class=$(jwt_class "$tok")
    if [[ "$class" == own* ]]; then auds+="${class#own } "; else tokens_ok=0; echo "     unexpected token in $tokfile: $class"; fi
  done < <(grep -raoE -- "$JWT_RE" "$dir/files" 2>/dev/null | sed "s#^$dir/files/##" | grep -a -v -E "$FIXTURE_RE" | sort -u -t: -k2,2)
  if ((tokens_ok)); then scan_ok "every JWT in the sandbox is Kobe's own session token for this user and team (audiences: ${auds:-none found})"
  else fail "${SCAN_LABEL:-ac-5}: a JWT in the sandbox is not Kobe's session token for this sandbox's user and team"; fi

  # 7. Mounted secrets: the pod spec mounts no Secret and injects none into an environment.
  scan_check "no Secret volume is mounted into the sandbox pod (volumes: $($KUBECTL -n "$TNS" get pod "$pod" -o jsonpath='{range .spec.volumes[*]}{.name}{" "}{end}' 2>/dev/null || true))" '^$' \
    "$($KUBECTL -n "$TNS" get pod "$pod" -o jsonpath='{range .spec.volumes[*]}{.secret.secretName}{end}' 2>/dev/null || true)"
  scan_check "no environment variable of the sandbox pod comes from a Secret" '^$' \
    "$($KUBECTL -n "$TNS" get pod "$pod" -o jsonpath='{range .spec.containers[*]}{range .env[*]}{.valueFrom.secretKeyRef.name}{end}{range .envFrom[*]}{.secretRef.name}{end}{end}' 2>/dev/null || true)"
  scan_check "the projected volume carries only a short-lived ServiceAccount token (the bootstrap token)" '^[a-z0-9.:/-]*$' \
    "$($KUBECTL -n "$TNS" get pod "$pod" -o jsonpath='{range .spec.volumes[*]}{range .projected.sources[*]}{.serviceAccountToken.audience}{end}{end}' 2>/dev/null || true)"
  scan_verdict
}

# Pi's tools see another /proc than the agent (their own uid): the bash tool runs the dump there.
scan_as_pi() { # dir pod
  local dir="$1" out
  if [[ "${MODELS:-0}" != 1 || "$MODEL_ALIAS" != fast ]]; then
    echo "     Pi's view needs the scripted bash model ('fast'): scanned from the agent user only"
    return
  fi
  in_sbx "cat > /tmp/gate2-proc-dump.sh <<'EOS'
$PROC_DUMP
EOS
chmod 755 /tmp/gate2-proc-dump.sh" >/dev/null
  out=$(chat "bash: sh /tmp/gate2-proc-dump.sh > /workspace/.gate2-pi-procs.txt 2>&1")
  in_sbx "cat /workspace/.gate2-pi-procs.txt" >"$dir/files/procs-pi.txt"
  in_sbx "rm -f /workspace/.gate2-pi-procs.txt /tmp/gate2-proc-dump.sh" >/dev/null
  scan_control "Pi's tools ran the dump as their own identity (their environment is in the scan)" '^## [0-9]+ comm=.*' "$(head -c 20000 "$dir/files/procs-pi.txt")"
  scan_control "that environment holds the BASH_ENV script (control: it is Pi's, not the agent's)" 'BASH_ENV=' "$(grep -a BASH_ENV "$dir/files/procs-pi.txt" | head -1)"
  : "$out"
}
