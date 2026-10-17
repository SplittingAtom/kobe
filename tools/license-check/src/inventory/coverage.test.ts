import { describe, expect, it } from "vitest";
import {
  chartValueDrift,
  chartValueKeys,
  dockerfileImages,
  normaliseImage,
  textImages,
  uncoveredImages,
} from "./coverage.js";

describe("normaliseImage", () => {
  it.each([
    ["node:24-slim", "node"],
    ["docker.io/library/postgres:17", "postgres"],
    ["mirror.gcr.io/library/registry:3@sha256:" + "a".repeat(64), "registry"],
    ["docker.io/maximhq/bifrost:v2.2.5@sha256:" + "b".repeat(64), "maximhq/bifrost"],
    ["ghcr.io/cloudnative-pg/postgresql:17", "ghcr.io/cloudnative-pg/postgresql"],
    ["localhost:5005/kobe-web", "localhost:5005/kobe-web"],
  ])("%s → %s", (ref, repo) => {
    expect(normaliseImage(ref)).toBe(repo);
  });
});

describe("dockerfileImages", () => {
  it("resolves ARG defaults and skips build stages", () => {
    const text = [
      "ARG NODE_VERSION=24",
      'ARG PYTHON_IMAGE="python:3.12-slim@sha256:' + "c".repeat(64) + '"',
      "FROM node:${NODE_VERSION}-slim AS build",
      "FROM ${PYTHON_IMAGE} AS runas",
      "FROM build AS again",
      "FROM scratch",
      "FROM node:${NODE_VERSION}-slim",
    ].join("\n");
    expect(dockerfileImages(text, "Dockerfile").map((r) => [r.repository, r.at])).toEqual([
      ["node", "Dockerfile:3"],
      ["python", "Dockerfile:4"],
      ["node", "Dockerfile:7"],
    ]);
  });
});

describe("textImages", () => {
  it("finds literal images in YAML, templates and scripts, not variables or comments", () => {
    const text = [
      "    image: axllent/mailpit:v1.31.3",
      "    imageName: ghcr.io/cloudnative-pg/postgresql:17",
      '  "image" (dict "repository" "docker.io/maximhq/bifrost" "tag" "v2.2.5")',
      "          driver-opts: image=mirror.gcr.io/moby/buildkit:buildx-stable-1",
      "  kubectl run x --image=busybox:1.37 --command -- sh",
      'K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.34.6-k3s1}"',
      "docker run --rm busybox:1.37 cat /proc/x",
      '  "{\\"containers\\":[{\\"name\\":\\"c\\",\\"image\\":\\"busybox:1.37\\"}]}"',
      "          image: $SERVER_IMAGE",
      '          image: {{ include "kobe.image" . }}',
      "  # image: commented/out:1",
      '    ports: ["5432:5432"]',
    ].join("\n");
    expect([...new Set(textImages(text, "f").map((r) => r.repository))]).toEqual([
      "axllent/mailpit",
      "ghcr.io/cloudnative-pg/postgresql",
      "maximhq/bifrost",
      "moby/buildkit",
      "busybox",
      "rancher/k3s",
    ]);
  });

  it("ignores Kobe's own images and reports the rest without a row", () => {
    const refs = textImages(
      ["image: ghcr.io/splittingatom/kobe-server:1", "image: new/thing:2", "image: node:24"].join(
        "\n",
      ),
      "values.yaml",
    );
    expect(uncoveredImages(refs, new Set(["node"])).map((r) => [r.repository, r.at])).toEqual([
      ["new/thing", "values.yaml:2"],
    ]);
  });
});

describe("chart value keys", () => {
  it("reports unclassified and stale keys", () => {
    const keys = chartValueKeys("global: {}\nbifrost:\n  image: {}\nnewService: {}\n");
    expect(chartValueDrift(keys, { global: "first-party", bifrost: ["bifrost"], old: [] })).toEqual(
      {
        missing: ["newService"],
        stale: ["old"],
      },
    );
  });
});
