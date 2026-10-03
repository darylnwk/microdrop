import { verifyTypedData } from "ethers";
import { feeFor, quotedFor } from "./fee.js";
import { BASE } from "./networks.js";

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

function fail(reason) {
  return { ok: false, reason };
}

function uintValue(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const canonical = value.replace(/^0+(?=\d)/, "");
  return BigInt(canonical);
}

function sameAddress(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function verifyBasePayment(payload, merchant, nowSeconds, isSettled) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("malformed_payment");
  if (payload.x402Version !== 2) return fail("wrong_version");
  const accepted = payload.accepted;
  const body = payload.payload;
  if (!accepted || typeof accepted !== "object" || !body || typeof body !== "object") {
    return fail("malformed_payment");
  }
  if (accepted.scheme !== "exact") return fail("unsupported_scheme");
  if (accepted.network !== BASE.network) return fail("network_mismatch");
  if (!sameAddress(accepted.asset, BASE.asset)) return fail("wrong_asset");
  const extra = accepted.extra ?? {};
  if (extra.name !== BASE.name || extra.version !== BASE.version) return fail("wrong_asset");
  const method = extra.assetTransferMethod ?? "eip3009";
  if (method !== "eip3009") return fail("unsupported_scheme");
  const flow = extra.paymentFlow ?? "authorization";
  if (flow !== "authorization") return fail("unsupported_scheme");
  if (!sameAddress(accepted.payTo, merchant.baseAddress)) return fail("wrong_recipient");
  const echoedAmount = uintValue(accepted.amount);
  if (echoedAmount === null || echoedAmount !== quotedFor(merchant.priceAtomic)) return fail("amount_mismatch");

  const authorization = body.authorization;
  const signature = body.signature;
  if (!authorization || typeof authorization !== "object" || typeof signature !== "string") {
    return fail("malformed_payment");
  }
  if (!ADDRESS.test(authorization.from ?? "") || !ADDRESS.test(authorization.to ?? "")) {
    return fail("malformed_payment");
  }
  if (!sameAddress(authorization.to, merchant.baseAddress)) return fail("wrong_recipient");
  const value = uintValue(authorization.value);
  const validAfter = uintValue(authorization.validAfter);
  const validBefore = uintValue(authorization.validBefore);
  if (value === null || validAfter === null || validBefore === null) return fail("malformed_payment");
  const price = BigInt(merchant.priceAtomic);
  if (value !== price) return fail(value < price ? "value_below_price" : "amount_mismatch");
  const now = BigInt(nowSeconds);
  // EIP-3009 is strict: the timestamp must be after validAfter and before validBefore.
  if (validBefore <= now) return fail("expired");
  if (validAfter >= now) return fail("not_yet_valid");
  if (typeof authorization.nonce !== "string" || !NONCE.test(authorization.nonce)) return fail("malformed_payment");
  if (!SIGNATURE.test(signature)) return fail("bad_signature");

  const nonce = `base:${authorization.nonce.toLowerCase()}`;
  let recovered;
  try {
    recovered = verifyTypedData(
      {
        name: BASE.name,
        version: BASE.version,
        chainId: BASE.chainId,
        verifyingContract: BASE.asset,
      },
      TYPES,
      {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce,
      },
      signature,
    );
  } catch {
    return fail("bad_signature");
  }
  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) return fail("bad_signature");

  const feeAuthorization = body.feeAuthorization;
  const feeSignature = body.feeSignature;
  if (!feeAuthorization || typeof feeAuthorization !== "object" || typeof feeSignature !== "string") {
    return fail("fee_required");
  }
  if (!merchant.platformBaseAddress) return fail("platform_unconfigured");
  if (!ADDRESS.test(feeAuthorization.from ?? "") || !ADDRESS.test(feeAuthorization.to ?? "")) {
    return fail("malformed_payment");
  }
  if (!sameAddress(feeAuthorization.from, authorization.from)) return fail("fee_payer_mismatch");
  if (!sameAddress(feeAuthorization.to, merchant.platformBaseAddress)) return fail("wrong_fee_recipient");
  const feeValue = uintValue(feeAuthorization.value);
  const feeAfter = uintValue(feeAuthorization.validAfter);
  const feeBefore = uintValue(feeAuthorization.validBefore);
  if (feeValue === null || feeAfter === null || feeBefore === null) return fail("malformed_payment");
  if (feeValue !== feeFor(price)) return fail("fee_mismatch");
  if (feeBefore <= now) return fail("expired");
  if (feeAfter >= now) return fail("not_yet_valid");
  if (typeof feeAuthorization.nonce !== "string" || !NONCE.test(feeAuthorization.nonce)) return fail("malformed_payment");
  if (feeAuthorization.nonce.toLowerCase() === authorization.nonce.toLowerCase()) return fail("fee_reused");
  if (!SIGNATURE.test(feeSignature)) return fail("bad_signature");
  let feeRecovered;
  try {
    feeRecovered = verifyTypedData(
      {
        name: BASE.name,
        version: BASE.version,
        chainId: BASE.chainId,
        verifyingContract: BASE.asset,
      },
      TYPES,
      {
        from: feeAuthorization.from,
        to: feeAuthorization.to,
        value: feeValue,
        validAfter: feeAfter,
        validBefore: feeBefore,
        nonce: feeAuthorization.nonce,
      },
      feeSignature,
    );
  } catch {
    return fail("bad_signature");
  }
  if (feeRecovered.toLowerCase() !== feeAuthorization.from.toLowerCase()) return fail("bad_signature");

  const feeNonce = `base:${feeAuthorization.nonce.toLowerCase()}`;
  if (isSettled(nonce)) return { ok: false, reason: "nonce_replayed", nonce, payer: authorization.from, network: BASE.network };
  if (isSettled(feeNonce)) return { ok: false, reason: "nonce_replayed", nonce: feeNonce, payer: authorization.from, network: BASE.network };
  return { ok: true, payer: authorization.from, nonce, feeNonce, network: BASE.network };
}
