import { configure } from "@testing-library/react";
import { vi } from "vitest";

// CI runs every package's tests at once (turbo, --maxWorkers=3), so a render can take several
// times longer than on an idle machine. findBy*/waitFor get 5 s instead of 1 s; one slow render
// should not fail a test. Tests that need a longer wait still pass their own timeout.
configure({ asyncUtilTimeout: 5_000 });

// next/font/local only works inside Next's compiler (KOBE-555, app/faces.ts): tests that import
// the root layout get a face whose class is its variable name (app/faces.test.ts reads the source).
vi.mock("next/font/local", () => ({
  default: (options: { readonly variable: string }) => ({
    className: options.variable,
    variable: options.variable,
    style: { fontFamily: `var(${options.variable})` },
  }),
}));
