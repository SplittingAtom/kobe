# Not built. Dependabot tracks the Bifrost image here (it does not read Helm values); the chart's
# bifrost.image (charts/kobe/values.yaml and templates/_models.tpl defaults) must pin the same tag
# and digest — charts/kobe/tests/models.test.ts fails otherwise. When Dependabot bumps this line,
# update those two in the same PR and check the release notes and license (docs/licensing.md).
FROM docker.io/maximhq/bifrost:v2.2.5@sha256:65854fd1941ba8159f1f98cd69df380f6e8ac8cd374bde632c4e28f822a6f115
