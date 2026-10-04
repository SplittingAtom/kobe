{{/*
Egress proxy values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates these keys still renders. Keep in sync with values.yaml.
*/}}
{{- define "kobe.egressProxyValues" -}}
{{- $defaults := dict
  "allowedPorts" (list 443)
  "allowedInternalCidrs" (list)
  "deniedCidrs" (list)
  "auditFlushSeconds" 60
  "headerSecret" ""
  "upgrade" (dict "maxRequestBytes" 104857600 "maxResponseBytes" 2147483648 "timeoutSeconds" 600)
  "limits" (dict "connectionsPerSandbox" 64 "connections" 4096 "bandwidthBytesPerSecond" 20971520 "idleTimeoutSeconds" 300 "maxTunnelSeconds" 3600 "unauthenticatedPerSource" 16 "unauthenticated" 1024)
  "networkPolicy" (dict "restrictEgress" true "databasePeers" (list) "databasePort" 5432 "extraEgress" (list)) -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.egressProxy | default dict)) | toJson -}}
{{- end -}}

{{/* Secret sealing the teams' injected egress header values (KOBE-39): server and proxy only. */}}
{{- define "kobe.egressHeaderSecretName" -}}
{{- $e := include "kobe.egressProxyValues" . | fromJson -}}
{{- default (printf "%s-egress-headers" (include "kobe.fullname" .)) $e.headerSecret -}}
{{- end -}}

{{/* The header secret (current, and previous when the Secret holds one) as env, for server and proxy. */}}
{{- define "kobe.egressHeaderEnv" -}}
- name: KOBE_EGRESS_HEADER_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.egressHeaderSecretName" . }}
      key: secret
- name: KOBE_EGRESS_HEADER_SECRET_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.egressHeaderSecretName" . }}
      key: secret-previous
      optional: true
{{- end -}}

{{/* Address ranges the proxy's own NetworkPolicy never sends to (internet rule `except`). */}}
{{- define "kobe.egressPrivateRanges" -}}
{{- toJson (list "0.0.0.0/8" "10.0.0.0/8" "100.64.0.0/10" "127.0.0.0/8" "169.254.0.0/16" "172.16.0.0/12" "192.0.0.0/24" "192.168.0.0/16" "198.18.0.0/15" "224.0.0.0/4" "240.0.0.0/4") -}}
{{- end -}}

{{/*
Egress proxy env (services/egress-proxy/src/config.ts): the database (app role), its own session
key only (never the other audiences' keys), the header-injection secret (KOBE-39), and limits.
*/}}
{{- define "kobe.egressProxyEnv" -}}
{{- $e := include "kobe.egressProxyValues" . | fromJson -}}
{{ include "kobe.databaseEnv" . }}
- name: KOBE_SESSION_KEY_EGRESS_PROXY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: egress-proxy
- name: KOBE_EGRESS_ALLOWED_PORTS
  value: {{ join "," $e.allowedPorts | quote }}
- name: KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $e.allowedInternalCidrs | quote }}
- name: KOBE_EGRESS_DENIED_CIDRS
  value: {{ join "," $e.deniedCidrs | quote }}
- name: KOBE_EGRESS_MAX_CONNECTIONS_PER_SANDBOX
  value: {{ int $e.limits.connectionsPerSandbox | quote }}
- name: KOBE_EGRESS_MAX_CONNECTIONS
  value: {{ int $e.limits.connections | quote }}
- name: KOBE_EGRESS_BANDWIDTH_BYTES_PER_SECOND
  value: {{ int64 $e.limits.bandwidthBytesPerSecond | quote }}
- name: KOBE_EGRESS_IDLE_TIMEOUT_MS
  value: {{ mul (int $e.limits.idleTimeoutSeconds) 1000 | quote }}
- name: KOBE_EGRESS_MAX_TUNNEL_SECONDS
  value: {{ int $e.limits.maxTunnelSeconds | quote }}
- name: KOBE_EGRESS_PREAUTH_PER_SOURCE
  value: {{ int $e.limits.unauthenticatedPerSource | quote }}
- name: KOBE_EGRESS_PREAUTH_TOTAL
  value: {{ int $e.limits.unauthenticated | quote }}
- name: KOBE_EGRESS_AUDIT_FLUSH_MS
  value: {{ mul (int $e.auditFlushSeconds) 1000 | quote }}
{{ include "kobe.egressHeaderEnv" . }}
- name: KOBE_EGRESS_UPGRADE_MAX_REQUEST_BYTES
  value: {{ int64 $e.upgrade.maxRequestBytes | quote }}
- name: KOBE_EGRESS_UPGRADE_MAX_RESPONSE_BYTES
  value: {{ int64 $e.upgrade.maxResponseBytes | quote }}
- name: KOBE_EGRESS_UPGRADE_TIMEOUT_MS
  value: {{ mul (int $e.upgrade.timeoutSeconds) 1000 | quote }}
{{- end -}}
