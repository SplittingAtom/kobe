{{/* Name prefix for every resource: the release name. */}}
{{- define "kobe.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
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
      name: {{ $fullname }}-db-app
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
extraVolumes / extraMounts (YAML list strings).
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
    spec:
      {{- include "kobe.imagePullSecrets" $root | nindent 6 }}
      serviceAccountName: {{ .serviceAccount | default (printf "%s-workload" $fullname) }}
      automountServiceAccountToken: {{ .automountToken | default false }}
      {{- include "kobe.podSecurityContext" $root | nindent 6 }}
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
