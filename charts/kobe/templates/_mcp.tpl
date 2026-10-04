{{/*
MCP proxy values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates these keys still renders. Keep in sync with values.yaml.
*/}}
{{- define "kobe.mcpProxyValues" -}}
{{- $defaults := dict
  "allowInsecureHttp" false
  "allowedPorts" (list 443)
  "allowedInternalCidrs" (list)
  "deniedCidrs" (list)
  "internalKeySecret" ""
  "limits" (dict "maxRequestBytes" 1048576 "maxResponseBytes" 4194304 "upstreamTimeoutSeconds" 55 "callsPerSandbox" 8 "concurrentCalls" 256 "requestBurst" 60 "requestsPerSecond" 10)
  "networkPolicy" (dict "restrictEgress" true "extraEgress" (list)) -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.mcpProxy | default dict)) | toJson -}}
{{- end -}}

{{/* Secret holding the key the MCP proxy presents to the server's internal listener (KOBE-58). */}}
{{- define "kobe.mcpInternalKeySecretName" -}}
{{- $m := include "kobe.mcpProxyValues" . | fromJson -}}
{{- default (printf "%s-mcp-proxy-internal" (include "kobe.fullname" .)) $m.internalKeySecret -}}
{{- end -}}

{{/* The server's internal listener port (MCP proxy policy re-check). */}}
{{- define "kobe.serverInternalPort" -}}8082{{- end -}}

{{/* Server env: the internal listener and the key the MCP proxy must present. */}}
{{- define "kobe.serverInternalEnv" -}}
- name: KOBE_INTERNAL_PORT
  value: {{ include "kobe.serverInternalPort" . | quote }}
- name: KOBE_MCP_PROXY_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.mcpInternalKeySecretName" . }}
      key: key
{{- end -}}

{{/*
MCP proxy env (services/mcp-proxy/src/config.ts): its own session key only (never the other
audiences'), the server's internal listener and its key, the upstream policy and limits. No
database: the server decides every call.
*/}}
{{- define "kobe.mcpProxyEnv" -}}
{{- $m := include "kobe.mcpProxyValues" . | fromJson -}}
- name: KOBE_SESSION_KEY_MCP_PROXY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: mcp-proxy
- name: KOBE_MCP_INTERNAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.mcpInternalKeySecretName" . }}
      key: key
- name: KOBE_MCP_SERVER_URL
  value: {{ printf "http://%s-server:%s" (include "kobe.fullname" .) (include "kobe.serverInternalPort" .) | quote }}
- name: KOBE_MCP_ALLOW_INSECURE_HTTP
  value: {{ ternary "true" "false" $m.allowInsecureHttp | quote }}
- name: KOBE_MCP_ALLOWED_PORTS
  value: {{ join "," $m.allowedPorts | quote }}
- name: KOBE_MCP_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $m.allowedInternalCidrs | quote }}
- name: KOBE_MCP_DENIED_CIDRS
  value: {{ join "," $m.deniedCidrs | quote }}
- name: KOBE_MCP_MAX_REQUEST_BYTES
  value: {{ int $m.limits.maxRequestBytes | quote }}
- name: KOBE_MCP_MAX_RESPONSE_BYTES
  value: {{ int $m.limits.maxResponseBytes | quote }}
- name: KOBE_MCP_UPSTREAM_TIMEOUT_MS
  value: {{ mul (int $m.limits.upstreamTimeoutSeconds) 1000 | quote }}
- name: KOBE_MCP_CALLS_PER_SANDBOX
  value: {{ int $m.limits.callsPerSandbox | quote }}
- name: KOBE_MCP_MAX_CONCURRENT_CALLS
  value: {{ int $m.limits.concurrentCalls | quote }}
- name: KOBE_MCP_REQUEST_BURST
  value: {{ int $m.limits.requestBurst | quote }}
- name: KOBE_MCP_REQUESTS_PER_SECOND
  value: {{ int $m.limits.requestsPerSecond | quote }}
{{- end -}}
