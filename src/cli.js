#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const config = loadConfig();
  const { host, port } = await startServer(config);
  console.log(`x402-microdrip listening on ${host}:${port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
