{{/*
Model gateway values with defaults filled in, so `helm upgrade --reuse-values` from a release that
predates these keys still renders (KOBE-40). Keep in sync with values.yaml.
*/}}
{{- define "kobe.bifrostValues" -}}
{{- $defaults := dict
  "image" (dict "repository" "docker.io/maximhq/bifrost" "tag" "v2.2.5" "digest" "sha256:65854fd1941ba8159f1f98cd69df380f6e8ac8cd374bde632c4e28f822a6f115")
  "replicas" 1
  "persistence" (dict "enabled" true "size" "1Gi" "storageClass" "")
  "keysSecret" ""
  "networkPolicy" (dict "restrictEgress" true "allowedPorts" (list 443) "extraEgress" (list))
  "resources" (dict "requests" (dict "cpu" "100m" "memory" "128Mi") "limits" (dict "cpu" "1" "memory" "512Mi")) -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.bifrost | default dict)) | toJson -}}
{{- end -}}

{{- define "kobe.modelGatewayValues" -}}
{{- $defaults := dict
  "replicas" 1
  "resources" (dict "requests" (dict "cpu" "50m" "memory" "128Mi") "limits" (dict "cpu" "1" "memory" "512Mi"))
  "limits" (dict "maxBodyBytes" 33554432 "callsPerSandbox" 16 "calls" 1024 "idleTimeoutSeconds" 300)
  "cacheTtlSeconds" 5
  "networkPolicy" (dict "restrictEgress" true "databasePeers" (list) "databasePort" 5432) -}}
{{- mustMergeOverwrite $defaults (deepCopy (.Values.modelGateway | default dict)) | toJson -}}
{{- end -}}

{{/* Secret holding the model gateway's secrets (bifrost.keysSecret, or generated and kept). */}}
{{- define "kobe.modelKeysSecretName" -}}
{{- $b := include "kobe.bifrostValues" . | fromJson -}}
{{- default (printf "%s-model-keys" (include "kobe.fullname" .)) $b.keysSecret -}}
{{- end -}}

{{/* Keys of that Secret: who gets which is in the env helpers below. */}}
{{- define "kobe.modelKeyNames" -}}
{{- toJson (list "bifrost-admin-password" "bifrost-encryption-key" "provider-keys" "virtual-keys") -}}
{{- end -}}

{{- define "kobe.bifrostUrl" -}}
{{- printf "http://%s-bifrost:8080" (include "kobe.fullname" .) -}}
{{- end -}}

{{- define "kobe.bifrostImage" -}}
{{- $b := include "kobe.bifrostValues" . | fromJson -}}
{{- if $b.image.digest -}}
{{- printf "%s:%s@%s" $b.image.repository $b.image.tag $b.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $b.image.repository $b.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "kobe.modelKeyRef" -}}
valueFrom:
  secretKeyRef:
    name: {{ include "kobe.modelKeysSecretName" .root }}
    key: {{ .key }}
{{- end -}}

{{/*
Server env (services/server/src/models/config.ts): Bifrost's admin API (it reconciles Bifrost) and
both sealing secrets. The scheduler gets none of this.
*/}}
{{- define "kobe.serverModelsEnv" -}}
- name: KOBE_BIFROST_URL
  value: {{ include "kobe.bifrostUrl" . | quote }}
- name: KOBE_BIFROST_ADMIN_USERNAME
  value: kobe
- name: KOBE_BIFROST_ADMIN_PASSWORD
  {{- include "kobe.modelKeyRef" (dict "root" . "key" "bifrost-admin-password") | nindent 2 }}
- name: KOBE_MODELS_PROVIDER_KEY_SECRET
  {{- include "kobe.modelKeyRef" (dict "root" . "key" "provider-keys") | nindent 2 }}
- name: KOBE_MODELS_VIRTUAL_KEY_SECRET
  {{- include "kobe.modelKeyRef" (dict "root" . "key" "virtual-keys") | nindent 2 }}
{{- end -}}

{{/*
Model gateway shim env (services/model-gateway/src/config.ts): the database (app role), its own
session key only, the virtual-key secret only (never provider keys or Bifrost's admin password).
*/}}
{{- define "kobe.modelGatewayEnv" -}}
{{- $g := include "kobe.modelGatewayValues" . | fromJson -}}
{{ include "kobe.databaseEnv" . }}
- name: KOBE_SESSION_KEY_MODEL_GATEWAY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.sessionKeysSecretName" . }}
      key: model-gateway
- name: KOBE_MODELS_VIRTUAL_KEY_SECRET
  {{- include "kobe.modelKeyRef" (dict "root" . "key" "virtual-keys") | nindent 2 }}
- name: KOBE_BIFROST_URL
  value: {{ include "kobe.bifrostUrl" . | quote }}
- name: KOBE_MODEL_GATEWAY_MAX_BODY_BYTES
  value: {{ int64 $g.limits.maxBodyBytes | quote }}
- name: KOBE_MODEL_GATEWAY_MAX_CALLS_PER_SANDBOX
  value: {{ int $g.limits.callsPerSandbox | quote }}
- name: KOBE_MODEL_GATEWAY_MAX_CALLS
  value: {{ int $g.limits.calls | quote }}
- name: KOBE_MODEL_GATEWAY_IDLE_TIMEOUT_MS
  value: {{ mul (int $g.limits.idleTimeoutSeconds) 1000 | quote }}
- name: KOBE_MODEL_GATEWAY_CACHE_TTL_MS
  value: {{ mul (int $g.cacheTtlSeconds) 1000 | quote }}
{{- end -}}

{{/*
Bifrost's config.json (no secrets: values come from env). Kobe owns this Bifrost: the server
pushes providers, keys, the customer/team/virtual-key hierarchy (KOBE-40). Inference requires a
virtual key; no direct provider keys from callers; no request/response logging (prompts never
stored in Bifrost); admin API behind the admin password.
*/}}
{{- define "kobe.bifrostConfig" -}}
{{- toPrettyJson (dict
  "encryption_key" "env.BIFROST_ENCRYPTION_KEY"
  "client" (dict
    "enforce_auth_on_inference" true
    "allow_direct_keys" false
    "enable_logging" false
    "disable_content_logging" true
    "allow_per_request_content_storage_override" false
    "allow_per_request_raw_override" false
    "allowed_origins" (list))
  "governance" (dict "auth_config" (dict
    "admin_username" "env.BIFROST_ADMIN_USERNAME"
    "admin_password" "env.BIFROST_ADMIN_PASSWORD"
    "is_enabled" true))
  "config_store" (dict "enabled" true "type" "sqlite" "config" (dict "path" "/app/data/config.db"))
  "logs_store" (dict "enabled" false)) -}}
{{- end -}}
