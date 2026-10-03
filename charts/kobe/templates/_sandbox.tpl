{{/*
Sandbox values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates the `sandbox` key still renders. Keep in sync with values.yaml.
*/}}
{{- define "kobe.sandboxValues" -}}
{{- $defaults := dict
  "resources" (dict "requests" (dict "cpu" "500m" "memory" "1Gi") "limits" (dict "cpu" "2" "memory" "4Gi"))
  "workspace" (dict "size" "10Gi" "storageClass" "" "longhornStrictLocal" (dict "enabled" false))
  "tmpSize" "2Gi"
  "homeSize" "1Gi"
  "ephemeralStorage" (dict "request" "1Gi" "limit" "4Gi")
  "modelGatewayAccess" false
  "teamQuota" (dict "requests.cpu" "20" "requests.memory" "40Gi" "limits.cpu" "40" "limits.memory" "80Gi" "requests.ephemeral-storage" "40Gi" "limits.ephemeral-storage" "160Gi" "requests.storage" "500Gi" "persistentvolumeclaims" "50" "pods" "50")
  "warmPool" (dict "replicasPerTeam" 1)
  "hibernation" (dict "enabled" true "idleMinutes" 15 "sweepSeconds" 60)
  "sessionKeysSecret" "" -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.sandbox | default dict)) | toJson -}}
{{- end -}}

{{/*
StorageClass of sandbox workspaces: the chart's Longhorn strict-local class when enabled, else
sandbox.workspace.storageClass ("" = the cluster default). Setting both is refused.
*/}}
{{- define "kobe.workspaceStorageClass" -}}
{{- $s := include "kobe.sandboxValues" . | fromJson -}}
{{- if $s.workspace.longhornStrictLocal.enabled -}}
{{- if $s.workspace.storageClass -}}
{{- fail "sandbox.workspace: set either storageClass or longhornStrictLocal.enabled, not both" -}}
{{- end -}}
{{- include "kobe.clusterName" (dict "root" . "suffix" "workspace-strict-local") -}}
{{- else -}}
{{- $s.workspace.storageClass -}}
{{- end -}}
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
{{- /* component, Service port, pod port. The server serves sandboxes on its own port 8081. */ -}}
{{- range $key, $e := dict "server" (list "server" 8081 8081) "modelGateway" (list "bifrost" 8080 8080) "mcpProxy" (list "mcp-proxy" 80 8080) "egressProxy" (list "egress-proxy" 80 8080) -}}
{{- $component := index $e 0 -}}
{{- $_ := set $endpoints $key (dict
  "service" (printf "%s-%s" $fullname $component)
  "port" (index $e 1)
  "targetPort" (index $e 2)
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
  "ephemeralStorage" (dict "request" (toString $s.ephemeralStorage.request) "limit" (toString $s.ephemeralStorage.limit))
  "modelGatewayAccess" $s.modelGatewayAccess
  "workspace" (dict "size" (toString $s.workspace.size) "storageClass" (include "kobe.workspaceStorageClass" .))
  "tmpSize" (toString $s.tmpSize)
  "homeSize" (toString $s.homeSize)
  "teamQuota" $quota
  "warmPool" (dict "replicasPerTeam" (int $s.warmPool.replicasPerTeam))
  "hibernation" (dict
    "enabled" $s.hibernation.enabled
    "idleMinutes" (int $s.hibernation.idleMinutes)
    "sweepSeconds" (int $s.hibernation.sweepSeconds))) -}}
{{- end -}}

{{/*
Server env: sandbox config, the session-token keys (the server holds all four) and the approval
HMAC key (KOBE-37). The approval key is optional so a pre-created Secret without `approval-hmac`
still starts: the server then denies every tool call that needs approval (fail closed) and logs it.
*/}}
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
- name: KOBE_APPROVAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: approval-hmac
      optional: true
{{- end -}}
