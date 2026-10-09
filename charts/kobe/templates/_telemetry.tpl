{{/*
OpenTelemetry tracing (KOBE-10, spec D31) for the server, scheduler, MCP proxy, egress proxy and
model gateway. Nothing is set without `telemetry.endpoint`, which keeps tracing off. Spans carry
metadata only unless `telemetry.captureContent` is true (an install-level opt-in). Written with
`default dict` so `helm upgrade --reuse-values` from an older release still renders.
*/}}
{{- define "kobe.telemetryEnv" -}}
{{- $t := .Values.telemetry | default dict -}}
{{- if $t.endpoint }}
- name: KOBE_OTEL_ENDPOINT
  value: {{ $t.endpoint | quote }}
- name: KOBE_OTEL_CAPTURE_CONTENT
  value: {{ ternary "true" "false" (eq (toString $t.captureContent) "true") | quote }}
{{- if $t.headersSecret }}
- name: KOBE_OTEL_HEADERS
  valueFrom:
    secretKeyRef:
      name: {{ $t.headersSecret | quote }}
      key: headers
{{- end }}
{{- end }}
{{- end -}}
