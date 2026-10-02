{{/* Name prefix for every resource: the release name. */}}
{{- define "kobe.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/*
Name for cluster-scoped objects: unique per (namespace, release) even when truncation or dashes
would make "<release>-<namespace>" ambiguous.
*/}}
{{- define "kobe.clusterName" -}}
{{- printf "%s-%s-%s" (include "kobe.fullname" .root | trunc 30 | trimSuffix "-") (printf "%s/%s" .root.Release.Namespace .root.Release.Name | sha256sum | trunc 10) .suffix -}}
{{- end -}}

{{/* Secret holding the kobe_app password in CloudNativePG mode. */}}
{{- define "kobe.cnpgAppSecretName" -}}
{{- default (printf "%s-db-app" (include "kobe.fullname" .)) .Values.postgres.cnpg.existingAppSecret -}}
{{- end -}}

{{/*
Generated kobe_app password, computed once per render (memoized) so the Secret and the pod
checksum annotation agree. Reuses the existing Secret's value on upgrades.
*/}}
{{- define "kobe.cnpgAppPassword" -}}
{{- if not (hasKey .Values.postgres.cnpg "__password") -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "kobe.cnpgAppSecretName" .) -}}
{{- $pw := "" -}}
{{- if and $existing $existing.data (hasKey $existing.data "password") -}}
{{- $pw = index $existing.data "password" | b64dec -}}
{{- else -}}
{{- $pw = randAlphaNum 32 -}}
{{- end -}}
{{- $_ := set .Values.postgres.cnpg "__password" $pw -}}
{{- end -}}
{{- index .Values.postgres.cnpg "__password" -}}
{{- end -}}

{{/* Pod annotations that roll workloads when the generated DB password changes. */}}
{{- define "kobe.dbChecksumAnnotations" -}}
{{- if and (eq .Values.postgres.mode "cnpg") (not .Values.postgres.cnpg.existingAppSecret) -}}
checksum/db-app: {{ include "kobe.cnpgAppPassword" . | sha256sum }}
{{- end -}}
{{- end -}}

{{/* The app must never connect with the owner/migration URL. */}}
{{- define "kobe.validateDatabase" -}}
{{- $e := .Values.postgres.external -}}
{{- if and (eq .Values.postgres.mode "external") (eq $e.appUrlKey $e.migrateUrlKey) -}}
{{- fail "postgres.external.appUrlKey must differ from migrateUrlKey: the app connects as a non-owner role, never with the owner (migration) URL" -}}
{{- end -}}
{{- end -}}

{{- define "kobe.labels" -}}
app.kubernetes.io/name: kobe
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "kobe.selectorLabels" -}}
app.kubernetes.io/name: kobe
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Kobe image: <registry>/kobe-<name>:<tag or appVersion>. */}}
{{- define "kobe.image" -}}
{{- printf "%s/kobe-%s:%s" .root.Values.global.imageRegistry .name (default .root.Chart.AppVersion .root.Values.global.imageTag) -}}
{{- end -}}

{{- define "kobe.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "kobe.podSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "kobe.containerSecurityContext" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
{{- end -}}

{{/* Postgres app-role connection (never the owner). */}}
{{- define "kobe.databaseEnv" -}}
{{- $fullname := include "kobe.fullname" . -}}
{{- if eq .Values.postgres.mode "cnpg" }}
- name: KOBE_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.cnpgAppSecretName" . }}
      key: password
- name: KOBE_DATABASE_URL
  value: {{ printf "postgres://kobe_app:$(KOBE_DB_PASSWORD)@%s-pg-rw:5432/kobe" $fullname | quote }}
{{- else }}
- name: KOBE_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.external.existingSecret }}
      key: {{ .Values.postgres.external.appUrlKey }}
{{- end }}
{{- end -}}

{{/* Public origin: explicit publicUrl, else derived from the ingress host and TLS setting. */}}
{{- define "kobe.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl -}}
{{- else -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{- define "kobe.authSecretName" -}}
{{- default (printf "%s-auth" (include "kobe.fullname" .)) (.Values.auth).existingSecret -}}
{{- end -}}

{{/* Auth configuration: the API server only (the scheduler never gets these secrets). */}}
{{- define "kobe.authEnv" -}}
- name: KOBE_PUBLIC_URL
  value: {{ include "kobe.publicUrl" . | quote }}
- name: KOBE_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.authSecretName" . }}
      key: secret
- name: KOBE_SETUP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.authSecretName" . }}
      key: setup-token
- name: KOBE_TRUSTED_PROXIES
  value: {{ join "," (default (list "10.42.0.0/16") (.Values.auth).trustedProxies) | quote }}
{{- end -}}

{{/* True when Helm can reach the cluster (install/upgrade); false for offline renders. */}}
{{- define "kobe.online" -}}
{{- if lookup "v1" "Namespace" "" "kube-system" -}}true{{- end -}}
{{- end -}}

{{/*
Generated secrets are kept by looking up the existing Secret. Offline renders (helm template,
Argo CD, Flux) can't look anything up and would rotate them on every render, so they must use an
existing Secret, unless explicitly allowed for throwaway environments (dev, CI).
*/}}
{{- define "kobe.requireOnlineToGenerate" -}}
{{- if and (not (include "kobe.online" .root)) (not .root.Values.global.allowGeneratedSecretsOffline) -}}
{{- fail (printf "Cannot generate %s in an offline render (it would change on every render). Set %s to a pre-created Secret, or global.allowGeneratedSecretsOffline=true for a throwaway environment." .what .value) -}}
{{- end -}}
{{- end -}}

{{- define "kobe.s3Env" -}}
- name: KOBE_S3_ENDPOINT
  value: {{ .Values.s3.endpoint | quote }}
- name: KOBE_S3_REGION
  value: {{ .Values.s3.region | quote }}
- name: KOBE_S3_BUCKET
  value: {{ .Values.s3.bucket | quote }}
- name: KOBE_S3_FORCE_PATH_STYLE
  value: {{ .Values.s3.forcePathStyle | quote }}
- name: KOBE_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: access-key-id
- name: KOBE_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.s3.existingSecret }}
      key: secret-access-key
{{- end -}}

{{/*
Deployment + Service for a Kobe Node service.
Args: root, name (image + component), values, env (YAML list string), serviceAccount, healthPath,
extraVolumes / extraMounts (YAML list strings), preflight (isolation initContainer), migrations
(wait-for-migrations initContainer).
*/}}
{{- define "kobe.nodeService" -}}
{{- $root := .root -}}
{{- $fullname := include "kobe.fullname" $root -}}
{{- $sel := dict "root" $root "component" .component -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $fullname }}-{{ .component }}
  labels:
    {{- include "kobe.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  replicas: {{ .values.replicas }}
  selector:
    matchLabels:
      {{- include "kobe.selectorLabels" $sel | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "kobe.selectorLabels" $sel | nindent 8 }}
      {{- with .annotations }}
      annotations:
        {{- . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "kobe.imagePullSecrets" $root | nindent 6 }}
      serviceAccountName: {{ .serviceAccount | default (printf "%s-workload" $fullname) }}
      automountServiceAccountToken: {{ .automountToken | default false }}
      {{- include "kobe.podSecurityContext" $root | nindent 6 }}
      {{- if or .preflight .migrations }}
      initContainers:
        {{- if .preflight }}
        {{- include "kobe.preflightContainer" $root | nindent 8 }}
        {{- end }}
        {{- if .migrations }}
        {{- include "kobe.waitForMigrationsContainer" $root | nindent 8 }}
        {{- end }}
      {{- end }}
      containers:
        - name: {{ .component }}
          image: {{ include "kobe.image" (dict "root" $root "name" .image) }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          {{- include "kobe.containerSecurityContext" $root | nindent 10 }}
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            {{- with .env }}
            {{- . | nindent 12 }}
            {{- end }}
          readinessProbe:
            httpGet: { path: {{ .readyPath | default "/readyz" }}, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: {{ .healthPath | default "/healthz" }}, port: http }
            periodSeconds: 10
          resources:
            {{- toYaml .values.resources | nindent 12 }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- with .extraMounts }}
            {{- . | nindent 12 }}
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- with .extraVolumes }}
        {{- . | nindent 8 }}
        {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $fullname }}-{{ .component }}
  labels:
    {{- include "kobe.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
spec:
  selector:
    {{- include "kobe.selectorLabels" $sel | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
{{- end -}}


{{/* Isolation gate container: refuses to start unless the sandbox RuntimeClass isolates. */}}
{{- define "kobe.preflightContainer" -}}
- name: isolation-preflight
  image: {{ include "kobe.image" (dict "root" . "name" "server") }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  command: ["node", "dist/cli/preflight.js"]
  env:
    - name: KOBE_RUNTIME_CLASS
      value: {{ .Values.isolation.runtimeClassName | quote }}
  {{- include "kobe.containerSecurityContext" . | nindent 2 }}
  terminationMessagePolicy: FallbackToLogsOnError
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { cpu: 500m, memory: 256Mi }
{{- end -}}


{{/* Holds a pod until this build's migrations are applied; runs as the app role. */}}
{{- define "kobe.waitForMigrationsContainer" -}}
- name: wait-for-migrations
  image: {{ include "kobe.image" (dict "root" . "name" "server") }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  command: ["node", "node_modules/@kobe/db/dist/cli/wait.js"]
  env:
    {{- include "kobe.databaseEnv" . | nindent 4 }}
  {{- include "kobe.containerSecurityContext" . | nindent 2 }}
  terminationMessagePolicy: FallbackToLogsOnError
  resources:
    requests: { cpu: 20m, memory: 64Mi }
    limits: { cpu: 200m, memory: 128Mi }
{{- end -}}
