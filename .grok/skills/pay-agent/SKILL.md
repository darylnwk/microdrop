---
name: pay-agent
description: "Send a USDC payment from one Grok agent to another on the local Microdrip service. Use when the user asks to pay another agent, send money between Grok agents, transfer USDC from one agent to another, or runs /pay-agent."
---

# Pay one agent from another

Use the local Microdrip service at `http://127.0.0.1:4020`. Base USDC only (`eip155:8453`). `https://microdrip.xyz` does not serve payments.

## Before the payment

Both agents are registered. You need the sender Bearer key and the recipient id.

`platformBaseAddress` in `config.json` must already be the operator's Base address. When that field is empty, the call returns `503` `platform_unconfigured` and no challenge. Leave the address for the operator to set.

## Buyer wallet

You sign with the sender's own Base wallet. It must hold the buyer total in USDC on Base and sign EIP-712 typed data from a plain address (an EOA). Microdrip recovers each signature to `from`, so a smart-contract wallet signature fails with `bad_signature`. Use the signer the user configured for this bot, such as a key kept in the bot's secrets. Never ask for, print, or paste a private key in chat.

Do not use the Coinbase connector for this payment yet. Its x402 tools (`coinbase_x402_fetch`, `coinbase_x402_pay`) produce one standard authorization for the challenge amount, and Microdrip rejects that with `amount_mismatch` because it needs the two authorizations described below. The connector has no tool that signs arbitrary EIP-712 typed data. If the Coinbase connector is the only wallet available, stop and tell the user that Coinbase connector support is planned and that the bot needs a Base wallet it can sign with.

## Send

`POST /v1/payments` with `Authorization: Bearer` and the sender key.

```json
{ "recipient": "<recipient id>", "amount": "<listed atomic USDC>" }
```

`amount` is the listed atomic price the recipient receives. It is not the buyer total. The minimum is `100000` ($0.10).

## Challenge

An unpaid call returns `402` with a base64 `PAYMENT-REQUIRED` header. Decode it as UTF-8 JSON. The challenge field is `accepts`, and it has one Base entry. `payTo` on that entry is the recipient Base address, not the recipient id. The entry `amount` is the buyer total, the listed price plus the 5% fee. `extra.feeAmount` is that fee. `extra.feePayTo` is the platform Base address. `extra.name` and `extra.version` name the EIP-712 domain. `asset` is the verifying contract.

## Sign and retry

Retry the same request with a base64 `PAYMENT-SIGNATURE` header. The decoded JSON is `x402Version: 2`, the echoed accept, and `payload`. Copy `accepts[0]` into the payment object's `accepted` and leave that entry's buyer-total `amount` unchanged.

`payload` carries two EIP-3009 signatures:

- `payload.authorization` and `payload.signature` pay the recipient. `to` is `payTo`. `value` is the listed atomic price from the request.
- `payload.feeAuthorization` and `payload.feeSignature` pay the platform. `to` is `extra.feePayTo`. `value` is `extra.feeAmount`, the 5% fee. `from` is the same buyer. The nonce is different from the payee nonce.

Sign each one as EIP-712 `TransferWithAuthorization` (`from`, `to`, `value`, `validAfter`, `validBefore`, `nonce`). The domain is `extra.name`, `extra.version`, chainId `8453`, and verifyingContract `accepted.asset`. `validAfter` must be strictly before now. `validBefore` must be strictly after now. `0` is a valid `validAfter`. Each `nonce` is 32 bytes, written as hex with an `0x` prefix, and the two nonces differ. Each signature is the 65-byte EIP-712 signature of its authorization.

## Receipt

`200` means both settlements returned a transaction id. `PAYMENT-RESPONSE` includes `transaction` for the payee, `feeTransaction` for the platform, and `amount` equal to the quote.
