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
  "modelGatewayAccess" true
  "teamQuota" (dict "requests.cpu" "20" "requests.memory" "40Gi" "limits.cpu" "40" "limits.memory" "80Gi" "requests.ephemeral-storage" "40Gi" "limits.ephemeral-storage" "160Gi" "requests.storage" "500Gi" "persistentvolumeclaims" "50" "pods" "50")
  "warmPool" (dict "replicasPerTeam" 1)
  "hibernation" (dict "enabled" true "idleMinutes" 15 "sweepSeconds" 60)
  "workspaceSync" (dict "enabled" true "pushIntervalSeconds" 60 "maxFileSize" "1Gi" "maxWorkspaceSize" "" "maxFiles" 100000 "collectSeconds" 3600)
  "toolExecutor" (dict "enabled" false)
  "skillEval" (dict "maxConcurrentPerTeam" 4 "workspaceSize" "2Gi")
  "orbitEval" (dict "deadlineSeconds" 900 "resources" (dict "requests" (dict "cpu" "250m" "memory" "512Mi") "limits" (dict "cpu" "1" "memory" "2Gi")))
  "skillScan" (dict "enabled" false "deadlineSeconds" 300 "resources" (dict "requests" (dict "cpu" "250m" "memory" "512Mi") "limits" (dict "cpu" "1" "memory" "2Gi")))
  "sessionKeysSecret" ""
  "sessionVerifyKeysConfigMap" "" -}}
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

{{/*
ConfigMap with the session tokens' public keys (KOBE-513): the chart's own, or with a pre-created
sandbox.sessionKeysSecret, sandbox.sessionVerifyKeysConfigMap (required then).
*/}}
{{- define "kobe.sessionVerifyKeysName" -}}
{{- $s := include "kobe.sandboxValues" . | fromJson -}}
{{- if $s.sessionKeysSecret -}}
{{- if not $s.sessionVerifyKeysConfigMap -}}
{{- fail "sandbox.sessionKeysSecret is set: also set sandbox.sessionVerifyKeysConfigMap (the session tokens' public keys, keys sandbox-wire, model-gateway, mcp-proxy, egress-proxy; docs/install.md)" -}}
{{- end -}}
{{- $s.sessionVerifyKeysConfigMap -}}
{{- else -}}
{{- printf "%s-sandbox-session-verify-keys" (include "kobe.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* `<audience>` key of the verify-keys ConfigMap as a verifier's env var (public key only). */}}
{{- define "kobe.sessionVerifyKeyEnv" -}}
- name: KOBE_SESSION_VERIFY_KEY_{{ .env }}
  valueFrom:
    configMapKeyRef:
      name: {{ include "kobe.sessionVerifyKeysName" .root }}
      key: {{ .aud }}
{{- end -}}

{{/* Session-token audiences (env suffix -> Secret/ConfigMap key), one Ed25519 pair each. */}}
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
{{- /* component, Service port, pod port. The server serves sandboxes on its own port 8081; models
  are reached through the model-gateway shim (KOBE-40), never Bifrost itself. */ -}}
{{- range $key, $e := dict "server" (list "server" 8081 8081) "modelGateway" (list "model-gateway" 80 8080) "mcpProxy" (list "mcp-proxy" 80 8080) "egressProxy" (list "egress-proxy" 80 8080) -}}
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
{{- $cfg := (dict
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
    "sweepSeconds" (int $s.hibernation.sweepSeconds))
  "workspaceSync" (include "kobe.workspaceSyncConfig" $s | fromJson)
  "toolExecutor" (dict "enabled" $s.toolExecutor.enabled)
  "skillEval" (dict "maxConcurrentPerTeam" (int $s.skillEval.maxConcurrentPerTeam) "workspaceSize" (toString $s.skillEval.workspaceSize))
  "orbitEval" (dict
    "image" (include "kobe.image" (dict "root" . "name" "orbit-eval"))
    "deadlineSeconds" (int $s.orbitEval.deadlineSeconds)
    "resources" (dict
      "requests" (dict "cpu" (toString $s.orbitEval.resources.requests.cpu) "memory" (toString $s.orbitEval.resources.requests.memory))
      "limits" (dict "cpu" (toString $s.orbitEval.resources.limits.cpu) "memory" (toString $s.orbitEval.resources.limits.memory))))) -}}
{{- /* The external skill scanner's image only when the install has it (KOBE-341, review L10). */ -}}
{{- if $s.skillScan.enabled -}}
{{- $_ := set $cfg "skillScan" (dict
    "image" (include "kobe.image" (dict "root" . "name" "skill-scan"))
    "deadlineSeconds" (int $s.skillScan.deadlineSeconds)
    "resources" (dict
      "requests" (dict "cpu" (toString $s.skillScan.resources.requests.cpu) "memory" (toString $s.skillScan.resources.requests.memory))
      "limits" (dict "cpu" (toString $s.skillScan.resources.limits.cpu) "memory" (toString $s.skillScan.resources.limits.memory)))) -}}
{{- end -}}
{{- toJson $cfg -}}
{{- end -}}

{{/* KOBE-27 workspace sync settings; maxWorkspaceSize is omitted when empty (the volume size). */}}
{{- define "kobe.workspaceSyncConfig" -}}
{{- $w := .workspaceSync -}}
{{- $out := dict
  "enabled" $w.enabled
  "pushIntervalSeconds" (int $w.pushIntervalSeconds)
  "maxFileSize" (toString $w.maxFileSize)
  "maxFiles" (int $w.maxFiles)
  "collectSeconds" (int $w.collectSeconds) -}}
{{- if $w.maxWorkspaceSize -}}
{{- $_ := set $out "maxWorkspaceSize" (toString $w.maxWorkspaceSize) -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}

{{/*
Server env: sandbox config, the session-token private keys (the server holds all four and is the
only holder, KOBE-513) with their public bundles (rotation), the model gateway's master secret
(run and server-call token keys) and the approval HMAC key (KOBE-37). The approval key is optional so a pre-created Secret without `approval-hmac`
still starts: the server then denies every tool call that needs approval (fail closed) and logs it.
*/}}
{{- define "kobe.sandboxEnv" -}}
{{ include "kobe.sandboxConfigEnv" . }}
{{- range $env, $aud := include "kobe.sessionKeyNames" . | fromJson }}
- name: KOBE_SESSION_SIGNING_KEY_{{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" $ }}
      key: {{ $aud }}.key
{{- /* The server's own rotation bundle comes from the Secret, never the ConfigMap: a ConfigMap
  editor must not be able to add a key the server accepts (sandbox-wire, MCP /grant). Optional: the
  server always accepts its own key's public half. */}}
- name: KOBE_SESSION_VERIFY_KEY_{{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" $ }}
      key: {{ $aud }}.pub
      optional: true
{{- end }}
- name: KOBE_SESSION_KEY_MODEL_GATEWAY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: model-gateway
- name: KOBE_APPROVAL_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: approval-hmac
      optional: true
{{- end -}}

{{/*
Sandbox config alone, for the scheduler (KOBE-174): it wakes sandboxes through the provider but
holds no session-token key, run-token key or approval key (the server signs and verifies those).
*/}}
{{- define "kobe.sandboxConfigEnv" -}}
- name: KOBE_SANDBOX_CONFIG
  value: {{ include "kobe.sandboxConfig" . | quote }}
{{- end -}}
