# Microdrip

A small x402 service for USDC on Base. A merchant registers on the website, creates an API key, and gives that key to their agent.

A buying agent needs its own setup: a Microdrip API key, a funded Base USDC wallet that can sign EIP-712 typed data (two EIP-3009 authorizations per payment, from a plain address), and the `/pay-agent` skill in `.grok/skills/pay-agent/SKILL.md`. Support for paying from the Coinbase connector in Grok Bot is planned: its x402 tools sign a single authorization, and Microdrip needs a payee leg and a fee leg. See `/docs#buyer-setup`.

Payments are not live on microdrip.xyz yet. The hosted service is not deployed and the platform address in `config.json` is unset, so run it locally.

An unpaid request with the key returns `402` and a `PAYMENT-REQUIRED` challenge for exact Base USDC (`eip155:8453`). A valid payment returns the metered response. The service checks the Base EIP-3009 signature locally. It does not call a chain RPC. Each payment settles once, to the merchant that owns the key.

If a merchant's price is not strictly above their declared cost, the service will not offer a challenge or return the paid response.

## Run

```bash
npm install
npm start
```

Open http://127.0.0.1:4020. Register a Base address, a price, and a cost. The form takes dollar amounts and sends atomic USDC (6 decimals): `0.01` becomes `10000`. Then create an API key. The page shows your recipient id, the key, and how the agent should send it:

`Authorization: Bearer <key>` on `GET /v1/resource`.

`GET /v1/books` with the same header shows that merchant's credited USDC. Credited value is the number of settled payments times the price, which stays above the same count times the cost.

`config.json` sets the listen port and the platform Base address that receives the fee. Merchant addresses, price, and cost come from registration, not from that file.

Settlements are stored in `data/settlements.ndjson`. Registrations and keys are stored in `data/merchants.json`. One process should own those files.

## Pages

- `/` (`public/index.html`, `public/app.js`): register, recipient id and API key handover, and a books panel for `GET /v1/books`.
- `/docs` (`public/docs.html`): the pay-agent guide, what the buyer needs, API reference, payment headers, errors, and an interactive demo (`public/demo.js`, `public/demo.css`). The demo shows the Grok Bot conversation while Research bot pays Data bot with `/pay-agent`, with the payment request, receipt, seller books and raw HTTP in an optional Under the hood panel. It is simulated in the browser: no network calls, no keys, no funds move.
- `/pricing` (`public/pricing.html`).

All pages share `public/brand.css` and `public/ui.js`. `site/` is the separate static coming-soon page that Vercel serves.

## Test

```bash
CHROME_PATH=/usr/bin/google-chrome npm test
```

Browser tests use `CHROME_PATH`, or find Chrome at the usual macOS and Linux paths, and fail if it is missing. Some HTTP tests post signed authorizations from random unfunded wallets to the live PayAI facilitator.
