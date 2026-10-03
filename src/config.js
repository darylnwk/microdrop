import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVM = /^0x[0-9a-fA-F]{40}$/;

function configuredAddress(value, parse, label) {
  if (value === undefined || value === "") return "";
  const parsed = parse(value);
  if (!parsed) throw new Error(`${label} is invalid`);
  return parsed;
}

export function loadConfig(explicitPath) {
  const configPath = explicitPath
    ? path.resolve(explicitPath)
    : process.env.X402_CONFIG
      ? path.resolve(process.env.X402_CONFIG)
      : path.join(root, "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const maxTimeoutSeconds = raw.maxTimeoutSeconds ?? 300;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error("maxTimeoutSeconds must be an integer greater than 0");
  }
  const resourcePath = raw.resourcePath ?? "/v1/resource";
  const reserved = new Set(["/", "/app.js", "/docs", "/pricing", "/brand.css", "/mark.png", "/favicon.jpg", "/v1/register", "/v1/keys", "/v1/books", "/v1/payments"]);
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("/") || resourcePath.includes("?")) {
    throw new Error("resourcePath must be an absolute path");
  }
  if (reserved.has(resourcePath)) throw new Error("resourcePath collides with a free route");
  const portValue = process.env.PORT !== undefined && process.env.PORT !== ""
    ? process.env.PORT
    : (raw.port ?? 4020);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  const host = process.env.HOST || raw.host || "127.0.0.1";
  const publicBaseUrl = typeof raw.publicBaseUrl === "string" ? raw.publicBaseUrl.replace(/\/$/, "") : "";
  const platformBaseAddress = configuredAddress(raw.platformBaseAddress, (value) => (
    typeof value === "string" && EVM.test(value) ? value : null
  ), "platformBaseAddress");
  const ledgerPath = process.env.X402_LEDGER
    ? path.resolve(process.env.X402_LEDGER)
    : path.join(root, "data", "settlements.ndjson");
  const storePath = process.env.X402_STORE
    ? path.resolve(process.env.X402_STORE)
    : path.join(root, "data", "merchants.json");
  return {
    maxTimeoutSeconds,
    resourcePath,
    host,
    port,
    publicBaseUrl,
    platformBaseAddress,
    ledgerPath,
    storePath,
    root,
  };
}
