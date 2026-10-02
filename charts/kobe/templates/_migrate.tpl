{{- define "kobe.migrateJob" -}}
{{- $root := .root -}}
{{- $fullname := include "kobe.fullname" $root -}}
{{- $cnpg := eq $root.Values.postgres.mode "cnpg" }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .name }}
  labels:
    {{- include "kobe.labels" $root | nindent 4 }}
  {{- with .hook }}
  annotations:
    helm.sh/hook: {{ . }}
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
  {{- end }}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 900
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kobe
        app.kubernetes.io/component: migrate
    spec:
      restartPolicy: Never
      {{- include "kobe.imagePullSecrets" $root | nindent 6 }}
      serviceAccountName: {{ $fullname }}-workload
      automountServiceAccountToken: false
      {{- include "kobe.podSecurityContext" $root | nindent 6 }}
      containers:
        - name: migrate
          image: {{ include "kobe.image" (dict "root" $root "name" "server") }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          command: ["node", "node_modules/@kobe/db/dist/cli/migrate.js"]
          env:
            - name: KOBE_DB_MIGRATE_URL
              valueFrom:
                secretKeyRef:
                  {{- if $cnpg }}
                  name: {{ $fullname }}-pg-app
                  key: uri
                  {{- else }}
                  name: {{ $root.Values.postgres.external.existingSecret }}
                  key: {{ $root.Values.postgres.external.migrateUrlKey }}
                  {{- end }}
            - name: KOBE_DB_APP_ROLE
              value: {{ ternary "kobe_app" (default "kobe_app" $root.Values.postgres.external.appRole) $cnpg | quote }}
          {{- include "kobe.containerSecurityContext" $root | nindent 10 }}
          terminationMessagePolicy: FallbackToLogsOnError
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: "1", memory: 512Mi }
{{- end -}}
