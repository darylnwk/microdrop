import fs from "node:fs";
import path from "node:path";
import { feeFor } from "./fee.js";

const ATOMIC = /^(0|[1-9][0-9]*)$/;

export function createLedger(ledgerPath) {
  const nonces = new Set();
  const credited = new Map();
  const fees = new Map();
  const counts = new Map();
  const entries = new Map();

  function keyFor(merchantId, nonce) {
    return `${merchantId}:${String(nonce).toLowerCase()}`;
  }

  function add(merchantId, nonce, gross, fee, meta) {
    const key = keyFor(merchantId, nonce);
    if (nonces.has(key)) return false;
    const grossValue = BigInt(gross);
    const feeValue = BigInt(fee);
    nonces.add(key);
    credited.set(merchantId, (credited.get(merchantId) ?? 0n) + (grossValue - feeValue));
    fees.set(merchantId, (fees.get(merchantId) ?? 0n) + feeValue);
    counts.set(merchantId, (counts.get(merchantId) ?? 0) + 1);
    entries.set(key, meta);
    return true;
  }

  if (ledgerPath && fs.existsSync(ledgerPath)) {
    const text = fs.readFileSync(ledgerPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.merchantId !== "string" || typeof row.nonce !== "string") continue;
        if (typeof row.amount !== "string" || !ATOMIC.test(row.amount)) continue;
        const fee = Object.hasOwn(row, "fee") ? row.fee : "0";
        if (typeof fee !== "string" || !ATOMIC.test(fee) || BigInt(fee) > BigInt(row.amount)) continue;
        const feeTransaction = typeof row.feeTransaction === "string" ? row.feeTransaction : "";
        add(row.merchantId, row.nonce, row.amount, fee, {
          transaction: typeof row.transaction === "string" ? row.transaction : "",
          feeTransaction,
          payer: typeof row.payer === "string" ? row.payer : "",
          network: typeof row.network === "string" ? row.network : "",
          amount: row.amount,
          fee,
        });
        if (typeof row.feeNonce === "string" && row.feeNonce !== "") {
          nonces.add(keyFor(row.merchantId, row.feeNonce));
        }
      } catch {
        continue;
      }
    }
  }

  return {
    has(merchantId, nonce) {
      return nonces.has(keyFor(merchantId, nonce));
    },
    entry(merchantId, nonce) {
      return entries.get(keyFor(merchantId, nonce)) ?? null;
    },
    settle(merchantId, nonce, amount, payer, network, transaction, feeTransaction = "", feeNonce = "") {
      if (typeof transaction !== "string" || transaction.trim() === "") return false;
      if (typeof feeTransaction !== "string" || feeTransaction.trim() === "") return false;
      const storedFeeTransaction = feeTransaction;
      const price = BigInt(amount);
      const fee = feeFor(price).toString();
      const quoted = (price + BigInt(fee)).toString();
      const meta = { transaction, feeTransaction: storedFeeTransaction, payer, network, amount: quoted, fee };
      if (feeNonce && nonces.has(keyFor(merchantId, feeNonce))) return false;
      if (!add(merchantId, nonce, quoted, fee, meta)) return false;
      if (feeNonce) nonces.add(keyFor(merchantId, feeNonce));
      if (ledgerPath) {
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        fs.appendFileSync(ledgerPath, `${JSON.stringify({
          merchantId,
          nonce: String(nonce).toLowerCase(),
          amount: quoted,
          fee,
          payer,
          network,
          transaction,
          feeTransaction: storedFeeTransaction,
          feeNonce: feeNonce ? String(feeNonce).toLowerCase() : "",
        })}\n`);
      }
      return true;
    },
    snapshot(merchant) {
      return {
        creditedAtomic: (credited.get(merchant.id) ?? 0n).toString(),
        feeAtomic: (fees.get(merchant.id) ?? 0n).toString(),
        settledCount: counts.get(merchant.id) ?? 0,
        priceAtomic: merchant.priceAtomic,
        costAtomic: merchant.costAtomic,
      };
    },
  };
}
