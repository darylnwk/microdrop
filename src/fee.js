export const MINIMUM_ATOMIC = 100000n;

export function feeFor(amount) {
  return (BigInt(amount) * 5n) / 100n;
}

export function quotedFor(amount) {
  const price = BigInt(amount);
  return price + feeFor(price);
}

export function meetsMinimum(amount) {
  return BigInt(amount) >= MINIMUM_ATOMIC;
}
