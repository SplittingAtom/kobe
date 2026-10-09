# Not built. Dependabot tracks the Bifrost image here (it does not read Helm values); the chart's
# bifrost.image (charts/kobe/values.yaml and templates/_models.tpl defaults) must pin the same tag
# and digest — charts/kobe/tests/models.test.ts fails otherwise. When Dependabot bumps this line,
# update those two in the same PR and check the release notes and license (docs/licensing.md).
FROM docker.io/maximhq/bifrost:v2.2.6@sha256:d0b4708ace1aa175766f94afa715fd9bba3a1b56c1dc2afff15a21edf3ae4e2a
