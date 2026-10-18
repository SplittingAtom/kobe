import { configure } from "@testing-library/react";

// CI runs every package's tests at once (turbo, --maxWorkers=3), so a render can take several
// times longer than on an idle machine. findBy*/waitFor get 5 s instead of 1 s; one slow render
// should not fail a test. Tests that need a longer wait still pass their own timeout.
configure({ asyncUtilTimeout: 5_000 });
