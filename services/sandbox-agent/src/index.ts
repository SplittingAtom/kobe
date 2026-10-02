import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

// Scaffold only: the dial-out WSS connection and Pi RPC bridge arrive in KOBE-23.
const config = loadConfig(process.env);
logger.info({ serverUrl: config.serverUrl }, "sandbox-agent starting");
