import { feeFor, quotedFor } from "./fee.js";
import { BASE } from "./networks.js";

export function paymentRequired(merchant, config, resourceUrl, error) {
  return {
    x402Version: 2,
    error,
    resource: {
      url: resourceUrl,
      description: "Metered HTTP response",
      mimeType: "application/json",
      serviceName: "microdrip",
    },
    accepts: [
      {
        scheme: "exact",
        network: BASE.network,
        amount: quotedFor(merchant.priceAtomic).toString(),
        asset: BASE.asset,
        payTo: merchant.baseAddress,
        maxTimeoutSeconds: config.maxTimeoutSeconds,
        extra: {
          name: BASE.name,
          version: BASE.version,
          feeAmount: feeFor(merchant.priceAtomic).toString(),
          feePayTo: config.platformBaseAddress,
        },
      },
    ],
  };
}
