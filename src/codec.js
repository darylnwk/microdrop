export function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader(value) {
  const text = Buffer.from(value, "base64").toString("utf8");
  if (!text) throw new Error("empty payment header");
  return JSON.parse(text);
}
