{{/*
Isolation check at install/upgrade time (spec D4). When Helm can reach the cluster (install,
upgrade, --dry-run=server) it fails immediately with remediation text if no RuntimeClass has a
gVisor (runsc) or Kata (kata*) handler. Offline renders skip this; the preflight hook Job then
enforces the same rule in-cluster. Keep the text identical to the server's ISOLATION_REMEDIATION
(a chart test checks it). There is deliberately no way to disable this.
*/}}
{{- define "kobe.isolationCheck" -}}
{{- if lookup "v1" "Namespace" "" "kube-system" -}}
{{- $found := false -}}
{{- range (lookup "node.k8s.io/v1" "RuntimeClass" "" "").items -}}
{{- if regexMatch "^(runsc|kata(-[a-z0-9]+)?)$" .handler -}}
{{- $found = true -}}
{{- end -}}
{{- end -}}
{{- if not $found -}}
{{- fail "Kobe refuses to run agents without an isolation runtime: no RuntimeClass with a gVisor (handler 'runsc') or Kata ('kata*') handler exists in this cluster. Fix: install gVisor on every node with scripts/install-gvisor-k3s.sh (creates RuntimeClass 'gvisor', handler 'runsc'), or install Kata Containers, then retry. See docs/install.md#isolation." -}}
{{- end -}}
{{- end -}}
{{- end -}}
