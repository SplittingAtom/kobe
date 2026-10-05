{{/* Install key-encryption key for envelope encryption (KOBE-107): the API server only. */}}
{{- define "kobe.envelopeSecretName" -}}
{{- default (printf "%s-envelope-key" (include "kobe.fullname" .)) (.Values.envelope).keySecret -}}
{{- end -}}

{{- define "kobe.envelopeEnv" -}}
- name: KOBE_ENVELOPE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.envelopeSecretName" . }}
      key: key
- name: KOBE_ENVELOPE_KEY_PREVIOUS
  valueFrom:
    secretKeyRef:
      name: {{ include "kobe.envelopeSecretName" . }}
      key: key-previous
      optional: true
{{- end -}}
