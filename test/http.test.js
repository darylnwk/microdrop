import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { Wallet, hexlify, randomBytes, verifyTypedData } from "ethers";
import { loadConfig } from "../src/config.js";
import { verifyBasePayment } from "../src/eip3009.js";
import { applySettleResult } from "../src/facilitator.js";
import { createLedger } from "../src/ledger.js";
import { PAID_BODY } from "../src/resource.js";
import { requireChrome } from "./chrome.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(root, "config.json");
const scratch = process.env.X402_SCRATCH || "";


const BASE_NETWORK = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function tempDir() {
  const base = scratch || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "microdrip-"));
}

const platformBase = Wallet.createRandom();
const platformConfigPath = (() => {
  const raw = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));
  raw.platformBaseAddress = platformBase.address;
  const file = path.join(tempDir(), "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
})();

function quoteParts(priceAtomic) {
  const price = BigInt(priceAtomic);
  const fee = (price * 5n) / 100n;
  return { price, fee, quoted: price + fee };
}

function writeLog(name, text) {
  if (!scratch) return;
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, name), text);
}

function start(configPath = platformConfigPath) {
  const dir = tempDir();
  const ledgerPath = path.join(dir, "settlements.ndjson");
  const storePath = path.join(dir, "merchants.json");
  const child = spawn(process.execPath, [path.join(root, "src/cli.js")], {
    cwd: root,
    env: {
      ...process.env,
      X402_CONFIG: configPath,
      X402_LEDGER: ledgerPath,
      X402_STORE: storePath,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(`server did not listen\nstdout:${out}\nstderr:${err}`);
      writeLog("start-error.log", error.stack);
      reject(error);
    }, 20000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        writeLog("start-error.log", `${error.stack ?? error}\nstdout:${out}\nstderr:${err}`);
        reject(error);
      } else {
        resolve(value);
      }
    };
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/x402-microdrip listening on (.+):(\d+)/);
      if (!match) return;
      finish(null, {
        host: match[1],
        port: Number(match[2]),
        origin: `http://127.0.0.1:${match[2]}`,
        ledgerPath,
        storePath,
        stderr() {
          return err;
        },
        async stop() {
          if (child.exitCode != null || child.signalCode != null) return;
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
          await once(child, "exit");
          clearTimeout(killTimer);
        },
      });
    });
    child.once("exit", (code, signal) => {
      finish(new Error(`server exited ${code ?? signal}\nstdout:${out}\nstderr:${err}`));
    });
  });
}

function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function domainFrom(accept) {
  return {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: Number(String(accept.network).split(":")[1]),
    verifyingContract: accept.asset,
  };
}

function authorizationWire(authorization) {
  return {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };
}

function freshAuthorization(from, accept, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    from,
    to: accept.payTo,
    value: BigInt(accept.amount),
    validAfter: 0n,
    validBefore: BigInt(now + 600),
    nonce: hexlify(randomBytes(32)),
    ...overrides,
  };
}

function bearer(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

async function register(origin, fields) {
  const response = await fetch(`${origin}/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /mp_session=([^;]+)/.exec(setCookie);
  assert.ok(match, setCookie);
  assert.equal(typeof payload.id, "string");
  assert.ok(payload.id.length > 0);
  return { id: payload.id, cookie: `mp_session=${match[1]}` };
}

async function createKey(origin, cookie) {
  const response = await fetch(`${origin}/v1/keys`, {
    method: "POST",
    headers: { cookie },
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.match(payload.apiKey, /^mp_[0-9a-f]{64}$/);
  return payload.apiKey;
}

async function books(origin, apiKey) {
  const response = await fetch(`${origin}/v1/books`, { headers: bearer(apiKey) });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

function resourcePathFrom(html) {
  assert.match(html, /Authorization:\s*Bearer/);
  const match = /<code>GET\s+([^<]+)<\/code>/.exec(html);
  assert.ok(match, html);
  return match[1].trim();
}

async function merchant() {
  const base = Wallet.createRandom();
  return {
    baseAddress: base.address,
    buyer: Wallet.createRandom(),
  };
}

function acceptFor(required, network) {
  const found = required.accepts.filter((entry) => entry.network === network);
  assert.equal(found.length, 1);
  return found[0];
}

function assertChallenge(required, merchantFields, priceAtomic) {
  assert.equal(required.x402Version, 2);
  assert.equal(required.accepts.length, 1);
  const base = acceptFor(required, BASE_NETWORK);
  assert.equal(base.scheme, "exact");
  assert.equal(base.amount, quoteParts(priceAtomic).quoted.toString());
  assert.equal(typeof base.maxTimeoutSeconds, "number");
  assert.ok(base.maxTimeoutSeconds > 0);
  assert.equal(base.asset.toLowerCase(), BASE_USDC.toLowerCase());
  assert.equal(base.payTo, merchantFields.baseAddress);
  assert.equal(base.extra.name, "USD Coin");
  assert.equal(base.extra.version, "2");
  const quoted = quoteParts(priceAtomic);
  assert.equal(base.extra.feeAmount, quoted.fee.toString());
  assert.equal(base.extra.feePayTo, platformBase.address);
  assert.equal(domainFrom(base).chainId, 8453);
  return { base };
}

async function signBase(accept, wallet, overrides = {}, accepted = accept) {
  const fee = BigInt(accept.extra.feeAmount);
  const payeeValue = BigInt(accept.amount) - fee;
  const authorization = freshAuthorization(wallet.address, accept, { value: payeeValue, ...overrides });
  const signature = await wallet.signTypedData(domainFrom(accept), TRANSFER_TYPES, authorization);
  const feeAuthorization = freshAuthorization(wallet.address, accept, {
    to: accept.extra.feePayTo,
    value: fee,
  });
  const feeSignature = await wallet.signTypedData(domainFrom(accept), TRANSFER_TYPES, feeAuthorization);
  const header = encodeHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature,
      authorization: authorizationWire(authorization),
      feeSignature,
      feeAuthorization: authorizationWire(feeAuthorization),
    },
  });
  const decoded = decodeHeader(header);
  assert.equal(decoded.payload.feeAuthorization.to, accept.extra.feePayTo);
  assert.equal(decoded.payload.feeAuthorization.value, fee.toString());
  return { authorization, signature, feeAuthorization, feeSignature, header };
}

async function requestResource(origin, resourcePath, apiKey, payment) {
  const headers = apiKey ? bearer(apiKey) : {};
  if (payment) headers["payment-signature"] = payment;
  const response = await fetch(`${origin}${resourcePath}`, { headers });
  const body = await response.text();
  return { response, body, status: response.status };
}

function assertNotSold(result) {
  assert.notEqual(result.status, 200);
  assert.notEqual(result.body, PAID_BODY);
  assert.equal(result.body.includes('"delivered":true'), false);
  assert.equal(result.body.includes('"settled":true'), false);
  const receipt = result.response.headers.get("payment-response");
  if (receipt) {
    const decoded = decodeHeader(receipt);
    assert.notEqual(decoded.success, true);
    assert.notEqual(decoded.transaction, "");
  }
}

async function settleLines(stderr, from = 0) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return stderr.slice(from).split("\n").filter((line) => line.startsWith("payai-settle "));
}

function assertPresented(result) {
  const reason = JSON.parse(result.body).error;
  assert.notEqual(reason, "fee_required", result.body);
  assert.notEqual(reason, "amount_mismatch", result.body);
}

function recordSettles(label, lines) {
  assert.equal(lines.length, 2, `${label} did not settle the payee and the platform fee\n${lines.join("\n")}`);
  const recorded = [];
  for (const line of lines) {
    const match = /^payai-settle (\d+) (.*)$/.exec(line);
    assert.ok(match, line);
    const status = Number(match[1]);
    assert.ok(status >= 100, line);
    const body = JSON.parse(match[2]);
    const transaction = typeof body.transaction === "string" ? body.transaction.trim() : "";
    const landed = body.success === true && transaction !== "";
    assert.equal(landed, false, line);
    recorded.push(`status: ${status}\nbody: ${match[2]}`);
  }
  if (scratch) fs.appendFileSync(path.join(scratch, "payai-settle.log"), `${label}\n${recorded.join("\n")}\n\n`);
  return recorded;
}

test("registered merchants sell USDC on Base", async (t) => {
  const config = loadConfig(defaultConfigPath);
  assert.equal(config.resourcePath, "/v1/resource");
  const server = await start();
  t.after(() => server.stop());
  const html = await fetch(`${server.origin}/`).then((response) => response.text());
  const resourcePath = resourcePathFrom(html);
  assert.equal(resourcePath, config.resourcePath);

  const priceA = "100000";
  const costA = "1000";
  const priceB = "250000";
  const costB = "2000";
  const fieldsA = await merchant();
  const fieldsB = await merchant();
  const registeredA = await register(server.origin, {
    baseAddress: fieldsA.baseAddress,
    priceAtomic: priceA,
    costAtomic: costA,
  });
  const registeredB = await register(server.origin, {
    baseAddress: fieldsB.baseAddress,
    priceAtomic: priceB,
    costAtomic: costB,
  });
  const keyA = await createKey(server.origin, registeredA.cookie);
  const keyB = await createKey(server.origin, registeredB.cookie);
  assert.notEqual(keyA, keyB);

  const missing = await requestResource(server.origin, resourcePath, "");
  assert.equal(missing.status, 401);
  assert.equal(missing.response.headers.get("payment-required"), null);
  assertNotSold(missing);

  const unknown = await requestResource(server.origin, resourcePath, `mp_${"ab".repeat(32)}`);
  assert.equal(unknown.status, 401);
  assert.equal(unknown.response.headers.get("payment-required"), null);
  assertNotSold(unknown);

  const unpaidA = await requestResource(server.origin, resourcePath, keyA);
  assert.equal(unpaidA.status, 402);
  assert.notEqual(unpaidA.body, PAID_BODY);
  assert.ok(PAID_BODY.length > 0);
  const requiredA = decodeHeader(unpaidA.response.headers.get("payment-required"));
  assert.equal(requiredA.resource.url, `${server.origin}${resourcePath}`);
  const acceptsA = assertChallenge(requiredA, fieldsA, priceA);

  const unpaidB = await requestResource(server.origin, resourcePath, keyB);
  const requiredB = decodeHeader(unpaidB.response.headers.get("payment-required"));
  const acceptsB = assertChallenge(requiredB, fieldsB, priceB);
  assert.notEqual(acceptsA.base.payTo, acceptsB.base.payTo);
  assert.equal(acceptsA.base.amount, "105000");

  const oddWho = await merchant();
  const oddPrice = "100001";
  const oddRegistered = await register(server.origin, {
    baseAddress: oddWho.baseAddress,
    priceAtomic: oddPrice,
    costAtomic: "1000",
  });
  const oddKey = await createKey(server.origin, oddRegistered.cookie);
  const oddUnpaid = await requestResource(server.origin, resourcePath, oddKey);
  assert.equal(oddUnpaid.status, 402);
  const oddRequired = decodeHeader(oddUnpaid.response.headers.get("payment-required"));
  const oddAccepts = assertChallenge(oddRequired, oddWho, oddPrice);
  assert.equal(oddAccepts.base.amount, "105001");

  const opened = await books(server.origin, keyA);
  assert.equal(opened.creditedAtomic, "0");
  assert.equal(opened.feeAtomic, "0");
  assert.equal(opened.settledCount, 0);
  assert.equal(opened.priceAtomic, priceA);
  assert.equal(opened.costAtomic, costA);
  const openedB = await books(server.origin, keyB);
  assert.equal(openedB.creditedAtomic, "0");
  assert.equal(openedB.feeAtomic, "0");
  assert.equal(openedB.settledCount, 0);

  async function rejected(apiKey, before, build) {
    const result = await build();
    assertNotSold(result);
    const after = await books(server.origin, apiKey);
    assert.equal(after.creditedAtomic, before.creditedAtomic);
    assert.equal(after.feeAtomic, before.feeAtomic);
    assert.equal(after.settledCount, before.settledCount);
    const challenge = result.response.headers.get("payment-required");
    assert.ok(challenge);
    const decoded = decodeHeader(challenge);
    assert.equal(decoded.x402Version, 2);
    assert.equal(decoded.accepts.length, 1);
    return result;
  }

  const zero = { creditedAtomic: "0", feeAtomic: "0", settledCount: 0 };
  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer);
    const other = Wallet.createRandom();
    const forged = await other.signTypedData(domainFrom(acceptsA.base), TRANSFER_TYPES, signed.authorization);
    assert.notEqual(forged, signed.signature);
    const header = encodeHeader({
      x402Version: 2,
      accepted: acceptsA.base,
      payload: { signature: forged, authorization: authorizationWire(signed.authorization) },
    });
    return requestResource(server.origin, resourcePath, keyA, header);
  });

  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer, { value: BigInt(priceA) - 1n });
    return requestResource(server.origin, resourcePath, keyA, signed.header);
  });

  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer, {
      to: "0x0000000000000000000000000000000000000001",
    });
    return requestResource(server.origin, resourcePath, keyA, signed.header);
  });

  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer, {
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) - 30),
    });
    return requestResource(server.origin, resourcePath, keyA, signed.header);
  });

  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer, {}, {
      ...acceptsA.base,
      asset: "0x0000000000000000000000000000000000000002",
    });
    return requestResource(server.origin, resourcePath, keyA, signed.header);
  });

  await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer, {}, {
      ...acceptsA.base,
      network: "eip155:1",
    });
    return requestResource(server.origin, resourcePath, keyA, signed.header);
  });

  const missingFee = await rejected(keyA, zero, async () => {
    const signed = await signBase(acceptsA.base, fieldsA.buyer);
    const header = encodeHeader({
      x402Version: 2,
      accepted: acceptsA.base,
      payload: {
        signature: signed.signature,
        authorization: authorizationWire(signed.authorization),
      },
    });
    return requestResource(server.origin, resourcePath, keyA, header);
  });
  assert.equal(JSON.parse(missingFee.body).error, "fee_required");

  assert.equal(server.stderr().includes("payai-settle"), false);

  async function unsettled(label, run) {
    const mark = server.stderr().length;
    const result = await run();
    if (label) {
      assertPresented(result);
      recordSettles(label, await settleLines(server.stderr(), mark));
    }
    assertNotSold(result);
    assert.equal((await books(server.origin, keyA)).creditedAtomic, "0");
    assert.equal((await books(server.origin, keyA)).feeAtomic, "0");
    assert.equal((await books(server.origin, keyA)).settledCount, 0);
    assert.equal((await books(server.origin, keyB)).creditedAtomic, "0");
    assert.equal((await books(server.origin, keyB)).feeAtomic, "0");
    assert.equal((await books(server.origin, keyB)).settledCount, 0);
    return result;
  }

  const basePaid = await signBase(acceptsA.base, fieldsA.buyer);
  assert.equal(basePaid.authorization.value, BigInt(acceptsA.base.amount) - BigInt(acceptsA.base.extra.feeAmount));
  assert.equal(basePaid.authorization.to, acceptsA.base.payTo);
  assert.equal(basePaid.feeAuthorization.to, platformBase.address);
  assert.equal(basePaid.feeAuthorization.value, BigInt(acceptsA.base.extra.feeAmount));
  const recovered = verifyTypedData(
    domainFrom(acceptsA.base),
    TRANSFER_TYPES,
    basePaid.authorization,
    basePaid.signature,
  );
  assert.equal(recovered.toLowerCase(), fieldsA.buyer.address.toLowerCase());
  const baseResult = await unsettled("resource-base", () => requestResource(server.origin, resourcePath, keyA, basePaid.header));
  assert.notEqual(baseResult.body, PAID_BODY);

  await unsettled("", () => requestResource(server.origin, resourcePath, keyA, basePaid.header));

  const overBase = await signBase(acceptsA.base, fieldsA.buyer, { value: quoteParts(priceA).quoted + 50n });
  const overMark = server.stderr().length;
  const overResult = await requestResource(server.origin, resourcePath, keyA, overBase.header);
  assert.equal(JSON.parse(overResult.body).error, "amount_mismatch");
  assert.equal((await settleLines(server.stderr(), overMark)).length, 0);
  assertNotSold(overResult);

  const crossedBase = await signBase(acceptsA.base, fieldsA.buyer);
  const crossedMark = server.stderr().length;
  const crossedBaseResult = await requestResource(server.origin, resourcePath, keyB, crossedBase.header);
  assertNotSold(crossedBaseResult);
  assert.equal((await settleLines(server.stderr(), crossedMark)).length, 0);
  assert.equal((await books(server.origin, keyA)).creditedAtomic, "0");
  assert.equal((await books(server.origin, keyB)).creditedAtomic, "0");

  const paidB = await signBase(acceptsB.base, fieldsB.buyer);
  await unsettled("", () => requestResource(server.origin, resourcePath, keyB, paidB.header));

  const postPaid = await signBase(acceptsA.base, fieldsA.buyer);
  await unsettled("", async () => {
    const postResult = await fetch(`${server.origin}${resourcePath}`, {
      method: "POST",
      headers: { ...bearer(keyA), "payment-signature": postPaid.header },
    });
    return { response: postResult, body: await postResult.text(), status: postResult.status };
  });

  console.log("A locally valid signature is submitted to PayAI /settle and does not credit the payee unless PayAI confirms an on-chain transaction.");
});

test("a price that is not above cost never sells", async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const html = await fetch(`${server.origin}/`).then((response) => response.text());
  const resourcePath = resourcePathFrom(html);
  const cases = [
    { priceAtomic: "1000", costAtomic: "1000", error: "price_not_above_cost" },
    { priceAtomic: "1", costAtomic: "2", error: "price_not_above_cost" },
    { priceAtomic: "99999", costAtomic: "1", error: "amount_below_minimum" },
  ];
  for (const fields of cases) {
    const who = await merchant();
    const registered = await register(server.origin, {
      baseAddress: who.baseAddress,
      priceAtomic: fields.priceAtomic,
      costAtomic: fields.costAtomic,
    });
    const apiKey = await createKey(server.origin, registered.cookie);
    const unpaid = await requestResource(server.origin, resourcePath, apiKey);
    assert.equal(unpaid.status, 503);
    assert.equal(unpaid.response.headers.get("payment-required"), null);
    assertNotSold(unpaid);
    assert.equal(JSON.parse(unpaid.body).error, fields.error);

    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: who.buyer.address,
      to: who.baseAddress,
      value: BigInt(fields.priceAtomic),
      validAfter: 0n,
      validBefore: BigInt(now + 600),
      nonce: hexlify(randomBytes(32)),
    };
    const signature = await who.buyer.signTypedData({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: BASE_USDC,
    }, TRANSFER_TYPES, authorization);
    const header = encodeHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: BASE_NETWORK,
        amount: fields.priceAtomic,
        asset: BASE_USDC,
        payTo: who.baseAddress,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      payload: { signature, authorization: authorizationWire(authorization) },
    });
    const paid = await requestResource(server.origin, resourcePath, apiKey, header);
    assert.equal(paid.status, 503);
    assert.equal(paid.response.headers.get("payment-required"), null);
    assertNotSold(paid);
    assert.equal(JSON.parse(paid.body).error, fields.error);
    const account = await books(server.origin, apiKey);
    assert.equal(account.creditedAtomic, "0");
    assert.equal(account.feeAtomic, "0");
    assert.equal(account.settledCount, 0);
  }
  assert.equal(server.stderr().includes("payai-settle"), false);
});

test("a settled nonce is rejected after the process restarts", async (t) => {
  const dir = tempDir();
  const ledgerPath = path.join(dir, "settlements.ndjson");
  const storePath = path.join(dir, "merchants.json");
  async function boot() {
    const child = spawn(process.execPath, [path.join(root, "src/cli.js")], {
      cwd: root,
      env: {
        ...process.env,
        X402_CONFIG: platformConfigPath,
        X402_LEDGER: ledgerPath,
        X402_STORE: storePath,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const server = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`server did not listen\n${out}\n${err}`));
      }, 20000);
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const match = out.match(/x402-microdrip listening on (.+):(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve({
          origin: `http://127.0.0.1:${match[2]}`,
          stderr() {
            return err;
          },
          async stop() {
            if (child.exitCode != null || child.signalCode != null) return;
            child.kill("SIGTERM");
            await once(child, "exit");
          },
        });
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code ?? signal}\n${out}\n${err}`));
      });
    });
    return server;
  }

  const first = await boot();
  t.after(() => first.stop());
  const html = await fetch(`${first.origin}/`).then((response) => response.text());
  const resourcePath = resourcePathFrom(html);
  const who = await merchant();
  const registered = await register(first.origin, {
    baseAddress: who.baseAddress,
    priceAtomic: "100000",
    costAtomic: "1000",
  });
  const apiKey = await createKey(first.origin, registered.cookie);
  const unpaid = await requestResource(first.origin, resourcePath, apiKey);
  const required = decodeHeader(unpaid.response.headers.get("payment-required"));
  const signed = await signBase(acceptFor(required, BASE_NETWORK), who.buyer);
  const paidMark = first.stderr().length;
  const paid = await requestResource(first.origin, resourcePath, apiKey, signed.header);
  recordSettles("resource-base-replay", await settleLines(first.stderr(), paidMark));
  assertPresented(paid);
  assertNotSold(paid);
  assert.equal((await books(first.origin, apiKey)).creditedAtomic, "0");
  assert.equal((await books(first.origin, apiKey)).feeAtomic, "0");
  assert.equal((await books(first.origin, apiKey)).settledCount, 0);
  await first.stop();

  const price = 100000n;
  const fee = (price * 5n) / 100n;
  const quoted = price + fee;
  const payload = decodeHeader(signed.header);
  const verdict = verifyBasePayment(payload, {
    id: registered.id,
    baseAddress: who.baseAddress,
    priceAtomic: price.toString(),
    platformBaseAddress: platformBase.address,
  }, Math.floor(Date.now() / 1000), () => false);
  assert.equal(verdict.ok, true);
  assert.equal(payload.payload.authorization.value, price.toString());
  assert.equal(payload.payload.authorization.to, who.baseAddress);
  assert.equal(payload.payload.feeAuthorization.value, fee.toString());
  assert.equal(payload.payload.feeAuthorization.to, platformBase.address);
  const transaction = hexlify(randomBytes(32));
  const feeTransaction = hexlify(randomBytes(32));
  const recorded = applySettleResult(createLedger(ledgerPath), {
    merchantId: registered.id,
    nonce: verdict.nonce,
    feeNonce: verdict.feeNonce,
    amount: price.toString(),
    payer: verdict.payer,
    network: verdict.network,
    feeTransaction,
  }, {
    success: true,
    transaction,
    network: verdict.network,
    payer: verdict.payer,
  });
  assert.equal(recorded.credited, true);
  assert.equal(recorded.transaction, transaction);
  assert.equal(recorded.feeTransaction, feeTransaction);
  assert.equal(recorded.amount, quoted.toString());

  const second = await boot();
  t.after(() => second.stop());
  const before = await books(second.origin, apiKey);
  assert.equal(before.settledCount, 1);
  assert.equal(before.creditedAtomic, price.toString());
  assert.equal(before.feeAtomic, fee.toString());
  assert.equal(BigInt(before.creditedAtomic) + BigInt(before.feeAtomic), quoted);
  const replay = await requestResource(second.origin, resourcePath, apiKey, signed.header);
  assert.equal(replay.status, 200);
  assert.equal(replay.body, PAID_BODY);
  const receipt = decodeHeader(replay.response.headers.get("payment-response"));
  assert.equal(receipt.success, true);
  assert.equal(receipt.transaction, transaction);
  assert.equal(receipt.network, BASE_NETWORK);
  assert.equal(receipt.amount, quoted.toString());
  assert.equal(receipt.feeTransaction, feeTransaction);
  assert.equal((await settleLines(second.stderr())).length, 0);
  const account = await books(second.origin, apiKey);
  assert.equal(account.settledCount, 1);
  assert.equal(account.creditedAtomic, price.toString());
  assert.equal(account.feeAtomic, fee.toString());
  assert.equal(BigInt(account.creditedAtomic) + BigInt(account.feeAtomic), quoted);
  assert.ok(price > 1000n);
});

test("two cold processes advertise Base and one can be paid", async (t) => {
  const config = loadConfig(defaultConfigPath);

  async function probe(logName) {
    const server = await start();
    const html = await fetch(`${server.origin}/`).then((response) => response.text());
    const resourcePath = resourcePathFrom(html);
    const who = await merchant();
    const priceAtomic = "100000";
    const registered = await register(server.origin, {
      baseAddress: who.baseAddress,
      priceAtomic,
      costAtomic: "1000",
    });
    const apiKey = await createKey(server.origin, registered.cookie);
    const response = await fetch(`${server.origin}${resourcePath}`, { headers: bearer(apiKey) });
    const body = await response.text();
    const header = response.headers.get("payment-required");
    const decoded = decodeHeader(header);
    writeLog(logName, [
      `status: ${response.status}`,
      `registeredBase: ${who.baseAddress}`,
      `PAYMENT-REQUIRED: ${header}`,
      `body: ${body}`,
      "",
      "decoded:",
      JSON.stringify(decoded, null, 2),
      "",
    ].join("\n"));
    assert.equal(response.status, 402);
    const challenge = assertChallenge(decoded, who, priceAtomic);
    assert.equal(challenge.base.maxTimeoutSeconds, config.maxTimeoutSeconds);
    return { server, resourcePath, apiKey, who, body, decoded, challenge, priceAtomic };
  }

  const first = await probe("launch-1.log");
  await first.server.stop();
  const second = await probe("launch-2.log");
  t.after(() => second.server.stop());

  function shared(decoded, network) {
    const entry = acceptFor(decoded, network);
    return {
      scheme: entry.scheme,
      asset: entry.asset.toLowerCase(),
      network: entry.network,
      x402Version: decoded.x402Version,
    };
  }
  assert.deepEqual(shared(first.decoded, BASE_NETWORK), shared(second.decoded, BASE_NETWORK));
  assert.equal(first.decoded.accepts.length, 1);
  assert.equal(second.decoded.accepts.length, 1);
  assert.equal(first.challenge.base.payTo, first.who.baseAddress);
  assert.equal(second.challenge.base.payTo, second.who.baseAddress);
  assert.notEqual(first.who.baseAddress, second.who.baseAddress);

  const basePaid = await signBase(second.challenge.base, second.who.buyer);
  const baseMark = second.server.stderr().length;
  const baseResult = await requestResource(second.server.origin, second.resourcePath, second.apiKey, basePaid.header);
  const baseSettles = await settleLines(second.server.stderr(), baseMark);
  recordSettles("resource-base-cold", baseSettles);
  assertPresented(baseResult);
  writeLog("launch-paid-base.log", [
    `status: ${baseResult.status}`,
    `body: ${baseResult.body}`,
    `PAYMENT-RESPONSE: ${baseResult.response.headers.get("payment-response")}`,
    ...baseSettles,
    "",
  ].join("\n"));
  assertNotSold(baseResult);
  assert.notEqual(baseResult.body, PAID_BODY);
  assert.equal((await books(second.server.origin, second.apiKey)).creditedAtomic, "0");
  assert.equal((await books(second.server.origin, second.apiKey)).feeAtomic, "0");
  assert.equal((await books(second.server.origin, second.apiKey)).settledCount, 0);
});

function evaluatePageScript(source) {
  const elements = {};
  function element(id) {
    const el = {
      id,
      value: "",
      hidden: id === "key-section",
      textContent: "",
      listeners: {},
      addEventListener(type, fn) {
        el.listeners[type] = fn;
      },
    };
    elements[id] = el;
    return el;
  }
  for (const id of [
    "register-form", "register-button", "form-error", "key-section", "create-key", "api-key", "key-output",
    "recipient-id", "bearer-snippet", "base-address", "price", "cost", "price-atomic", "cost-atomic",
    "quote-price", "quote-fee", "quote-total", "quote-margin", "quote-warning",
  ]) {
    element(id);
  }
  elements["key-output"].hidden = true;
  elements["base-address"].value = Wallet.createRandom().address;
  elements.price.value = "0.01";
  elements.cost.value = "0.001";
  const calls = [];
  const sandbox = {
    document: {
      readyState: "complete",
      getElementById(id) {
        return elements[id] ?? null;
      },
      addEventListener() {},
    },
    fetch(url, options) {
      calls.push({ url, options });
      const payload = url === "/v1/keys" ? { apiKey: `mp_${"cd".repeat(32)}` } : { id: "user" };
      return Promise.resolve({
        ok: true,
        json: async () => payload,
      });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "app.js" });
  assert.equal(Object.hasOwn(sandbox, "module"), false);
  assert.equal(Object.hasOwn(sandbox, "require"), false);
  assert.equal(typeof sandbox.module, "undefined");
  assert.equal(typeof sandbox.require, "undefined");
  return { elements, calls, sandbox };
}

test("the website registers a user and shows an API key", async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const pageResponse = await fetch(`${server.origin}/`);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /id="register-form"/);
  assert.match(html, /id="register-button"/);
  assert.match(html, /id="base-address"/);
  assert.equal(html.includes("solana-address"), false);
  assert.match(html, /id="price"/);
  assert.match(html, /id="cost"/);
  assert.match(html, /id="create-key"/);
  assert.match(html, /id="api-key"/);
  assert.match(html, /Authorization:\s*Bearer/);
  assert.match(html, /GET\s+\/v1\/resource/);
  const scriptResponse = await fetch(`${server.origin}/app.js`);
  assert.equal(scriptResponse.status, 200);
  const source = await scriptResponse.text();
  assert.match(source, /fetch\("\/v1\/register"/);
  assert.match(source, /fetch\("\/v1\/keys"/);
  assert.equal(source.includes("require("), false);
  assert.equal(source.includes("module.exports"), false);
  const evaluated = evaluatePageScript(source);
  // Dollar inputs show atomic USDC and a live quote with the 5% fee.
  evaluated.elements.price.value = "0.50";
  evaluated.elements.cost.value = "0.20";
  evaluated.elements.price.listeners.input();
  assert.equal(evaluated.elements["price-atomic"].textContent, "= 500000 atomic USDC");
  assert.equal(evaluated.elements["quote-price"].textContent, "$0.50");
  assert.equal(evaluated.elements["quote-fee"].textContent, "$0.025");
  assert.equal(evaluated.elements["quote-total"].textContent, "$0.525");
  assert.equal(evaluated.elements["quote-margin"].textContent, "$0.30");
  assert.equal(evaluated.elements["quote-warning"].textContent, "");
  evaluated.elements.price.value = "0.01";
  evaluated.elements.price.listeners.input();
  assert.match(evaluated.elements["quote-warning"].textContent, /\$0\.10 minimum/);
  // A bad amount is caught in the page with a readable message, before any request.
  evaluated.elements.price.value = "abc";
  await evaluated.elements["register-form"].listeners.submit({ preventDefault() {} });
  assert.equal(evaluated.calls.length, 0);
  assert.match(evaluated.elements["form-error"].textContent, /Enter a price in USDC/);
  evaluated.elements.price.value = "0.01";
  evaluated.elements.cost.value = "0.001";
  await evaluated.elements["register-form"].listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluated.calls[0].url, "/v1/register");
  assert.equal(evaluated.calls[0].options.method, "POST");
  assert.equal(evaluated.calls[0].options.credentials, "same-origin");
  const posted = JSON.parse(evaluated.calls[0].options.body);
  assert.equal(posted.baseAddress, evaluated.elements["base-address"].value);
  assert.equal(posted.solanaAddress, undefined);
  assert.equal(posted.priceAtomic, "10000");
  assert.equal(posted.costAtomic, "1000");
  assert.equal(evaluated.elements["key-section"].hidden, false);
  assert.equal(evaluated.elements["recipient-id"].textContent, "user");
  await evaluated.elements["create-key"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluated.calls[1].url, "/v1/keys");
  assert.equal(evaluated.calls[1].options.method, "POST");
  assert.match(evaluated.elements["api-key"].textContent, /^mp_[0-9a-f]{64}$/);
  assert.equal(evaluated.elements["key-output"].hidden, false);
  assert.match(evaluated.elements["bearer-snippet"].textContent, /Authorization: Bearer mp_[0-9a-f]{64}/);

  let browser;
  try {
    const chromePath = requireChrome();
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    writeLog("browser-failure.txt", error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  }

  try {
    const errors = [];
    async function exercise(width, height, shotName) {
      const page = await browser.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      let expected401 = false;
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // The unknown-key check below makes Chrome log the 401 it was meant to provoke.
        if (expected401 && /status of 401/.test(message.text())) return;
        errors.push(message.text());
      });
      await page.setViewport({ width, height });
      await page.goto(server.origin, { waitUntil: "networkidle0" });
      const who = await merchant();
      await page.locator("#base-address").fill(who.baseAddress);
      await page.locator("#price").fill("0.10");
      await page.locator("#cost").fill("0.001");
      assert.equal(await page.$eval("#quote-total", (node) => node.textContent), "$0.105");
      await page.locator("#register-button").click();
      await page.waitForSelector("#key-section:not([hidden])");
      const recipientId = await page.$eval("#recipient-id", (node) => node.textContent.trim());
      assert.match(recipientId, /^[0-9a-f]{32}$/);
      await page.locator("#create-key").click();
      await page.waitForFunction(() => /^mp_[0-9a-f]{64}$/.test(document.querySelector("#api-key").textContent || ""));
      const apiKey = await page.$eval("#api-key", (node) => node.textContent.trim());
      assert.equal(await page.$eval("#key-output", (node) => node.hidden), false);
      assert.match(await page.$eval("#key-output", (node) => node.textContent), /Shown once/);
      assert.match(await page.$eval("#bearer-snippet", (node) => node.textContent), new RegExp(`Authorization: Bearer ${apiKey}`));
      assert.equal(await page.$$eval(".copy-btn[data-copy-target]", (nodes) => nodes.map((node) => node.getAttribute("data-copy-target")).join(" ")), "#recipient-id #api-key");
      // The books panel reads GET /v1/books with the new key and shows the empty state.
      assert.equal(await page.$eval("#books-key", (node) => node.value), apiKey);
      await page.locator("#books-button").click();
      await page.waitForSelector("#books-result:not([hidden])");
      assert.equal(await page.$eval("#books-credited", (node) => node.textContent), "$0.00");
      assert.equal(await page.$eval("#books-count", (node) => node.textContent), "0");
      assert.equal(await page.$eval("#books-empty", (node) => node.hidden), false);
      assert.equal(await page.$eval("#books-idle", (node) => node.hidden), true);
      assert.match(await page.$eval("#books-terms", (node) => node.textContent), /Listed price \$0\.10/);
      expected401 = true;
      await page.$eval("#books-key", (node) => { node.value = `mp_${"0".repeat(64)}`; });
      await page.locator("#books-button").click();
      await page.waitForFunction(() => document.querySelector("#books-error").textContent !== "");
      assert.match(await page.$eval("#books-error", (node) => node.textContent), /doesn't recognise that API key/);
      const instructions = await page.$eval("#agent-instructions", (node) => node.textContent);
      assert.match(instructions, /Authorization:\s*Bearer/);
      assert.match(instructions, /GET\s+\/v1\/resource/);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.ok(overflow.scrollWidth <= overflow.clientWidth, JSON.stringify(overflow));
      if (scratch) {
        await page.screenshot({ path: path.join(scratch, shotName), fullPage: true });
      }
      await page.close();
      return apiKey;
    }

    const desktopKey = await exercise(1280, 800, "site.png");
    const narrowKey = await exercise(390, 844, "site-narrow.png");
    assert.notEqual(desktopKey, narrowKey);
    assert.equal(errors.length, 0, errors.join("\n"));
    const gated = await requestResource(server.origin, "/v1/resource", desktopKey);
    assert.equal(gated.status, 402);
    const required = decodeHeader(gated.response.headers.get("payment-required"));
    assert.equal(required.accepts.length, 1);
    assert.equal(required.accepts[0].network, BASE_NETWORK);
  } catch (error) {
    writeLog("site-error.txt", error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally {
    await browser.close();
  }
});

async function payAgent(origin, apiKey, fields, payment) {
  const headers = { "content-type": "application/json" };
  if (apiKey) Object.assign(headers, bearer(apiKey));
  if (payment) headers["payment-signature"] = payment;
  const response = await fetch(`${origin}/v1/payments`, {
    method: "POST",
    headers,
    body: JSON.stringify(fields),
  });
  const body = await response.text();
  return { response, body, status: response.status };
}

function assertClientRefusal(result) {
  assert.ok(result.status >= 400 && result.status < 500, `${result.status} ${result.body}`);
  assert.equal(result.response.headers.get("payment-required"), null);
  assert.equal(result.body.includes('"settled":true'), false);
  const parsed = JSON.parse(result.body);
  assert.equal(typeof parsed.error, "string");
  assert.notEqual(parsed.error, "");
}

test("one registered agent pays another on Base", async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const senderWho = await merchant();
  const recipientWho = await merchant();
  const senderPrice = "100000";
  const recipientPrice = "1000";
  const baseAmount = "100000";
  const sender = await register(server.origin, {
    baseAddress: senderWho.baseAddress,
    priceAtomic: senderPrice,
    costAtomic: "1000",
  });
  const recipient = await register(server.origin, {
    baseAddress: recipientWho.baseAddress,
    priceAtomic: recipientPrice,
    costAtomic: recipientPrice,
  });
  const senderKey = await createKey(server.origin, sender.cookie);
  const recipientKey = await createKey(server.origin, recipient.cookie);
  const pay = { recipient: recipient.id, amount: baseAmount };

  const beforeSender = await books(server.origin, senderKey);
  const beforeRecipient = await books(server.origin, recipientKey);
  assert.equal(beforeSender.creditedAtomic, "0");
  assert.equal(beforeSender.feeAtomic, "0");
  assert.equal(beforeSender.settledCount, 0);
  assert.equal(beforeRecipient.creditedAtomic, "0");
  assert.equal(beforeRecipient.feeAtomic, "0");
  assert.equal(beforeRecipient.settledCount, 0);

  const refusals = [
    () => payAgent(server.origin, "", pay),
    () => payAgent(server.origin, `mp_${"ab".repeat(32)}`, pay),
    () => payAgent(server.origin, senderKey, { recipient: "missing-agent", amount: baseAmount }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "0" }, "not-a-payment"),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "-1" }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "1.5" }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "01" }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "10.0" }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "" }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id, amount: 15000 }),
    () => payAgent(server.origin, senderKey, { recipient: recipient.id }),
    () => payAgent(server.origin, senderKey, { amount: baseAmount }),
    () => payAgent(server.origin, senderKey, { recipient: sender.id, amount: baseAmount }),
  ];
  for (const attempt of refusals) {
    assertClientRefusal(await attempt());
  }
  const belowMinimum = await payAgent(server.origin, senderKey, {
    recipient: recipient.id,
    amount: "99999",
  });
  assertClientRefusal(belowMinimum);
  assert.equal(JSON.parse(belowMinimum.body).error, "amount_below_minimum");
  assert.deepEqual(await books(server.origin, senderKey), beforeSender);
  assert.deepEqual(await books(server.origin, recipientKey), beforeRecipient);
  assert.equal(server.stderr().includes("payai-settle"), false);

  const opened = await payAgent(server.origin, senderKey, pay);
  assert.equal(opened.status, 402, opened.body);
  const required = decodeHeader(opened.response.headers.get("payment-required"));
  const accepts = assertChallenge(required, recipientWho, baseAmount);
  assert.equal(required.resource.url, `${server.origin}/v1/payments`);
  assert.equal(accepts.base.amount, "105000");
  assert.notEqual(accepts.base.payTo, senderWho.baseAddress);
  const oddOpened = await payAgent(server.origin, senderKey, { recipient: recipient.id, amount: "100001" });
  assert.equal(oddOpened.status, 402, oddOpened.body);
  const oddAccept = assertChallenge(decodeHeader(oddOpened.response.headers.get("payment-required")), recipientWho, "100001");
  assert.equal(oddAccept.base.amount, "105001");

  const shortMark = server.stderr().length;
  const short = await signBase(accepts.base, senderWho.buyer, { value: BigInt(baseAmount) - 1n });
  const shortResult = await payAgent(server.origin, senderKey, pay, short.header);
  assert.notEqual(shortResult.status, 200);
  assert.equal(shortResult.body.includes('"settled":true'), false);
  assert.equal((await settleLines(server.stderr(), shortMark)).length, 0);
  assert.deepEqual(await books(server.origin, senderKey), beforeSender);
  assert.deepEqual(await books(server.origin, recipientKey), beforeRecipient);

  const signed = await signBase(accepts.base, senderWho.buyer);
  assert.equal(signed.authorization.value, BigInt(accepts.base.amount) - BigInt(accepts.base.extra.feeAmount));
  assert.equal(signed.authorization.to, accepts.base.payTo);
  assert.equal(signed.feeAuthorization.to, platformBase.address);
  assert.equal(signed.feeAuthorization.value, BigInt(accepts.base.extra.feeAmount));
  const baseMark = server.stderr().length;
  const baseResult = await payAgent(server.origin, senderKey, pay, signed.header);
  recordSettles("agent-base", await settleLines(server.stderr(), baseMark));
  assertPresented(baseResult);
  assertNotSold(baseResult);
  assert.deepEqual(await books(server.origin, senderKey), beforeSender);
  assert.equal((await books(server.origin, recipientKey)).creditedAtomic, "0");
  assert.equal((await books(server.origin, recipientKey)).feeAtomic, "0");
  assert.equal((await books(server.origin, recipientKey)).settledCount, 0);
  assert.equal((await books(server.origin, recipientKey)).priceAtomic, recipientPrice);

  const replay = await payAgent(server.origin, senderKey, pay, signed.header);
  assertNotSold(replay);
  assert.deepEqual(await books(server.origin, senderKey), beforeSender);
  assert.equal((await books(server.origin, recipientKey)).creditedAtomic, "0");
  assert.equal((await books(server.origin, recipientKey)).feeAtomic, "0");
  assert.equal((await books(server.origin, recipientKey)).settledCount, 0);

  const blocked = await requestResource(server.origin, "/v1/resource", recipientKey);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.response.headers.get("payment-required"), null);
  assert.equal(JSON.parse(blocked.body).error, "price_not_above_cost");
  assertNotSold(blocked);

  const senderUnpaid = await requestResource(server.origin, "/v1/resource", senderKey);
  assert.equal(senderUnpaid.status, 402);
  const senderRequired = decodeHeader(senderUnpaid.response.headers.get("payment-required"));
  const senderAccepts = assertChallenge(senderRequired, senderWho, senderPrice);
  assert.equal(senderRequired.resource.url, `${server.origin}/v1/resource`);

  const senderPaid = await signBase(senderAccepts.base, senderWho.buyer);
  const senderMark = server.stderr().length;
  const senderResource = await requestResource(server.origin, "/v1/resource", senderKey, senderPaid.header);
  recordSettles("agent-resource", await settleLines(server.stderr(), senderMark));
  assertPresented(senderResource);
  assertNotSold(senderResource);
  const senderBooks = await books(server.origin, senderKey);
  const recipientBooks = await books(server.origin, recipientKey);
  assert.equal(senderBooks.creditedAtomic, "0");
  assert.equal(senderBooks.feeAtomic, "0");
  assert.equal(senderBooks.settledCount, 0);
  assert.equal(recipientBooks.creditedAtomic, "0");
  assert.equal(recipientBooks.feeAtomic, "0");
  assert.equal(recipientBooks.settledCount, 0);

  const evidence = [
    "initiation:",
    opened.body,
    opened.response.headers.get("payment-required"),
    "",
    "base:",
    baseResult.body,
    baseResult.response.headers.get("payment-response"),
    "",
    `recipient credited ${recipientBooks.creditedAtomic} over ${recipientBooks.settledCount} settlements`,
    `sender credited ${senderBooks.creditedAtomic}`,
  ].join("\n");
  writeLog("agent-pay-detail.log", evidence);
  console.log(evidence);
});

test("a PayAI settle body credits the payee only with a transaction id", () => {
  const ledger = createLedger(path.join(tempDir(), "settlements.ndjson"));
  const merchant = { id: "payee", priceAtomic: "200000", costAtomic: "1000" };
  const payer = hexlify(randomBytes(20));

  function booksOf() {
    return ledger.snapshot(merchant);
  }

  function settleQuote(amount, body, feeTransaction = hexlify(randomBytes(32))) {
    const nonce = `base:${hexlify(randomBytes(32))}`;
    const before = booksOf();
    const outcome = applySettleResult(ledger, {
      merchantId: merchant.id,
      nonce,
      amount,
      payer,
      network: BASE_NETWORK,
      feeTransaction,
    }, body);
    return { nonce, before, outcome, after: booksOf(), feeTransaction };
  }

  const transaction = hexlify(randomBytes(32));
  const first = settleQuote("200000", {
    success: true,
    transaction,
    network: BASE_NETWORK,
    payer,
  });
  const firstPrice = 200000n;
  const firstFee = (firstPrice * 5n) / 100n;
  const firstQuoted = firstPrice + firstFee;
  assert.equal(first.outcome.credited, true);
  assert.equal(first.outcome.transaction, transaction);
  assert.equal(first.outcome.feeTransaction, first.feeTransaction);
  assert.equal(first.outcome.amount, firstQuoted.toString());
  assert.equal(BigInt(first.after.creditedAtomic) - BigInt(first.before.creditedAtomic), firstPrice);
  assert.equal(BigInt(first.after.feeAtomic) - BigInt(first.before.feeAtomic), firstFee);
  assert.equal(BigInt(first.after.creditedAtomic) + BigInt(first.after.feeAtomic), firstQuoted);
  assert.equal(first.after.settledCount, 1);
  assert.equal(ledger.entry(merchant.id, first.nonce).transaction, transaction);
  assert.equal(ledger.entry(merchant.id, first.nonce).amount, firstQuoted.toString());
  assert.equal(ledger.entry(merchant.id, first.nonce).fee, firstFee.toString());

  const secondTransaction = hexlify(randomBytes(32));
  const second = settleQuote("100001", {
    success: true,
    transaction: secondTransaction,
    network: BASE_NETWORK,
    payer,
  });
  const secondPrice = 100001n;
  const secondFee = (secondPrice * 5n) / 100n;
  const secondQuoted = secondPrice + secondFee;
  assert.equal(second.outcome.credited, true);
  assert.equal(second.outcome.transaction, secondTransaction);
  assert.equal(second.outcome.amount, secondQuoted.toString());
  assert.equal(BigInt(second.after.creditedAtomic) - BigInt(second.before.creditedAtomic), secondPrice);
  assert.equal(BigInt(second.after.feeAtomic) - BigInt(second.before.feeAtomic), secondFee);
  assert.equal(
    BigInt(second.after.creditedAtomic) + BigInt(second.after.feeAtomic),
    firstQuoted + secondQuoted,
  );
  assert.equal(second.after.settledCount, 2);

  const held = booksOf();
  const unpaidFee = settleQuote("200000", {
    success: true,
    transaction: hexlify(randomBytes(32)),
    network: BASE_NETWORK,
    payer,
  }, "");
  assert.equal(unpaidFee.outcome.credited, false);
  assert.equal(unpaidFee.outcome.reason, "missing_fee_transaction");
  assert.deepEqual(booksOf(), held);

  const empty = settleQuote("200000", {
    success: true,
    transaction: "",
    network: BASE_NETWORK,
    payer,
  });
  assert.equal(empty.outcome.credited, false);
  assert.deepEqual(booksOf(), held);

  const pendingTransaction = hexlify(randomBytes(32));
  const pending = settleQuote("100001", {
    success: false,
    errorReason: "settlement_pending",
    errorMessage: "Settlement did not complete within the response budget",
    transaction: pendingTransaction,
    network: BASE_NETWORK,
    payer,
  });
  assert.equal(pending.outcome.credited, false);
  assert.equal(pending.outcome.reason, "settlement_pending");
  assert.notEqual(pendingTransaction, transaction);
  assert.deepEqual(booksOf(), held);

  const replacement = hexlify(randomBytes(32));
  const replay = applySettleResult(ledger, {
    merchantId: merchant.id,
    nonce: first.nonce,
    amount: "200000",
    payer,
    network: BASE_NETWORK,
    feeTransaction: hexlify(randomBytes(32)),
  }, {
    success: true,
    transaction: replacement,
    network: BASE_NETWORK,
    payer,
  });
  assert.equal(replay.credited, false);
  assert.equal(replay.transaction, transaction);
  assert.equal(replay.amount, firstQuoted.toString());
  assert.notEqual(replay.transaction, replacement);
  assert.deepEqual(booksOf(), held);
});

test("a sale without a platform address does not ask for payment", async (t) => {
  const server = await start(defaultConfigPath);
  t.after(() => server.stop());
  const who = await merchant();
  const registered = await register(server.origin, {
    baseAddress: who.baseAddress,
    priceAtomic: "100000",
    costAtomic: "1000",
  });
  const apiKey = await createKey(server.origin, registered.cookie);
  const unpaid = await requestResource(server.origin, "/v1/resource", apiKey);
  assert.equal(unpaid.status, 503);
  assert.equal(unpaid.response.headers.get("payment-required"), null);
  assert.equal(JSON.parse(unpaid.body).error, "platform_unconfigured");
  assert.equal(server.stderr().includes("payai-settle"), false);
  const account = await books(server.origin, apiKey);
  assert.equal(account.creditedAtomic, "0");
  assert.equal(account.feeAtomic, "0");
  assert.equal(account.settledCount, 0);
});

