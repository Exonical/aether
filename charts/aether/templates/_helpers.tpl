{{- define "aether.name" -}}
{{- default (printf "%s-aether" .Release.Name) .Values.fullnameOverride | trunc 54 | trimSuffix "-" -}}
{{- end -}}
{{- define "aether.selector" -}}
app.kubernetes.io/name: aether
app.kubernetes.io/instance: {{ include "aether.name" . | quote }}
{{- end -}}
{{- define "aether.labels" -}}
{{ include "aether.selector" . }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "aether.image" -}}
{{- if .digest -}}
{{ printf "%s@%s" .repository .digest }}
{{- else -}}
{{ printf "%s:%s" .repository .tag }}
{{- end -}}
{{- end -}}
{{- define "aether.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
