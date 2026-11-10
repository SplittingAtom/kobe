# Not built. Dependabot tracks the Bifrost image here (it does not read Helm values); the chart's
# bifrost.image (charts/kobe/values.yaml and templates/_models.tpl defaults) must pin the same tag
# and digest — charts/kobe/tests/models.test.ts fails otherwise. When Dependabot bumps this line,
# update those two in the same PR and check the release notes and license (docs/licensing.md).
FROM docker.io/maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8
