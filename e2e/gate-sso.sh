#!/usr/bin/env bash
# The single sign-on gate (KOBE-633; spec docs/specs/sso-oidc-scim.md §17 SSO-9): OIDC sign-in
# against a mock Microsoft Entra ID and Entra's SCIM provisioning requests, offline in k3d.
#
#   KOBE_E2E_SHARD=gate1-prep e2e/run.sh && e2e/gate-sso.sh      (CI shard `gate-sso`)
#
# The mock (e2e/sso/mock-entra.mjs) runs from the installed server image (its own `jose`, no new
# image) in namespace kobe-sso-infra, with TLS from a CA made here. CoreDNS answers
# login.microsoftonline.com with the mock's Service, so Kobe's real Entra provider code (issuer
# https://login.microsoftonline.com/<tid>/v2.0, discovery, JWKS, token endpoint) talks to it; the
# server trusts the CA through the chart's server.extraCaBundle and reaches the private address
# through auth.sso.allowedInternalCidrs. Kobe gets no test-only switch. The browser hops and
# Entra's provisioning service are played from a server pod (e2e/gate-sso/client.mjs,
# e2e/sso/scim-client.mjs). Parts: setup, sign-in + JIT by mapping, refusals (unmapped, overage,
# IdP error, replayed state, every bad-token mode), MFA (acrs c1 proving and not, under
# require_2fa), SCIM (create with Entra's quirks, sign-in, deactivation ending the session at once,
# reactivation, delete). Refuses any context but k3d-* unless KOBE_GATESSO_CONTEXT names it.
set -euo pipefail
cd "$(dirname "$0")/.."

KUBECTL="${KUBECTL:-kubectl}"
HELM="${HELM:-helm}"
NS="${KOBE_GATESSO_NS:-kobe-dev}"
RELEASE="${KOBE_GATESSO_RELEASE:-kobe}"
CHART="${KOBE_GATESSO_CHART:-charts/kobe}"
OWNER_EMAIL="${KOBE_GATESSO_OWNER_EMAIL:-owner@e2e.test}"
OWNER_PASSWORD="${KOBE_GATESSO_OWNER_PASSWORD:-e2e owner password}"
INFRA_NS=kobe-sso-infra
SERVER="deploy/$RELEASE-server"
BASE="http://$RELEASE-server.$NS.svc.cluster.local"
TEAM_SLUG=sso-a
# Fixed ids: a provider's tenant can't change while identities are linked, so reruns reuse them.
TENANT=6f0b2a41-1c1e-4c43-9d5e-0a5f3a1b2c01
TENANT_G=6f0b2a41-1c1e-4c43-9d5e-0a5f3a1b2c02
CLIENT_ID=0b5c1d7e-8a2f-4e61-9c3d-5e7f9a1b3c05
GROUP_ID=3d9e7f10-2b4c-4a6e-8f01-23456789abcd
NONCE="$(date +%s)"
failed=0

context=$($KUBECTL config current-context)
if [[ "$context" != k3d-* && "$context" != "${KOBE_GATESSO_CONTEXT:-}" ]]; then
  echo "refusing to run against context '$context' (expected k3d-*, or set KOBE_GATESSO_CONTEXT=$context)" >&2
  exit 2
fi

# shellcheck source=lib/gate-common.sh
source e2e/lib/gate-common.sh
# shellcheck disable=SC2034 # read by client() in gate-common.sh
CLIENT_JS="$(sed '/^const MODES = {/,$d' e2e/gate1/client.mjs; cat e2e/sso/scim-client.mjs e2e/gate-sso/client.mjs)"
WORK=$(mktemp -d)
chmod 700 "$WORK"
PODS=()
UNDO=()
cleanup() {
  local rc=$?
  local u
  for u in "${UNDO[@]+"${UNDO[@]}"}"; do eval "$u" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
  verdict_on_exit "$rc" "Kobe SSO Gate"
}
trap cleanup EXIT

PARTS_FAILED=" "
failed_before=0
part_begin() { failed_before=$failed; failed=0; echo "==> $1"; }
part_end() { # part
  ((failed)) && PARTS_FAILED+="$1 "
  ((failed_before)) && failed=1
  return 0
}
show() { printf '%s\n' "$2" | grep -v '^jar=\|^scim_token=' | sed "s/^/     $1: /"; }

# ---- setup: CA, mock Entra, DNS, chart -----------------------------------------------------------
part_begin "setup: the mock Entra answers as login.microsoftonline.com, trusted through extraCaBundle"
$KUBECTL create namespace "$INFRA_NS" --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
# The test CA is kept in the infra namespace and reused by reruns: the server reads its extra CA
# bundle only at start, and a rerun's chart upgrade with the same values does not restart it.
if $KUBECTL -n "$INFRA_NS" get secret mock-entra-ca >/dev/null 2>&1; then
  $KUBECTL -n "$INFRA_NS" get secret mock-entra-ca -o jsonpath='{.data.tls\.crt}' | base64 -d >"$WORK/ca.crt"
  $KUBECTL -n "$INFRA_NS" get secret mock-entra-ca -o jsonpath='{.data.tls\.key}' | base64 -d >"$WORK/ca.key"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Kobe SSO gate test CA" \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  $KUBECTL -n "$INFRA_NS" create secret tls mock-entra-ca --cert="$WORK/ca.crt" --key="$WORK/ca.key" >/dev/null
fi
# The client secret is kept the same way (the server reads it from its env at start).
CLIENT_SECRET=$($KUBECTL -n "$INFRA_NS" get secret mock-entra-client -o jsonpath='{.data.client-secret}' 2>/dev/null | base64 -d 2>/dev/null || true)
[[ -n "$CLIENT_SECRET" ]] || CLIENT_SECRET="mock-secret-$NONCE-$RANDOM$RANDOM"
openssl req -newkey rsa:2048 -nodes -subj "/CN=login.microsoftonline.com" \
  -keyout "$WORK/tls.key" -out "$WORK/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:login.microsoftonline.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' >"$WORK/ext.cnf"
openssl x509 -req -days 2 -in "$WORK/tls.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial \
  -CAserial "$WORK/ca.srl" -extfile "$WORK/ext.cnf" -out "$WORK/tls.crt" 2>/dev/null
SERVER_IMAGE=$($KUBECTL -n "$NS" get "$SERVER" -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
$KUBECTL -n "$INFRA_NS" create secret tls mock-entra-tls --cert="$WORK/tls.crt" --key="$WORK/tls.key" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$INFRA_NS" create secret generic mock-entra-client --from-literal=client-secret="$CLIENT_SECRET" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$INFRA_NS" create configmap mock-entra-code --from-file=mock-entra.mjs=e2e/sso/mock-entra.mjs \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$INFRA_NS" delete pod mock-entra --ignore-not-found >/dev/null
$KUBECTL -n "$INFRA_NS" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: mock-entra
  labels: { app: mock-entra }
spec:
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }
  containers:
    - name: mock
      image: $SERVER_IMAGE
      imagePullPolicy: IfNotPresent
      command: [node, /mock/mock-entra.mjs]
      env:
        - { name: MOCK_TENANTS, value: "$TENANT,$TENANT_G" }
        - { name: MOCK_CLIENT_ID, value: "$CLIENT_ID" }
        - name: MOCK_CLIENT_SECRET
          valueFrom: { secretKeyRef: { name: mock-entra-client, key: client-secret } }
        - { name: MOCK_TLS_CERT, value: /tls/tls.crt }
        - { name: MOCK_TLS_KEY, value: /tls/tls.key }
        - { name: PORT, value: "8443" }
      ports: [{ containerPort: 8443 }]
      readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 }
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumeMounts:
        - { name: code, mountPath: /mock, readOnly: true }
        - { name: tls, mountPath: /tls, readOnly: true }
  volumes:
    - { name: code, configMap: { name: mock-entra-code } }
    - { name: tls, secret: { secretName: mock-entra-tls } }
---
apiVersion: v1
kind: Service
metadata:
  name: mock-entra
spec:
  selector: { app: mock-entra }
  ports: [{ port: 443, targetPort: 8443 }]
YAML
$KUBECTL -n "$INFRA_NS" wait --for=condition=Ready pod/mock-entra --timeout=180s >/dev/null 2>&1 || true
contains "the mock Entra runs from the server image and listens" '^True$' \
  "$($KUBECTL -n "$INFRA_NS" get pod mock-entra -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)"
MOCK_IP=$($KUBECTL -n "$INFRA_NS" get svc mock-entra -o jsonpath='{.spec.clusterIP}')

# CoreDNS (k3s imports coredns-custom/*.override into its server block): the Entra name answers
# with the mock's Service, the name kept in the answer (`answer auto`). Undone at exit.
dns_rule="rewrite stop {
  name exact login.microsoftonline.com mock-entra.$INFRA_NS.svc.cluster.local
  answer auto
}"
if $KUBECTL -n kube-system get configmap coredns-custom >/dev/null 2>&1; then
  $KUBECTL -n kube-system patch configmap coredns-custom --type merge \
    -p "$(printf '{"data":{"kobe-sso-gate.override":"%s"}}' "${dns_rule//$'\n'/\\n}")" >/dev/null
else
  $KUBECTL -n kube-system create configmap coredns-custom --from-literal=kobe-sso-gate.override="$dns_rule" >/dev/null
fi
UNDO+=("$KUBECTL -n kube-system patch configmap coredns-custom --type json -p '[{\"op\":\"remove\",\"path\":\"/data/kobe-sso-gate.override\"}]' && $KUBECTL -n kube-system rollout restart deploy/coredns")
$KUBECTL -n kube-system rollout restart deploy/coredns >/dev/null
$KUBECTL -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null 2>&1 || fail "CoreDNS restarted with the rewrite"

# The release: the CA, the client secret, and the two Entra providers as configuration.
old_ca=$($KUBECTL -n "$NS" get configmap kobe-sso-gate-ca -o jsonpath='{.data.ca\.crt}' 2>/dev/null || true)
$KUBECTL -n "$NS" create configmap kobe-sso-gate-ca --from-file=ca.crt="$WORK/ca.crt" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
$KUBECTL -n "$NS" create secret generic kobe-sso-gate-client --from-literal=client-secret="$CLIENT_SECRET" \
  --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
providers=$(printf '[{"slug":"entra-mock","displayName":"Mock Entra","kind":"entra","tenantId":"%s","clientId":"%s","clientSecretSecret":{"name":"kobe-sso-gate-client","key":"client-secret"},"accessClaim":"roles","allowedEmailDomains":["sso.test"]},{"slug":"entra-groups","displayName":"Mock Entra groups","kind":"entra","tenantId":"%s","clientId":"%s","clientSecretSecret":{"name":"kobe-sso-gate-client","key":"client-secret"},"accessClaim":"groups"}]' \
  "$TENANT" "$CLIENT_ID" "$TENANT_G" "$CLIENT_ID")
saved="$WORK/values.yaml"
# `--reuse-values` would keep the old chart's defaults; saved values + --reset-values do not.
$HELM get values "$RELEASE" -n "$NS" -o yaml >"$saved"
if out=$($HELM upgrade "$RELEASE" "$CHART" -n "$NS" -f "$saved" --reset-values --wait --timeout 8m \
    --set auth.sso.enabled=true --set-json "auth.sso.allowedInternalCidrs=[\"$MOCK_IP/32\"]" \
    --set-json "auth.sso.providers=$providers" \
    --set server.extraCaBundle.configMapName=kobe-sso-gate-ca --set server.extraCaBundle.key=ca.crt 2>&1); then
  ok "the chart declares both providers, the mock's address and its CA (saved values kept)"
else
  fail "the chart upgrade: $(printf '%s' "$out" | tail -3)"
fi
if [[ "$context" != k3d-* ]]; then
  UNDO+=("$HELM upgrade $RELEASE $CHART -n $NS -f $saved --reset-values --wait --timeout 8m")
fi
# A different CA in an already-mounted bundle reaches Node only at start (an earlier run's CA).
if [[ -n "$old_ca" && "$old_ca" != "$(cat "$WORK/ca.crt")" ]]; then
  $KUBECTL -n "$NS" rollout restart "$SERVER" >/dev/null
fi
for d in $($KUBECTL -n "$NS" get deploy -l "app.kubernetes.io/instance=$RELEASE" -o name 2>/dev/null); do
  $KUBECTL -n "$NS" rollout status "$d" --timeout=300s >/dev/null 2>&1 || fail "$d rolled out after the upgrade"
done
server_answers() {
  $KUBECTL -n "$NS" exec "$SERVER" -c server -- node -e \
    "fetch('$BASE/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1
}
until_ok 180 server_answers && ok "the server answers after the upgrade" || fail "the server answers after the upgrade"
step() { client "$(printf '{"mode":"%s","base":"%s","owner":{"email":"%s","password":"%s"},%s}' "$1" "$BASE" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$2")"; }
mock_seen() { [[ "$(field resolved "$(step mock-stats '"x":0')")" == "$MOCK_IP" ]]; }
until_ok 90 mock_seen || true
ms=$(step mock-stats '"x":0')
contains "the server pod resolves login.microsoftonline.com to the mock (no internet involved)" "^resolved=${MOCK_IP//./\\.}\$" "$ms"
contains "...and trusts its certificate through server.extraCaBundle" '^tls=trusted$' "$ms"

# Fixtures: the team the mappings grant (its admin is a local user).
setup_token=$($KUBECTL -n "$NS" get secret "$RELEASE-auth" -o jsonpath='{.data.setup-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
fx=$(client "$(printf '{"mode":"fixtures","base":"%s","owner":{"email":"%s","password":"%s"},"setupToken":"%s","users":[{"key":"ta","email":"sso-ta@gate-sso.test","name":"SSO Team Admin","team":"a","ip":"198.51.100.90"}],"teams":[{"key":"a","slug":"%s","name":"SSO A"}]}' \
  "$BASE" "$OWNER_EMAIL" "$OWNER_PASSWORD" "$setup_token" "$TEAM_SLUG")")
TEAM=$(field fixtures "$fx" | sed -n 's/.*"teams":{"a":"\([0-9a-f-]*\)".*/\1/p')
[[ "$TEAM" =~ ^[0-9a-f-]{36}$ ]] && ok "fixtures: team $TEAM_SLUG" || { show fixtures "$fx"; fail "fixtures: team $TEAM_SLUG"; exit 1; }
mappings=$(printf '[{"slug":"entra-mock","value":"Kobe.Member","role":"member"},{"slug":"entra-mock","value":"Kobe.TeamAdmin","role":"team_admin"},{"slug":"entra-groups","value":"%s","role":"contributor"}]' "$GROUP_ID")
su=$(step sso-setup "\"slugs\":[\"entra-mock\",\"entra-groups\"],\"teamId\":\"$TEAM\",\"mappings\":$mappings")
show setup "$su"
contains "both providers are Helm-managed Entra providers" '^provider_entra-mock=entra:helm$' "$su"
contains "...and show as sign-in buttons" '^buttons=entra-groups,entra-mock$' "$su"
contains "discovery against the mock passes every check (entra-mock)" '^discovery_entra-mock=ok$' "$su"
contains "discovery against the mock passes every check (entra-groups)" '^discovery_entra-groups=ok$' "$su"
contains "the access mappings exist" '^mapping_entra-groups_contributor=(201|exists)$' "$su"
part_end setup

# ---- sign-in helpers ---------------------------------------------------------------------------------
uuid() { { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; } | tr 'A-F' 'a-f'; }
user_json() { # key roles-json [extra-json-fields] → a mock person (oid fresh per run)
  printf '{"oid":"%s","upn":"%s-%s@sso.test","name":"SSO %s","roles":%s%s}' \
    "$(uuid)" "$1" "$NONCE" "$1" "$2" "${3:+,$3}"
}
# Each sign-in from a random client address: Kobe allows 20 SSO starts and callbacks per address
# a minute (called in $(...), so a counter would not survive).
signin() { # slug user-json [extra config fields] → the step's output
  local ip
  ip="198.51.100.$(($(od -An -N1 -tu1 /dev/urandom) % 150 + 100))"
  step sso-signin "\"slug\":\"$1\",\"user\":$2,\"ip\":\"$ip\"${3:+,$3}"
}

# ---- sign-in and JIT by mapping --------------------------------------------------------------------
part_begin "sign-in: a mapped Entra person gets a user, a team role and a session"
U1=$(user_json u1 '["Kobe.Member"]' '"mfa":true')
s1=$(signin entra-mock "$U1")
show u1 "$s1"
contains "Kobe sends the browser to login.microsoftonline.com with PKCE S256" '^authorize_host=login\.microsoftonline\.com$' "$s1"
contains "...asking for the authentication context c1 (MFA)" '^claims_param=\{"id_token":\{"acrs":\{"essential":true,"value":"c1"\}\}\}$' "$s1"
contains "the mock sends the browser back to Kobe's redirect URI" '^redirect_uri=public$' "$s1"
contains "the callback lands on the requested page" '^landed=/$' "$s1"
contains "...with a working session" '^session=200$' "$s1"
contains "JIT: the user exists, made by the mapping (Kobe.Member → member of $TEAM_SLUG)" "^teams=$TEAM_SLUG:member\$" "$s1"
contains "...linked by JIT on the Entra object id" '^identity=jit:' "$s1"
U1_ID=$(field user_id "$s1")
s1b=$(signin entra-mock "$U1")
contains "a second sign-in is the same user" "^user_id=$U1_ID\$" "$s1b"
contains "...and makes no second user" '^users=1$' "$s1b"
s4=$(signin entra-mock "$(user_json u4 '["Kobe.TeamAdmin"]')")
contains "an app role mapped to team admin gives that role" "^teams=$TEAM_SLUG:team_admin\$" "$s4"
s5=$(signin entra-groups "$(user_json u5 '[]' "\"groups\":[\"$GROUP_ID\"]")")
contains "a group mapping (groups claim, second tenant) gives contributor" "^teams=$TEAM_SLUG:contributor\$" "$s5"
part_end signin

# ---- refusals ------------------------------------------------------------------------------------
part_begin "refusal: unmapped, overage, IdP error, replayed state and every bad-token mode"
r=$(signin entra-mock "$(user_json r1 '["Unmapped.Role"]')")
contains "an unmapped person is refused (not_allowed)" '^sso_error=not_allowed$' "$r"
contains "...and gets no user" '^users=0$' "$r"
contains "...and no session" '^session=401$' "$r"
many=$(for _ in $(seq 201); do printf '"%s",' "$(uuid)"; done)
many="[${many%,}]"
r=$(signin entra-groups "$(user_json r2 '[]' "\"groups\":$many")")
contains "a groups overage (201 groups, no SCIM) is refused (groups_overage)" '^sso_error=groups_overage$' "$r"
contains "...and gets no user" '^users=0$' "$r"
r=$(signin entra-mock "$(user_json r3 '["Kobe.Member"]')" '"mockMode":"deny"')
contains "the IdP answering access_denied is refused (idp_error)" '^sso_error=idp_error$' "$r"
r=$(signin entra-mock "$(user_json r4 '["Kobe.Member"]')" '"replay":true')
contains "a replayed callback is refused (state_invalid) after the first one signed in" '^replay_landed=/sign-in\?sso_error=state_invalid$' "$r"
# wrong_iss: openid-client refuses the issuer before Kobe's own check (which would say tenant_mismatch).
for case in wrong_iss:token_invalid wrong_aud:token_invalid wrong_nonce:token_invalid expired:token_invalid \
  stale_auth_time:token_invalid alg_none:token_invalid hs256:token_invalid foreign_key:token_invalid \
  missing_tid:tenant_mismatch wrong_tid:tenant_mismatch; do
  mode=${case%%:*}
  want=${case#*:}
  r=$(signin entra-mock "$(user_json "bad-${mode//_/-}" '["Kobe.Member"]')" "\"mockMode\":\"$mode\"")
  if grep -Eq "^sso_error=$want\$" <<<"$r" && grep -Eq '^users=0$' <<<"$r" && grep -Eq '^session=401$' <<<"$r"; then
    ok "bad token $mode: refused ($want), no user, no session"
  else
    fail "bad token $mode: refused ($want), no user, no session: got [$(grep -E '^(sso_error|users|session)=' <<<"$r" | tr '\n' ' ')]"
  fi
done
part_end refusal

# ---- MFA -----------------------------------------------------------------------------------------
part_begin "MFA: acrs c1 proves MFA; without it require_2fa refuses and ends weak sessions"
U2=$(user_json u2 '["Kobe.Member"]' '"mfa":false')
m2=$(signin entra-mock "$U2")
contains "without require_2fa a person without MFA signs in" '^session=200$' "$m2"
contains "...recorded as not MFA-proven" '^sso_mfa=false$' "$m2"
m1=$(signin entra-mock "$U1")
contains "a person passing Conditional Access (acrs c1) is recorded as MFA-proven" '^sso_mfa=true$' "$m1"
J1=$(field jar "$m1")
J2=$(field jar "$m2")
UNDO+=("client '{\"mode\":\"require-2fa\",\"base\":\"$BASE\",\"owner\":{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"},\"on\":false}'")
contains "the Owner turns on require_2fa" '^require_2fa=200$' "$(step require-2fa '"on":true')"
contains "...which ends the session without MFA proof" '^session=401$' "$(step sso-session "\"jar\":\"$J2\",\"ip\":\"198.51.100.91\"")"
contains "...and keeps the MFA-proven one" '^session=200$' "$(step sso-session "\"jar\":\"$J1\",\"ip\":\"198.51.100.92\"")"
m2b=$(signin entra-mock "$U2")
contains "a sign-in without MFA is refused (mfa_missing)" '^sso_error=mfa_missing$' "$m2b"
contains "...with no session" '^session=401$' "$m2b"
m1b=$(signin entra-mock "$U1")
contains "a sign-in with acrs c1 passes require_2fa" '^session=200$' "$m1b"
contains "...MFA-proven" '^sso_mfa=true$' "$m1b"
contains "require_2fa is turned off again" '^require_2fa(_restored)?=(200|db)$' "$(step require-2fa '"on":false')"
part_end mfa

# ---- SCIM ----------------------------------------------------------------------------------------
part_begin "SCIM: Entra's provisioning requests; deactivation ends the session in the same request"
tk=$(step scim-token '"slug":"entra-mock"')
contains "a SCIM token is issued for the provider" '^scim_token_status=201$' "$tk"
contains "...for its Tenant URL" '^scim_base=/v1/scim/v2/entra-mock$' "$tk"
TOKEN=$(field scim_token "$tk")
TOKEN_ID=$(field scim_token_id "$tk")
OID3=$(uuid)
UPN3="u3-$NONCE@sso.test"
SU=$(printf '{"externalId":"%s","userName":"%s","name":"Scim Three","newName":"Scim Three-Renamed"}' "$OID3" "$UPN3")
scim() { step scim "\"slug\":\"entra-mock\",\"token\":\"$TOKEN\",\"scimUser\":$SU,\"action\":\"$1\"${2:+,\"id\":\"$2\"}"; }
p=$(scim provision)
show provision "$p"
contains "Entra's probe (random userName) answers an empty list" '^probe=200:0$' "$p"
contains "...its match by userName finds nobody" '^match=200:0$' "$p"
contains "...its create (enterprise extension, roles, work email) is 201" '^create=201$' "$p"
contains "...and the user is found again by externalId (the object id)" '^by_external_id=200:1$' "$p"
contains "a second create is a uniqueness conflict" '^duplicate=409:uniqueness$' "$p"
SCIM_ID=$(field scim_id "$p")
u=$(scim update "$SCIM_ID")
contains "PATCH with Entra's quirks (Replace/Add, emails[type eq \"work\"].value, path-less object)" '^update=200' "$u"
contains "...renames the user" '^display_name=Scim Three-Renamed$' "$u"
U3=$(printf '{"oid":"%s","upn":"%s","name":"Scim Three","roles":["Kobe.Member"]}' "$OID3" "$UPN3")
s3=$(signin entra-mock "$U3")
contains "the provisioned person signs in by SSO" '^session=200$' "$s3"
contains "...as the SCIM-made user (linked by SCIM on externalId)" "^identity=scim:$SCIM_ID\$" "$s3"
J3=$(field jar "$s3")
d=$(scim deactivate "$SCIM_ID")
contains "Entra's soft delete (active \"False\") deactivates" '^deactivate=200:active=false$' "$d"
contains "...and the person's session has ended by the next request" '^session=401$' "$(step sso-session "\"jar\":\"$J3\",\"ip\":\"198.51.100.93\"")"
s3b=$(signin entra-mock "$U3")
contains "a deactivated person's SSO sign-in is refused (deactivated)" '^sso_error=deactivated$' "$s3b"
contains "...with no session" '^session=401$' "$s3b"
contains "Entra's reactivation (active \"True\") reactivates" '^reactivate=200:active=true$' "$(scim reactivate "$SCIM_ID")"
s3c=$(signin entra-mock "$U3")
contains "...and the person signs in again" '^session=200$' "$s3c"
J3=$(field jar "$s3c")
x=$(scim delete "$SCIM_ID")
contains "Entra's hard delete is 204" '^delete=204$' "$x"
contains "...the user is gone from SCIM" '^get_after_delete=404$' "$x"
contains "...and the session has ended" '^session=401$' "$(step sso-session "\"jar\":\"$J3\",\"ip\":\"198.51.100.94\"")"
contains "the Owner revokes the token" '^revoke=200$' "$(step scim-revoke "\"slug\":\"entra-mock\",\"tokenId\":\"$TOKEN_ID\"")"
contains "...and Entra's next request is 401" '^probe=401$' "$(scim probe)"
part_end scim

# ---- the mock's view -------------------------------------------------------------------------------
echo "==> the mock's counters"
ms=$(step mock-stats '"x":0')
stats=$(field stats "$ms")
echo "     $stats"
token_ok=$(sed -n 's/.*"token_ok":\([0-9]*\).*/\1/p' <<<"$stats")
discovery=$(sed -n 's/.*"discovery":\([0-9]*\).*/\1/p' <<<"$stats")
if [[ "${token_ok:-0}" -ge 5 && "${discovery:-0}" -ge 2 ]]; then
  ok "Kobe's own discovery and token requests reached the mock ($discovery, $token_ok)"
else
  fail "Kobe's own discovery and token requests reached the mock: got [$stats]"
  PARTS_FAILED+="mock "
fi

if [[ "$PARTS_FAILED" != " " ]]; then
  verdict "Kobe SSO Gate: FAILED (parts failed:${PARTS_FAILED% })"
  exit 1
fi
verdict "Kobe SSO Gate (k3d): proven"
