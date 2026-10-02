{{/*
Isolation check at install/upgrade time (spec D4). When Helm can reach the cluster (install,
upgrade, --dry-run=server) it fails immediately with remediation text unless isolation.runtimeClassName
exists and has a gVisor (runsc) or Kata (kata*) handler. Offline renders skip this; the preflight hook Job then
enforces the same rule in-cluster. Keep the text identical to the server's ISOLATION_REMEDIATION
(a chart test checks it). There is deliberately no way to disable this.
*/}}
{{- define "kobe.isolationCheck" -}}
{{- if lookup "v1" "Namespace" "" "kube-system" -}}
{{- $name := .Values.isolation.runtimeClassName -}}
{{- $rc := lookup "node.k8s.io/v1" "RuntimeClass" "" $name -}}
{{- if not $rc -}}
{{- fail (printf "RuntimeClass %q does not exist. %s" $name "Kobe refuses to run agents without an isolation runtime: no RuntimeClass with a gVisor (handler 'runsc') or Kata ('kata*') handler exists in this cluster. Fix: install gVisor on every node with scripts/install-gvisor-k3s.sh (creates RuntimeClass 'gvisor', handler 'runsc'), or install Kata Containers, then retry. See docs/install.md#isolation.") -}}
{{- end -}}
{{- if not (regexMatch "^(runsc|kata(-[a-z0-9]+)*)$" $rc.handler) -}}
{{- fail (printf "RuntimeClass %q has handler %q, which is not gVisor (runsc) or Kata (kata*). %s" $name $rc.handler "Kobe refuses to run agents without an isolation runtime: no RuntimeClass with a gVisor (handler 'runsc') or Kata ('kata*') handler exists in this cluster. Fix: install gVisor on every node with scripts/install-gvisor-k3s.sh (creates RuntimeClass 'gvisor', handler 'runsc'), or install Kata Containers, then retry. See docs/install.md#isolation.") -}}
{{- end -}}
{{- end -}}
{{- end -}}
