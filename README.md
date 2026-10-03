# Microdrip

A small x402 service for USDC on Base. Buyers do not need an account. A merchant registers on the website, creates an API key, and gives that key to their agent.

An unpaid request with the key returns `402` and a `PAYMENT-REQUIRED` challenge for exact Base USDC (`eip155:8453`). A valid payment returns the metered response. The service checks the Base EIP-3009 signature locally. It does not call a chain RPC. Each payment settles once, to the merchant that owns the key.

If a merchant's price is not strictly above their declared cost, the service will not offer a challenge or return the paid response.

## Run

```bash
npm install
npm start
```

Open http://127.0.0.1:4020. Register a Base address, a price, and a cost. Prices are atomic USDC (6 decimals): `10000` is 0.01 USDC. Then create an API key. The page shows the key and how the agent should send it:

`Authorization: Bearer <key>` on `GET /v1/resource`.

`GET /v1/books` with the same header shows that merchant's credited USDC. Credited value is the number of settled payments times the price, which stays above the same count times the cost.

`config.json` sets the listen port and the platform Base address that receives the fee. Merchant addresses, price, and cost come from registration, not from that file.

Settlements are stored in `data/settlements.ndjson`. Registrations and keys are stored in `data/merchants.json`. One process should own those files.
