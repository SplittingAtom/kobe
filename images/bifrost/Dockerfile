# Not built. Dependabot tracks the Bifrost image here (it does not read Helm values); the chart's
# bifrost.image (charts/kobe/values.yaml and templates/_models.tpl defaults) must pin the same tag
# and digest — charts/kobe/tests/models.test.ts fails otherwise. When Dependabot bumps this line,
# update those two in the same PR and check the release notes and license (docs/licensing.md).
FROM docker.io/maximhq/bifrost:v2.3.1@sha256:fe323e244998e1a40b87be87f60d023746eae40dd69baae8f7f42728a5e16149
