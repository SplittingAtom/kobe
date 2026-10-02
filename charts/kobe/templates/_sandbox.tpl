{{/*
Sandbox values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates the `sandbox` key still renders. Keep in sync with values.yaml.
*/}}
{{- define "kobe.sandboxValues" -}}
{{- $defaults := dict
  "resources" (dict "requests" (dict "cpu" "500m" "memory" "1Gi") "limits" (dict "cpu" "2" "memory" "4Gi"))
  "workspace" (dict "size" "10Gi" "storageClass" "")
  "tmpSize" "2Gi"
  "homeSize" "1Gi"
  "teamQuota" (dict "requests.cpu" "20" "requests.memory" "40Gi")
  "warmPool" (dict "replicasPerTeam" 1)
  "sessionKeysSecret" "" -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.sandbox | default dict)) | toJson -}}
{{- end -}}

{{/* Names shared by RBAC, admission policies and the server's sandbox config. */}}
{{- define "kobe.sandboxManagerRole" -}}
{{- include "kobe.clusterName" (dict "root" . "suffix" "sandbox-manager") -}}
{{- end -}}

{{- define "kobe.serverServiceAccount" -}}
{{- printf "%s-server" (include "kobe.fullname" .) -}}
{{- end -}}

{{- define "kobe.sessionKeysSecretName" -}}
{{- $s := include "kobe.sandboxValues" . | fromJson -}}
{{- default (printf "%s-sandbox-session-keys" (include "kobe.fullname" .)) $s.sessionKeysSecret -}}
{{- end -}}

{{/* Session-token audiences and the Secret keys holding their HMAC keys (one per audience). */}}
{{- define "kobe.sessionKeyNames" -}}
{{- toJson (dict "SANDBOX_WIRE" "sandbox-wire" "MODEL_GATEWAY" "model-gateway" "MCP_PROXY" "mcp-proxy" "EGRESS_PROXY" "egress-proxy") -}}
{{- end -}}

{{/*
KOBE_SANDBOX_CONFIG for the server (validated by services/server/src/sandbox/config.ts): the
sandbox image and sizing, and how sandboxes reach Kobe's services (Service for the ClusterIP,
pod labels and port for the team NetworkPolicy).
*/}}
{{- define "kobe.sandboxConfig" -}}
{{- $fullname := include "kobe.fullname" . -}}
{{- $s := include "kobe.sandboxValues" . | fromJson -}}
{{- $endpoints := dict -}}
{{- range $key, $e := dict "server" (list "server" 80) "modelGateway" (list "bifrost" 8080) "mcpProxy" (list "mcp-proxy" 80) "egressProxy" (list "egress-proxy" 80) -}}
{{- $component := index $e 0 -}}
{{- $_ := set $endpoints $key (dict
  "service" (printf "%s-%s" $fullname $component)
  "port" (index $e 1)
  "targetPort" 8080
  "podLabels" (include "kobe.selectorLabels" (dict "root" $ "component" $component) | fromYaml)) -}}
{{- end -}}
{{- $pullSecrets := list -}}
{{- range .Values.global.imagePullSecrets -}}
{{- $pullSecrets = append $pullSecrets .name -}}
{{- end -}}
{{- $quota := dict -}}
{{- range $k, $v := $s.teamQuota -}}
{{- $_ := set $quota $k (toString $v) -}}
{{- end -}}
{{- toJson (dict
  "image" (include "kobe.image" (dict "root" . "name" "sandbox"))
  "imagePullPolicy" .Values.global.imagePullPolicy
  "imagePullSecrets" $pullSecrets
  "releaseNamespace" .Release.Namespace
  "serverServiceAccount" (include "kobe.serverServiceAccount" .)
  "managerClusterRole" (include "kobe.sandboxManagerRole" .)
  "endpoints" $endpoints
  "resources" (dict
    "requests" (dict "cpu" (toString $s.resources.requests.cpu) "memory" (toString $s.resources.requests.memory))
    "limits" (dict "cpu" (toString $s.resources.limits.cpu) "memory" (toString $s.resources.limits.memory)))
  "workspace" (dict "size" (toString $s.workspace.size) "storageClass" $s.workspace.storageClass)
  "tmpSize" (toString $s.tmpSize)
  "homeSize" (toString $s.homeSize)
  "teamQuota" $quota
  "warmPool" (dict "replicasPerTeam" (int $s.warmPool.replicasPerTeam))) -}}
{{- end -}}

{{/* Server env: sandbox config and the session-token keys (the server holds all four). */}}
{{- define "kobe.sandboxEnv" -}}
- name: KOBE_SANDBOX_CONFIG
  value: {{ include "kobe.sandboxConfig" . | quote }}
{{- range $env, $key := include "kobe.sessionKeyNames" . | fromJson }}
- name: KOBE_SESSION_KEY_{{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" $ }}
      key: {{ $key }}
{{- end }}
{{- end -}}
