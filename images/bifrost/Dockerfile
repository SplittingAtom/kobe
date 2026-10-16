# Not built. Dependabot tracks the Bifrost image here (it does not read Helm values); the chart's
# bifrost.image (charts/kobe/values.yaml and templates/_models.tpl defaults) must pin the same tag
# and digest — charts/kobe/tests/models.test.ts fails otherwise. When Dependabot bumps this line,
# update those two in the same PR and check the release notes and license (docs/licensing.md).
FROM docker.io/maximhq/bifrost:v2.3.0@sha256:8f37e33a8caa85faf59a875605c61d1d934738e517d8fe96e2d9fcf6f0ef9098
