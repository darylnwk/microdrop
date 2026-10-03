import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { encodeHeader, decodeHeader } from "./codec.js";
import { paymentRequired } from "./challenge.js";
import { verifyBasePayment } from "./eip3009.js";
import { meetsMinimum } from "./fee.js";
import { applySettleResult, readSettleResult, settlementLegs, settleWithPayAI } from "./facilitator.js";
import { createLedger } from "./ledger.js";
import { createMerchantStore, unsellableReason } from "./merchants.js";
import { BASE } from "./networks.js";
import { PAID_BODY } from "./resource.js";

function sendBytes(res, status, body, contentType, extraHeaders = {}) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(data.length),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function sendJson(res, status, body, extraHeaders = {}) {
  sendBytes(res, status, body, "application/json; charset=utf-8", extraHeaders);
}

function sendFile(res, config, name, contentType) {
  const file = path.join(config.root, "public", name);
  let text = fs.readFileSync(file, "utf8");
  text = text.replaceAll("{{resourcePath}}", config.resourcePath);
  sendBytes(res, 200, text, contentType);
}

function sendBinary(res, file, contentType) {
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(data.length),
    "cache-control": "no-store",
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        reject(Object.assign(new Error("body_too_large"), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sessionToken(req) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "mp_session") return decodeURIComponent(rest.join("="));
  }
  return "";
}

function apiKey(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : "";
}

function absoluteUrl(req, config, pathname) {
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${pathname}`;
  return `http://${req.headers.host}${pathname}`;
}

function resourceUrl(req, config) {
  return absoluteUrl(req, config, config.resourcePath);
}

function challengeHeader(merchant, config, url, error) {
  return encodeHeader(paymentRequired(merchant, config, url, error));
}

const ATOMIC_USDC = /^[1-9][0-9]*$/;

function paymentReceipt(entry) {
  return encodeHeader({
    success: true,
    transaction: entry.transaction,
    feeTransaction: entry.feeTransaction,
    network: entry.network,
    payer: entry.payer,
    amount: entry.amount,
  });
}

function platformReady(config) {
  return Boolean(config.platformBaseAddress);
}

function sellerView(merchant, config) {
  return {
    ...merchant,
    platformBaseAddress: config.platformBaseAddress,
  };
}

function replayReceipt(res, ledger, merchant, verdict, paidBody) {
  const prior = ledger.entry(merchant.id, verdict.nonce);
  if (!prior?.transaction) return false;
  const body = typeof paidBody === "function" ? paidBody({ network: prior.network }) : paidBody;
  sendJson(res, 200, body, { "PAYMENT-RESPONSE": paymentReceipt(prior) });
  return true;
}

async function acceptPresentedPayment(req, res, config, ledger, merchant, pricedUrl, paidBody) {
  const rawHeader = req.headers["payment-signature"];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof header !== "string" || header.trim() === "") {
    sendJson(res, 402, JSON.stringify({ error: "PAYMENT-SIGNATURE header is required" }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, "PAYMENT-SIGNATURE header is required"),
    });
    return;
  }

  let payload;
  try {
    payload = decodeHeader(header.trim());
  } catch {
    sendJson(res, 402, JSON.stringify({ error: "malformed_payment" }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, "malformed_payment"),
    });
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const settled = (nonce) => ledger.has(merchant.id, nonce);
  const seller = sellerView(merchant, config);
  const network = payload?.accepted?.network;
  let verdict;
  if (network === BASE.network) verdict = verifyBasePayment(payload, seller, nowSeconds, settled);
  else verdict = { ok: false, reason: payload?.accepted ? "network_mismatch" : "malformed_payment" };

  if (!verdict.ok) {
    if (verdict.reason === "nonce_replayed" && replayReceipt(res, ledger, merchant, verdict, paidBody)) return;
    sendJson(res, 402, JSON.stringify({ error: verdict.reason }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, verdict.reason),
    });
    return;
  }

  const described = {
    url: pricedUrl,
    description: "Metered HTTP response",
    mimeType: "application/json",
  };
  const legs = settlementLegs(payload, merchant.priceAtomic);
  let merchantSettled;
  let feeSettled;
  try {
    [merchantSettled, feeSettled] = await Promise.all([
      settleWithPayAI(legs.merchant, described),
      settleWithPayAI(legs.fee, described),
    ]);
  } catch {
    sendJson(res, 402, JSON.stringify({ error: "settle_failed" }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, "settle_failed"),
    });
    return;
  }
  console.error(`payai-settle ${merchantSettled.settled.status} ${JSON.stringify(merchantSettled.settled.body ?? merchantSettled.settled.text)}`);
  console.error(`payai-settle ${feeSettled.settled.status} ${JSON.stringify(feeSettled.settled.body ?? feeSettled.settled.text)}`);
  const feeDecision = readSettleResult(feeSettled.settled.body);
  if (!feeDecision.ok) {
    sendJson(res, 402, JSON.stringify({ error: feeDecision.reason }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, feeDecision.reason),
    });
    return;
  }

  let outcome;
  try {
    outcome = applySettleResult(ledger, {
      merchantId: merchant.id,
      nonce: verdict.nonce,
      feeNonce: verdict.feeNonce,
      amount: merchant.priceAtomic,
      payer: verdict.payer,
      network: verdict.network,
      feeTransaction: feeDecision.transaction,
    }, merchantSettled.settled.body);
  } catch {
    sendJson(res, 500, JSON.stringify({ error: "settlement_failed" }));
    return;
  }
  if (!outcome.credited) {
    if (outcome.replay && replayReceipt(res, ledger, merchant, verdict, paidBody)) return;
    const reason = outcome.reason || "settle_failed";
    sendJson(res, 402, JSON.stringify({ error: reason }), {
      "PAYMENT-REQUIRED": challengeHeader(merchant, config, pricedUrl, reason),
    });
    return;
  }

  const body = typeof paidBody === "function" ? paidBody(verdict) : paidBody;
  sendJson(res, 200, body, {
    "PAYMENT-RESPONSE": paymentReceipt({
      transaction: outcome.transaction,
      feeTransaction: outcome.feeTransaction,
      network: verdict.network,
      payer: verdict.payer,
      amount: outcome.amount,
    }),
  });
}

async function route(req, res, config, ledger, merchants) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/") {
    req.resume();
    sendFile(res, config, "index.html", "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    req.resume();
    sendFile(res, config, "app.js", "text/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/docs") {
    req.resume();
    sendFile(res, config, "docs.html", "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/pricing") {
    req.resume();
    sendFile(res, config, "pricing.html", "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && url.pathname === "/brand.css") {
    req.resume();
    sendFile(res, config, "brand.css", "text/css; charset=utf-8");
    return;
  }
  if (req.method === "GET" && (url.pathname === "/mark.png" || url.pathname === "/favicon.jpg")) {
    req.resume();
    const name = url.pathname.slice(1);
    sendBinary(res, path.join(config.root, "site", name), name.endsWith(".png") ? "image/png" : "image/jpeg");
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/register") {
    const input = await readJson(req);
    const result = merchants.register(input);
    if (result.error) {
      sendJson(res, 400, JSON.stringify({ error: result.error }));
      return;
    }
    sendJson(res, 201, JSON.stringify({ id: result.user.id }), {
      "set-cookie": `mp_session=${result.user.session}; HttpOnly; Path=/; SameSite=Lax`,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/keys") {
    req.resume();
    const result = merchants.createKey(sessionToken(req));
    if (result.error) {
      sendJson(res, 401, JSON.stringify({ error: result.error }));
      return;
    }
    sendJson(res, 201, JSON.stringify({ apiKey: result.apiKey }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/books") {
    req.resume();
    const merchant = merchants.byKey(apiKey(req));
    if (!merchant) {
      sendJson(res, 401, JSON.stringify({ error: apiKey(req) ? "unknown_api_key" : "api_key_required" }));
      return;
    }
    sendJson(res, 200, JSON.stringify(ledger.snapshot(merchant)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/payments") {
    const input = await readJson(req);
    const sender = merchants.byKey(apiKey(req));
    if (!sender) {
      sendJson(res, 401, JSON.stringify({ error: apiKey(req) ? "unknown_api_key" : "api_key_required" }));
      return;
    }
    const recipientId = typeof input.recipient === "string" ? input.recipient.trim() : "";
    const recipient = merchants.byId(recipientId);
    if (!recipient) {
      sendJson(res, recipientId ? 404 : 400, JSON.stringify({
        error: recipientId ? "recipient_unknown" : "recipient_required",
      }));
      return;
    }
    if (recipient.id === sender.id) {
      sendJson(res, 400, JSON.stringify({ error: "recipient_is_sender" }));
      return;
    }
    const amount = typeof input.amount === "string" ? input.amount.trim() : "";
    if (!ATOMIC_USDC.test(amount)) {
      sendJson(res, 400, JSON.stringify({ error: "amount_invalid" }));
      return;
    }
    if (!meetsMinimum(amount)) {
      sendJson(res, 400, JSON.stringify({ error: "amount_below_minimum" }));
      return;
    }
    if (!platformReady(config)) {
      sendJson(res, 503, JSON.stringify({ error: "platform_unconfigured" }));
      return;
    }
    const payee = {
      id: recipient.id,
      baseAddress: recipient.baseAddress,
      priceAtomic: amount,
    };
    await acceptPresentedPayment(
      req,
      res,
      config,
      ledger,
      payee,
      absoluteUrl(req, config, "/v1/payments"),
      (verdict) => JSON.stringify({
        settled: true,
        amount,
        network: verdict.network,
        recipient: recipient.id,
      }),
    );
    return;
  }
  if (url.pathname !== config.resourcePath) {
    req.resume();
    sendJson(res, 404, JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    req.resume();
    sendJson(res, 405, JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  req.resume();

  const merchant = merchants.byKey(apiKey(req));
  if (!merchant) {
    sendJson(res, 401, JSON.stringify({ error: apiKey(req) ? "unknown_api_key" : "api_key_required" }));
    return;
  }
  const blocked = unsellableReason(merchant);
  if (blocked) {
    sendJson(res, 503, JSON.stringify({ error: blocked }));
    return;
  }
  if (!platformReady(config)) {
    sendJson(res, 503, JSON.stringify({ error: "platform_unconfigured" }));
    return;
  }

  await acceptPresentedPayment(req, res, config, ledger, merchant, resourceUrl(req, config), PAID_BODY);
}

export function createHandler(config, ledger, merchants) {
  return function handler(req, res) {
    route(req, res, config, ledger, merchants).catch((error) => {
      if (res.headersSent) return;
      const status = error && error.status ? error.status : 500;
      sendJson(res, status, JSON.stringify({ error: status === 500 ? "server_error" : error.message }));
    });
  };
}

export function startServer(config, deps = {}) {
  const ledger = deps.ledger ?? createLedger(config.ledgerPath);
  const merchants = deps.merchants ?? createMerchantStore(config.storePath);
  const server = http.createServer(createHandler(config, ledger, merchants));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      resolve({
        server,
        ledger,
        merchants,
        host: config.host,
        port: typeof address === "object" && address ? address.port : config.port,
      });
    });
  });
}
