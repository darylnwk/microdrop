import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { meetsMinimum } from "./fee.js";

const EVM = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;

function loadUsers(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

export function unsellableReason(merchant) {
  const price = BigInt(merchant.priceAtomic);
  const cost = BigInt(merchant.costAtomic);
  if (price <= cost) return "price_not_above_cost";
  if (!meetsMinimum(price)) return "amount_below_minimum";
  return null;
}

export function sellable(merchant) {
  return unsellableReason(merchant) === null;
}

export function createMerchantStore(file) {
  const users = loadUsers(file);

  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users }));
    fs.renameSync(tmp, file);
  }

  return {
    register(input) {
      const baseAddress = typeof input.baseAddress === "string" ? input.baseAddress.trim() : "";
      const priceAtomic = typeof input.priceAtomic === "string" ? input.priceAtomic.trim() : "";
      const costAtomic = typeof input.costAtomic === "string" ? input.costAtomic.trim() : "";
      if (!EVM.test(baseAddress)) return { error: "base_address_invalid" };
      if (!AMOUNT.test(priceAtomic)) return { error: "price_invalid" };
      if (!AMOUNT.test(costAtomic)) return { error: "cost_invalid" };
      const user = {
        id: crypto.randomBytes(16).toString("hex"),
        baseAddress,
        priceAtomic,
        costAtomic,
        session: crypto.randomBytes(32).toString("hex"),
        keys: [],
      };
      users.push(user);
      save();
      return { user };
    },
    bySession(session) {
      if (!session) return null;
      return users.find((user) => user.session === session) ?? null;
    },
    byId(id) {
      if (typeof id !== "string" || id === "") return null;
      return users.find((user) => user.id === id) ?? null;
    },
    createKey(session) {
      const user = this.bySession(session);
      if (!user) return { error: "session_required" };
      const apiKey = `mp_${crypto.randomBytes(32).toString("hex")}`;
      user.keys.push(apiKey);
      save();
      return { apiKey, user };
    },
    byKey(apiKey) {
      if (!apiKey) return null;
      return users.find((user) => user.keys.includes(apiKey)) ?? null;
    },
  };
}
