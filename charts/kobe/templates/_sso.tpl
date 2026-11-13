{{/*
Single sign-on (KOBE-626, spec docs/specs/sso-oidc-scim.md): the API server only. The providers
travel as JSON without secrets (services/server/src/sso/settings.ts); each provider's client
secret comes from the Secret its values name, as KOBE_SSO_CLIENT_SECRET_<SLUG> (slug upper-cased,
hyphens as underscores), and is never written to the database.
*/}}
{{- define "kobe.ssoValues" -}}
{{- $s := (.Values.auth).sso | default dict -}}
{{- toJson (dict
  "enabled" (ternary $s.enabled true (hasKey $s "enabled"))
  "allowedInternalCidrs" ($s.allowedInternalCidrs | default list)
  "allowedPorts" ($s.allowedPorts | default (list 443))
  "providers" ($s.providers | default list)
  "networkPolicy" ($s.networkPolicy | default dict)) -}}
{{- end -}}

{{- define "kobe.ssoEnv" -}}
{{- $s := include "kobe.ssoValues" . | fromJson -}}
{{- $providers := list -}}
{{- range $s.providers }}
{{- $providers = append $providers (omit . "clientSecretSecret") -}}
{{- end }}
- name: KOBE_SSO_ENABLED
  value: {{ $s.enabled | toString | quote }}
- name: KOBE_SSO_ALLOWED_INTERNAL_CIDRS
  value: {{ join "," $s.allowedInternalCidrs | quote }}
- name: KOBE_SSO_ALLOWED_PORTS
  value: {{ join "," $s.allowedPorts | quote }}
- name: KOBE_SSO_PROVIDERS
  value: {{ toJson $providers | quote }}
{{- range $s.providers }}
- name: {{ printf "KOBE_SSO_CLIENT_SECRET_%s" (.slug | upper | replace "-" "_") }}
  valueFrom:
    secretKeyRef:
      name: {{ required (printf "auth.sso.providers[%s].clientSecretSecret.name is required" .slug) (.clientSecretSecret).name }}
      key: {{ required (printf "auth.sso.providers[%s].clientSecretSecret.key is required" .slug) (.clientSecretSecret).key }}
{{- end }}
{{- end -}}
