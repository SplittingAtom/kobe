#!/usr/bin/env bash
# Deploys the mock identity provider for the browser SSO spec (KOBE-634,
# e2e/browser/tests/sso.spec.ts) next to a running Kobe release, as its own generic OIDC provider.
# It never touches DNS, kube-system or a real provider: the mock's issuer is its in-cluster name.
#
#   KUBECTL="sudo k3s kubectl" KOBE_NS=<release namespace> e2e/sso/gate1-mock-idp.sh
#
# Idempotent: reruns keep the CA, the client secret and the tenant/client ids (a provider's issuer
# can't change once someone signed in with it), and restart the mock only when its code changed.
# Afterwards it prints the Helm values to add (the CA bundle and the mock's address) and the
# variables the spec needs. Remove: `$KUBECTL delete namespace kobe-sso-mock` and the
# `kobe-sso-mock-ca` ConfigMap in the release namespace, then drop the values again.
set -euo pipefail
cd "$(dirname "$0")"

KUBECTL="${KUBECTL:-kubectl}"
KOBE_NS="${KOBE_NS:?KOBE_NS (the Kobe release namespace) is required}"
RELEASE="${KOBE_RELEASE:-kobe}"
NS=kobe-sso-mock
HOST="mock-idp.$NS.svc.cluster.local"
# Fixed ids: the mock is a test provider; nothing about them is secret.
TENANT=6f0b2a41-1c1e-4c43-9d5e-0a5f3a1b2c34
CLIENT_ID=0b5c1d7e-8a2f-4e61-9c3d-5e7f9a1b3c34
k() { $KUBECTL "$@"; }

k get namespace "$KOBE_NS" >/dev/null
WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null

# Test CA (kept in the namespace and reused), then a leaf for the in-cluster name.
if k -n "$NS" get secret mock-idp-ca >/dev/null 2>&1; then
  k -n "$NS" get secret mock-idp-ca -o jsonpath='{.data.tls\.crt}' | base64 -d >"$WORK/ca.crt"
  k -n "$NS" get secret mock-idp-ca -o jsonpath='{.data.tls\.key}' | base64 -d >"$WORK/ca.key"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=Kobe e2e mock IdP CA" \
    -keyout "$WORK/ca.key" -out "$WORK/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  k -n "$NS" create secret tls mock-idp-ca --cert="$WORK/ca.crt" --key="$WORK/ca.key" >/dev/null
fi
if ! k -n "$NS" get secret mock-idp-tls >/dev/null 2>&1; then
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" \
    -keyout "$WORK/tls.key" -out "$WORK/tls.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' "$HOST" >"$WORK/ext.cnf"
  openssl x509 -req -days 180 -in "$WORK/tls.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
    -CAcreateserial -CAserial "$WORK/ca.srl" -extfile "$WORK/ext.cnf" -out "$WORK/tls.crt" 2>/dev/null
  k -n "$NS" create secret tls mock-idp-tls --cert="$WORK/tls.crt" --key="$WORK/tls.key" >/dev/null
fi
if ! k -n "$NS" get secret mock-idp-client >/dev/null 2>&1; then
  k -n "$NS" create secret generic mock-idp-client \
    --from-literal=client-secret="mock-$(openssl rand -hex 24)" >/dev/null
fi

k -n "$NS" create configmap mock-idp-code --from-file=mock-entra.mjs=mock-entra.mjs \
  --dry-run=client -o yaml | k apply -f - >/dev/null
CODE_HASH=$(sha256sum mock-entra.mjs | cut -c1-16)
SERVER_IMAGE=$(k -n "$KOBE_NS" get "deploy/$RELEASE-server" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
sed -e "s|__SERVER_IMAGE__|$SERVER_IMAGE|g" -e "s|__TENANT__|$TENANT|g" \
  -e "s|__CLIENT_ID__|$CLIENT_ID|g" -e "s|__HOST__|$HOST|g" -e "s|__KOBE_NS__|$KOBE_NS|g" \
  -e "s|__CODE_HASH__|$CODE_HASH|g" gate1-mock-idp.yaml | k apply -f - >/dev/null
k -n "$NS" rollout status deploy/mock-idp --timeout=180s >/dev/null

# The CA for the server's extra bundle, in the release namespace.
k -n "$KOBE_NS" create configmap kobe-sso-mock-ca --from-file=ca.crt="$WORK/ca.crt" \
  --dry-run=client -o yaml | k apply -f - >/dev/null

MOCK_IP=$(k -n "$NS" get svc mock-idp -o jsonpath='{.spec.clusterIP}')
LB_IP=$(k -n kube-system get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
cat <<OUT
Mock IdP ready in namespace $NS (image $SERVER_IMAGE, code $CODE_HASH).

Helm values to add (helm get values -o yaml, edit, upgrade with -f ... --reset-values):
  auth.sso.allowedInternalCidrs: add "$MOCK_IP/32" (keep any existing entries)
  server.extraCaBundle: { configMapName: kobe-sso-mock-ca, key: ca.crt }
    (if the release already has an extra CA bundle, append this CA to that bundle instead)

Spec variables (e2e/browser/README.md, "Single sign-on"):
  KOBE_SSO_MOCK_ISSUER=https://$HOST/$TENANT/v2.0
  KOBE_SSO_MOCK_CLIENT_ID=$CLIENT_ID
  KOBE_SSO_MOCK_CLIENT_SECRET=\$($KUBECTL -n $NS get secret mock-idp-client -o jsonpath='{.data.client-secret}' | base64 -d)
  KOBE_SSO_MOCK_MAP=${LB_IP:-<ingress load-balancer IP>}:443
OUT
