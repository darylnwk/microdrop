import { feeFor } from "./fee.js";

const FACILITATOR_URL = "https://facilitator.payai.network";

function payaiExtra(extra) {
  if (!extra || typeof extra !== "object") return undefined;
  return { name: extra.name, version: extra.version };
}

export function readSettleResult(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "settle_failed" };
  }
  if (body.errorReason === "settlement_pending" || body.success !== true) {
    const reason = typeof body.errorReason === "string" && body.errorReason !== ""
      ? body.errorReason
      : "settle_failed";
    return { ok: false, reason };
  }
  if (typeof body.transaction !== "string" || body.transaction.trim() === "") {
    return { ok: false, reason: "missing_transaction" };
  }
  return { ok: true, transaction: body.transaction };
}

export function applySettleResult(ledger, settlement, body) {
  const decision = readSettleResult(body);
  if (!decision.ok) return { credited: false, reason: decision.reason };
  if (typeof settlement.feeTransaction !== "string" || settlement.feeTransaction.trim() === "") {
    return { credited: false, reason: "missing_fee_transaction" };
  }
  const recorded = ledger.settle(
    settlement.merchantId,
    settlement.nonce,
    settlement.amount,
    settlement.payer,
    settlement.network,
    decision.transaction,
    settlement.feeTransaction ?? "",
    settlement.feeNonce || "",
  );
  const prior = ledger.entry(settlement.merchantId, settlement.nonce);
  if (!recorded) {
    return {
      credited: false,
      replay: true,
      transaction: prior?.transaction || decision.transaction,
      feeTransaction: prior?.feeTransaction ?? settlement.feeTransaction ?? "",
      payer: prior?.payer || settlement.payer,
      network: prior?.network || settlement.network,
      amount: prior?.amount || settlement.amount,
    };
  }
  return {
    credited: true,
    transaction: decision.transaction,
    feeTransaction: settlement.feeTransaction ?? "",
    payer: settlement.payer,
    network: settlement.network,
    amount: prior?.amount,
  };
}

export function settlementLegs(payload, price) {
  const accepted = payload.accepted;
  const body = payload.payload ?? {};
  const payee = BigInt(price).toString();
  const fee = feeFor(price).toString();
  const extra = payaiExtra(accepted?.extra);
  return {
    merchant: {
      x402Version: 2,
      resource: payload.resource,
      accepted: { ...accepted, amount: payee, payTo: accepted.payTo, extra },
      payload: { signature: body.signature, authorization: body.authorization },
    },
    fee: {
      x402Version: 2,
      resource: payload.resource,
      accepted: { ...accepted, amount: fee, payTo: accepted?.extra?.feePayTo, extra },
      payload: { signature: body.feeSignature, authorization: body.feeAuthorization },
    },
  };
}

export function settleRequest(payload, resource) {
  const accepted = payload.accepted;
  const described = payload.resource ?? resource;
  const paymentPayload = {
    x402Version: 2,
    scheme: accepted.scheme,
    network: accepted.network,
    resource: described,
    accepted,
    payload: payload.payload,
  };
  return {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: {
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
      extra: accepted.extra,
      resource: described.url,
      description: described.description,
      mimeType: described.mimeType,
    },
  };
}

async function postJson(pathname, body) {
  const response = await fetch(`${FACILITATOR_URL}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

export async function settleWithPayAI(payload, resource) {
  const request = settleRequest(payload, resource);
  let verified = null;
  try {
    verified = await postJson("/verify", request);
  } catch {
    verified = null;
  }
  const settled = await postJson("/settle", request);
  return { verified, settled };
}
