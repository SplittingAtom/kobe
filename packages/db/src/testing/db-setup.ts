import { attachPoolErrorLogger } from "../test-support/pool-errors.js";

// KOBE-507: an idle pool client terminated by the server is logged, never an unhandled error.
attachPoolErrorLogger();
