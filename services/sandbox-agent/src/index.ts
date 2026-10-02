import { loadConfig } from "./config.js";

// Scaffold only: the dial-out WSS connection and Pi RPC bridge arrive in KOBE-23.
const config = loadConfig(process.env);
console.log(JSON.stringify({ msg: "sandbox-agent starting", serverUrl: config.serverUrl }));
