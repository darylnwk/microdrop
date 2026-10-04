import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { paymentRequired } from "../src/challenge.js";
import { verifyBasePayment } from "../src/eip3009.js";
import { feeFor, meetsMinimum, MINIMUM_ATOMIC, quotedFor } from "../src/fee.js";
import { requireChrome } from "./chrome.js";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.env.X402_SCRATCH || "";
const pricingPath = path.join(root, "public", "pricing.html");
const docsPath = path.join(root, "public", "docs.html");
const homePath = path.join(root, "public", "index.html");
const brandPath = path.join(root, "public", "brand.css");
const skillPath = path.join(root, ".grok", "skills", "pay-agent", "SKILL.md");

function skillParts(source) {
  const front = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!front) throw new Error("skill is missing frontmatter");
  const name = front[1].match(/^name:\s*([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\s*$/m);
  const description = front[1].match(/^description:\s*"([\s\S]*?)"\s*$/m);
  if (!name || !description) throw new Error("skill frontmatter is missing name or description");
  return { name: name[1], description: description[1], body: source.slice(front[0].length) };
}

function writeScratch(name, text) {
  if (!scratch) return;
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, name), text);
}

function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "microdrip-docs-"));
  const configPath = path.join(dir, "config.json");
  fs.copyFileSync(path.join(root, "config.json"), configPath);
  const child = spawn(process.execPath, [path.join(root, "src/cli.js")], {
    cwd: root,
    env: {
      ...process.env,
      X402_CONFIG: configPath,
      X402_LEDGER: path.join(dir, "settlements.ndjson"),
      X402_STORE: path.join(dir, "merchants.json"),
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`server did not listen\nstdout:${out}\nstderr:${err}`));
    }, 20000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/x402-microdrip listening on (.+):(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        origin: `http://127.0.0.1:${match[2]}`,
        async stop() {
          if (child.exitCode != null || child.signalCode != null) return;
          child.kill("SIGTERM");
          const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
          await once(child, "exit");
          clearTimeout(killTimer);
        },
      });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code ?? signal}\nstdout:${out}\nstderr:${err}`));
    });
  });
}

const demoPath = path.join(root, "public", "demo.js");
const demoCssPath = path.join(root, "public", "demo.css");
const uiPath = path.join(root, "public", "ui.js");

const DEMO_PRICE = "500000";
const UNPAID = "PAYMENT-SIGNATURE header is required";

function usd(atomic) {
  const value = BigInt(atomic);
  const whole = (value / 1000000n).toString();
  let frac = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  while (frac.length < 2) frac += "0";
  return `$${whole}.${frac}`;
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

// Every error code the service can return, from src/server.js, src/merchants.js,
// src/eip3009.js and src/facilitator.js. The docs errors table must list each one.
const ERROR_CODES = [
  "invalid_json", "body_too_large", "base_address_invalid", "price_invalid", "cost_invalid",
  "session_required", "api_key_required", "unknown_api_key", "recipient_required", "recipient_unknown",
  "recipient_is_sender", "amount_invalid", "amount_below_minimum", "price_not_above_cost",
  "platform_unconfigured", "not_found", "method_not_allowed", "server_error", "settlement_failed",
  UNPAID, "malformed_payment", "wrong_version", "unsupported_scheme", "network_mismatch", "wrong_asset",
  "wrong_recipient", "amount_mismatch", "value_below_price", "expired", "not_yet_valid", "bad_signature",
  "fee_required", "fee_payer_mismatch", "wrong_fee_recipient", "fee_mismatch", "fee_reused",
  "nonce_replayed", "settle_failed", "missing_transaction", "missing_fee_transaction",
];

test("the pay-agent skill, the docs, pricing and home agree", () => {
  const pricing = fs.readFileSync(pricingPath, "utf8");
  const docs = fs.readFileSync(docsPath, "utf8");
  const home = fs.readFileSync(homePath, "utf8");
  const brand = fs.readFileSync(brandPath, "utf8");
  const skill = skillParts(fs.readFileSync(skillPath, "utf8"));

  assert.ok(skill.name.length >= 2 && skill.name.length <= 64);
  assert.match(skill.description, /one Grok agent to another/i);
  assert.match(skill.description, new RegExp(`/${skill.name}`));
  assert.match(skill.body, /eip155:8453/);
  assert.match(skill.body, /listed atomic price/);
  assert.match(skill.body, /not the buyer total/);
  assert.match(skill.body, /402/);
  assert.match(skill.body, /PAYMENT-REQUIRED/);
  assert.match(skill.body, /PAYMENT-SIGNATURE/);
  assert.match(skill.body, /two EIP-3009 signatures/);
  assert.match(skill.body, /5% fee/);
  assert.match(skill.body, /platform_unconfigured/);
  assert.match(skill.body, /payTo/);
  assert.match(skill.body, /feePayTo/);
  assert.match(skill.body, /recipient Base address/);
  assert.match(skill.body, /copy `accepts\[0\]` into the payment object's `accepted`/i);
  assert.match(skill.body, /buyer-total `amount` unchanged/);
  assert.match(skill.body, /x402Version:\s*2/);
  for (const key of [
    "payload.authorization",
    "payload.signature",
    "payload.feeAuthorization",
    "payload.feeSignature",
  ]) {
    assert.ok(skill.body.includes(key), `skill is missing ${key}`);
  }
  assert.match(skill.body, /extra\.name/);
  assert.match(skill.body, /extra\.version/);
  assert.match(skill.body, /chainId `8453`/);
  assert.match(skill.body, /validAfter` must be strictly before now/);
  assert.match(skill.body, /validBefore` must be strictly after now/);
  assert.equal(/challenge\.accepted/.test(skill.body), false);
  assert.equal(/echo the challenge/i.test(skill.body), false);
  assert.equal(/0x[0-9a-fA-F]{40}/.test(skill.body), false);
  assert.equal(/sign (?:one|a single) transfer of the (?:full )?quote/i.test(skill.body), false);
  // The skill says which wallet signs, and does not pretend the Coinbase connector can.
  assert.match(skill.body, /## Buyer wallet/);
  assert.match(skill.body, /sender's own Base wallet/);
  assert.match(skill.body, /EIP-712 typed data/);
  assert.match(skill.body, /Do not use the Coinbase connector for this payment yet/);
  assert.match(skill.body, /Coinbase connector support is planned/);
  assert.match(skill.body, /amount_mismatch/);
  assert.match(skill.body, /Never ask for, print, or paste a private key/);

  // Docs: the skill, the flow, the raw API and the demo mount.
  assert.match(docs, new RegExp(skill.name));
  assert.match(docs, new RegExp(`/${skill.name}`));
  assert.match(docs, /one Grok agent to another/i);
  assert.match(docs, /who pays, who is paid, and the listed price/);
  assert.match(docs, /buyer total/);
  assert.match(docs, /two EIP-3009 authorizations/);
  assert.match(docs, /recipient Base address/);
  assert.match(docs, /fee to the platform/);
  assert.match(docs, /challenge amount unchanged/);
  assert.match(docs, /both settle/);
  assert.match(docs, /\$0\.10/);
  assert.match(docs, /platform_unconfigured/);
  assert.match(docs, /payment stays unavailable/);
  assert.match(docs, /npm start/);
  assert.match(docs, /microdrip\.xyz/);
  assert.match(docs, /href="\/pricing"/);
  for (const route of ["POST /v1/register", "POST /v1/keys", "GET /v1/books", "POST /v1/payments"]) {
    assert.ok(docs.includes(route), `docs are missing ${route}`);
  }
  for (const header of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE"]) {
    assert.ok(docs.includes(header), `docs are missing ${header}`);
  }
  assert.match(docs, /\{\{resourcePath\}\}/);
  assert.match(docs, /"amount": "525000"/);
  assert.match(docs, /"feeAmount": "25000"/);
  assert.equal(quotedFor(500000n).toString(), "525000");
  assert.equal(feeFor(500000n).toString(), "25000");
  assert.match(docs, /\{"creditedAtomic":"500000","feeAtomic":"25000","settledCount":1,"priceAtomic":"500000","costAtomic":"200000"\}/);
  assert.match(docs, /\{"settled":true,"amount":"500000","network":"eip155:8453","recipient":"&lt;recipient id&gt;"\}/);
  assert.match(docs, /\{"delivered":true,"service":"microdrip","unit":"request"\}/);
  const errorsSection = docs.slice(docs.indexOf('id="errors"'), docs.indexOf('id="local"'));
  for (const code of ERROR_CODES) {
    assert.ok(errorsSection.includes(`<code>${code}</code>`), `errors table is missing ${code}`);
  }
  // Sidebar links all point at sections on the page.
  const nav = docs.slice(docs.indexOf('class="docs-nav"'), docs.indexOf("</nav>", docs.indexOf('class="docs-nav"')));
  const anchors = [...nav.matchAll(/href="#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(anchors.length >= 8, anchors.join(","));
  for (const anchor of anchors) assert.match(docs, new RegExp(`id="${anchor}"`), anchor);
  assert.match(docs, /id="grok-demo"/);
  assert.match(docs, /Simulated, no funds move/);
  // What the buyer needs, honestly scoped.
  const buyer = docs.slice(docs.indexOf('id="buyer-setup"'), docs.indexOf('id="demo"'));
  assert.match(buyer, /What the buyer needs/);
  assert.match(buyer, /A Microdrip API key/);
  assert.match(buyer, /A funded Base USDC wallet that can sign/);
  assert.match(buyer, /\/pay-agent<\/code> skill/);
  assert.match(buyer, /Coinbase connector support: planned/);
  assert.match(buyer, /amount_mismatch/);
  assert.match(buyer, /href="https:\/\/docs\.cdp\.coinbase\.com\//);
  assert.equal(/Approve|Decline/.test(docs.slice(docs.indexOf('id="demo"'), docs.indexOf('id="quickstart"'))), false);
  assert.match(docs, /Under the hood/);
  // Not live on microdrip.xyz, near the top of the page.
  assert.match(docs, /id="not-live"/);
  assert.ok(docs.indexOf('id="not-live"') < docs.indexOf('id="demo"'));
  assert.match(docs, /Payments don't run on microdrip\.xyz: the hosted service isn't deployed and its platform address is unset/);
  assert.match(docs, /src="\/demo\.js"/);
  assert.match(docs, /href="\/demo\.css"/);
  assert.match(docs, /src="\/ui\.js"/);

  // Pricing: the rule, a worked example that matches src/fee.js, and an FAQ.
  assert.match(pricing, /5% per transaction/);
  assert.match(pricing, /buyer pays the fee/i);
  assert.match(pricing, /payee receives the listed price/i);
  assert.match(pricing, /\$0\.10/);
  assert.equal(usd(feeFor(1000000n)), "$0.05");
  assert.equal(usd(quotedFor(1000000n)), "$1.05");
  assert.match(pricing, /\$1\.00/);
  assert.match(pricing, /\$0\.05/);
  assert.match(pricing, /\$1\.05/);
  assert.match(pricing, new RegExp(`<code>${quotedFor(1000000n)}</code>`));
  assert.equal(usd(feeFor(MINIMUM_ATOMIC)), "$0.005");
  assert.match(pricing, /the fee is \$0\.005 and the buyer pays \$0\.105/);
  assert.ok((pricing.match(/<details/g) || []).length >= 4);
  assert.equal(pricing.includes("solana"), false);

  // Home: hero, how it works, register, key handover, books.
  for (const id of ["register-form", "how", "register", "books", "books-form", "books-key", "books-empty", "books-idle", "recipient-id", "api-key", "quote-total", "agent-instructions"]) {
    assert.match(home, new RegExp(`id="${id}"`), id);
  }
  assert.match(home, /href="\/pricing"/);
  assert.match(home, /href="\/docs"/);
  assert.match(home, /href="\/docs#demo"/);
  assert.match(home, /Shown once/);
  assert.equal(home.includes("No buyer wallet integration"), false);
  assert.match(home, /id="not-live"/);
  assert.ok(home.indexOf('id="not-live"') < home.indexOf('id="how"'), "the not-live note is in the hero");
  assert.match(home, /Payments don't run on microdrip\.xyz: the hosted service isn't deployed and its platform address is unset/);
  assert.match(home, /id="buyer-needs"/);
  assert.match(home, /A Microdrip API key/);
  assert.match(home, /A funded Base USDC wallet that can sign/);
  assert.match(home, /\/pay-agent<\/code> skill/);
  assert.match(home, /Coinbase connector support is planned/);
  assert.match(home, /href="\/docs#buyer-setup"/);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.equal(readme.includes("Buyers do not need an account"), false);
  assert.match(readme, /Microdrip API key, a funded Base USDC wallet that can sign/);
  assert.match(readme, /not live on microdrip\.xyz yet/);

  assert.match(brand, /#15b3ad/);
  assert.match(brand, /#33363c/);
  assert.match(brand, /#8d8f90/);
  for (const page of [home, pricing, docs]) {
    assert.match(page, /href="\/brand\.css"/);
    assert.match(page, /src="\/mark\.png"/);
    assert.match(page, /href="\/favicon\.jpg"/);
    assert.match(page, /Microdrip/);
    assert.match(page, /Agent payments/);
    assert.equal(page.includes("Iowan"), false);
    assert.equal(page.includes("#f4f0e6"), false);
    assert.equal(/<style\b/i.test(page), false);
  }
});

test("the demo script is self-contained and never calls the network", () => {
  const demo = fs.readFileSync(demoPath, "utf8");
  for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "import(", "localStorage"]) {
    assert.equal(demo.includes(banned), false, `demo.js uses ${banned}`);
  }
  assert.match(demo, /Simulated, no funds move/);
  assert.match(demo, /\* 5n\) \/ 100n/);
  assert.match(demo, /MINIMUM_ATOMIC = 100000n/);
  assert.match(demo, /prefers-reduced-motion/);
  assert.equal(/Approve|Decline|walletAtomic/.test(demo), false, "the demo has no approval step and no made-up buyer balance");
  assert.match(demo, /Under the hood/);
  assert.ok(fs.statSync(demoCssPath).size > 0);
  assert.ok(fs.statSync(uiPath).size > 0);
  assert.ok(meetsMinimum(DEMO_PRICE));
});

test("the running service serves the docs, the demo and the shared script", async () => {
  const bodies = [];
  for (const pass of [1, 2]) {
    const server = await start();
    try {
      const home = await (await fetch(`${server.origin}/`)).text();
      assert.match(home, /href="\/docs"/);
      const docsResponse = await fetch(`${server.origin}/docs`);
      assert.equal(docsResponse.status, 200);
      const docs = await docsResponse.text();
      assert.equal(docs.includes("{{resourcePath}}"), false);
      assert.match(docs, /<h3>\/v1\/resource<\/h3>/);
      for (const [asset, type] of [["/demo.js", /text\/javascript/], ["/demo.css", /text\/css/], ["/ui.js", /text\/javascript/], ["/brand.css", /text\/css/], ["/mark.png", /image\/png/], ["/favicon.jpg", /image\/jpeg/]]) {
        const response = await fetch(`${server.origin}${asset}`);
        assert.equal(response.status, 200, asset);
        assert.match(response.headers.get("content-type") ?? "", type, asset);
        await response.arrayBuffer();
      }
      bodies.push(docs);
      writeScratch(`docs-${pass}.html`, docs);
    } finally {
      await server.stop();
    }
  }
  assert.equal(bodies[0], bodies[1]);
});

async function demoState(page) {
  return page.$eval(".gd", (node) => node.getAttribute("data-state"));
}

async function sellerBooks(page) {
  return page.$eval('[data-balance="data"]', (node) => ({
    label: node.querySelector(".gd-balance-kind").textContent,
    value: node.querySelector("[data-value]").textContent,
    delta: node.querySelector("[data-delta]").textContent,
  }));
}

async function chat(page) {
  return page.$$eval(".gd-log .gd-msg:not(.gd-typing)", (nodes) => nodes.map((node) => ({
    from: node.getAttribute("data-from"),
    text: node.querySelector(".gd-bubble").textContent,
  })));
}

async function decoded(page, id) {
  return JSON.parse(await page.$eval(`[data-decoded="${id}"]`, (node) => node.textContent));
}

async function rawHeader(page, name) {
  return page.$eval(`[data-header="${name}"]`, (node) => node.getAttribute("data-value"));
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, `${label} overflows horizontally`);
}

// Centre the target first so the sticky header and docs nav never cover it, then click.
async function press(page, selector) {
  await page.$eval(selector, (node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.click(selector);
}

// WCAG relative luminance contrast between two computed "rgb(...)" colours.
function contrast(a, b) {
  const lum = (rgb) => {
    const [r, g, b2] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The demo uses Grok Bot's dark chat style; the page around it keeps the light teal brand.
async function checkDarkTheme(page) {
  const look = await page.evaluate(() => {
    const css = (selector, prop) => getComputedStyle(document.querySelector(selector))[prop];
    return {
      gd: css(".gd", "backgroundColor"),
      gdText: css(".gd", "color"),
      font: css(".gd", "fontFamily"),
      body: css("body", "backgroundColor"),
      bodyFont: css("body", "fontFamily"),
      them: css('.gd-msg[data-from="data"] .gd-bubble', "backgroundColor"),
      themText: css('.gd-msg[data-from="data"] .gd-bubble', "color"),
      me: css('.gd-msg[data-from="research"] .gd-bubble', "backgroundColor"),
      meText: css('.gd-msg[data-from="research"] .gd-bubble', "color"),
      meSide: document.querySelector('.gd-msg[data-from="research"]').getBoundingClientRect().right,
      themSide: document.querySelector('.gd-msg[data-from="data"]').getBoundingClientRect().left,
      logBox: (({ left, right }) => ({ left, right }))(document.querySelector(".gd-log").getBoundingClientRect()),
      soft: css(".gd-pane-title span", "color"),
      composer: css(".gd-composer", "backgroundColor"),
      run: css(".gd-run", "backgroundColor"),
      runText: css(".gd-run", "color"),
      sim: css(".gd-sim", "color"),
      bar: css(".gd-titlebar", "backgroundColor"),
      name: document.querySelector(".gd-titlebar").textContent,
    };
  });
  const channels = (rgb) => rgb.match(/\d+/g).slice(0, 3).map(Number);
  assert.ok(Math.max(...channels(look.gd)) <= 20, `demo background is near-black, got ${look.gd}`);
  assert.ok(Math.max(...channels(look.bar)) <= 30, `top bar is dark, got ${look.bar}`);
  assert.ok(Math.max(...channels(look.composer)) <= 30, `input bar is dark, got ${look.composer}`);
  assert.ok(Math.min(...channels(look.body)) >= 240, `page stays light, got ${look.body}`);
  assert.match(look.font, /^system-ui/);
  assert.notEqual(look.bodyFont, look.font);
  assert.match(look.name, /Grok Bot/);
  // Bot bubbles dark grey, user bubbles a little lighter and on the right.
  const [them, me] = [channels(look.them)[0], channels(look.me)[0]];
  assert.ok(them > channels(look.gd)[0] && me > them && me <= 64, `bubble greys: bot ${look.them}, user ${look.me}`);
  assert.ok(look.logBox.right - look.meSide < 40, "user bubbles sit on the right");
  assert.ok(look.themSide - look.logBox.left < 40, "bot bubbles sit on the left");
  for (const [fg, bg, what] of [
    [look.gdText, look.gd, "body text"],
    [look.themText, look.them, "bot bubble"],
    [look.meText, look.me, "user bubble"],
    [look.soft, look.gd, "secondary text"],
    [look.runText, look.run, "Run button"],
    [look.sim, look.bar, "simulated label"],
  ]) assert.ok(contrast(fg, bg) >= 4.5, `${what} contrast ${contrast(fg, bg).toFixed(2)} is below 4.5:1`);
}

async function walkDemo(page, label) {
  await page.waitForSelector('.gd[data-state="intro"]');
  await noOverflow(page, `${label} intro`);
  await checkDarkTheme(page);
  assert.match(await page.$eval(".gd-sim", (node) => node.textContent), /Simulated, no funds move/);
  assert.match(await page.$eval(".gd-composer", (node) => node.textContent), /\/pay-agent/);
  assert.match(await page.$eval('[data-action="send"]', (node) => node.textContent), /^Run$/);
  // No approval step and no buyer balance anywhere; the seller figure is /v1/books credited.
  assert.equal(await page.$$eval('[data-action="approve"], [data-action="decline"], [data-balance="research"]', (nodes) => nodes.length), 0);
  assert.equal(/Approve|Decline/.test(await page.$eval(".gd", (node) => node.textContent)), false);
  assert.deepEqual(await sellerBooks(page), { label: "/v1/books credited", value: "$0.00", delta: "creditedAtomic 0 \u00b7 settledCount 0" });
  assert.equal(await page.$$eval(".gd-http, .gd-card", (nodes) => nodes.length), 0);
  // Under the hood starts closed.
  assert.equal(await page.$eval(".gd-hood", (node) => node.hidden), true);
  assert.equal(await page.$eval('[data-action="hood"]', (node) => node.getAttribute("aria-expanded")), "false");

  // One press runs the whole scripted exchange: the bot signs and pays on its own.
  await press(page, '[data-action="send"]');
  await page.waitForSelector('.gd[data-state="done"]', { timeout: 20000 });
  await noOverflow(page, `${label} done`);

  // The main view is the plain conversation.
  assert.equal(await page.$$eval(".gd-log .gd-card, .gd-log .gd-http, .gd-log button:not(.gd-link)", (nodes) => nodes.length), 0);
  const messages = await chat(page);
  const research = messages.filter((m) => m.from === "research").map((m) => m.text).join("\n");
  const data = messages.filter((m) => m.from === "data").map((m) => m.text).join("\n");
  assert.match(research, /Quote: \$0\.50 to Data bot plus the \$0\.025 Microdrip fee, \$0\.525 USDC on Base\./);
  assert.match(research, /Paying \$0\.525 via Microdrip\./);
  assert.match(research, /Settled, tx 0x[0-9a-f]{4}\u2026[0-9a-f]{4}\./);
  assert.match(data, /Here's the file\./);
  assert.ok(messages.findIndex((m) => /Paying/.test(m.text)) < messages.findIndex((m) => /Settled/.test(m.text)));
  assert.ok(messages.findIndex((m) => /Settled/.test(m.text)) < messages.findIndex((m) => /Here's the file/.test(m.text)));
  assert.match(await page.$eval(".gd-end", (node) => node.textContent), /Payment complete\./);

  // The details live under the hood: hidden until opened.
  assert.equal(await page.$eval('[data-http="challenge"]', (node) => node.getBoundingClientRect().height), 0);
  await press(page, '[data-action="hood"]');
  assert.equal(await page.$eval('[data-action="hood"]', (node) => node.getAttribute("aria-pressed")), "true");
  assert.equal(await page.$eval('[data-action="hood"]', (node) => node.getAttribute("aria-expanded")), "true");
  assert.equal(await page.$eval(".gd-hood", (node) => node.hidden), false);
  assert.ok(await page.$eval('[data-http="challenge"]', (node) => node.getBoundingClientRect().height) > 100);
  await noOverflow(page, `${label} under the hood`);
  assert.equal(await page.$$eval(".gd-hood [data-card], .gd-hood .gd-http", (nodes) => nodes.length), 5);

  const fields = await page.$$eval("[data-card=payment] [data-field]", (nodes) => Object.fromEntries(nodes.map((node) => [node.getAttribute("data-field"), node.textContent])));
  assert.deepEqual(fields, {
    price: usd(DEMO_PRICE),
    fee: usd(feeFor(DEMO_PRICE)),
    total: usd(quotedFor(DEMO_PRICE)),
  });
  assert.deepEqual(fields, { price: "$0.50", fee: "$0.025", total: "$0.525" });
  assert.deepEqual(await page.$$eval("[data-card=payment] [data-step]", (nodes) => nodes.map((node) => node.getAttribute("data-status"))), ["done", "done"]);

  const challenge = await decoded(page, "payment-required");
  assert.deepEqual(decodeBase64Json(await rawHeader(page, "payment-required")), challenge);
  const accept = challenge.accepts[0];
  const expected = paymentRequired(
    { baseAddress: accept.payTo, priceAtomic: DEMO_PRICE },
    { maxTimeoutSeconds: 300, platformBaseAddress: accept.extra.feePayTo },
    "http://127.0.0.1:4020/v1/payments",
    UNPAID,
  );
  assert.deepEqual(challenge, expected);
  assert.match(accept.payTo, /^0x[0-9a-f]{40}$/);
  assert.match(accept.extra.feePayTo, /^0x[0-9a-f]{40}$/);
  assert.match(await page.$eval('[data-http="challenge"] .gd-http-req', (node) => node.textContent), /^POST \/v1\/payments/);
  assert.match(await page.$eval('[data-http="challenge"] .gd-http-res', (node) => node.textContent), /HTTP\/1\.1 402 Payment Required/);

  assert.equal(await page.$eval('[data-card="receipt"] [data-field="paid"]', (node) => node.firstChild.textContent), "$0.525");
  assert.deepEqual(await sellerBooks(page), { label: "/v1/books credited", value: "$0.50", delta: "creditedAtomic 500000 \u00b7 settledCount 1" });

  // The retry carries two EIP-3009 authorizations in the real shape. The real
  // verifier accepts every field and only rejects the made-up signature.
  const payment = await decoded(page, "payment-signature");
  assert.deepEqual(decodeBase64Json(await rawHeader(page, "payment-signature")), payment);
  assert.equal(payment.x402Version, 2);
  assert.deepEqual(payment.accepted, accept);
  const { authorization, feeAuthorization, signature, feeSignature } = payment.payload;
  assert.equal(authorization.to, accept.payTo);
  assert.equal(authorization.value, DEMO_PRICE);
  assert.equal(feeAuthorization.to, accept.extra.feePayTo);
  assert.equal(feeAuthorization.value, accept.extra.feeAmount);
  assert.equal(feeAuthorization.from, authorization.from);
  assert.notEqual(feeAuthorization.nonce, authorization.nonce);
  for (const nonce of [authorization.nonce, feeAuthorization.nonce]) assert.match(nonce, /^0x[0-9a-f]{64}$/);
  for (const sig of [signature, feeSignature]) assert.match(sig, /^0x[0-9a-f]{130}$/);
  const verdict = verifyBasePayment(
    payment,
    { baseAddress: accept.payTo, priceAtomic: DEMO_PRICE, platformBaseAddress: accept.extra.feePayTo },
    Math.floor(Date.now() / 1000),
    () => false,
  );
  assert.deepEqual(verdict, { ok: false, reason: "bad_signature" });

  const receipt = await decoded(page, "payment-response");
  assert.deepEqual(decodeBase64Json(await rawHeader(page, "payment-response")), receipt);
  assert.deepEqual(Object.keys(receipt), ["success", "transaction", "feeTransaction", "network", "payer", "amount"]);
  assert.equal(receipt.success, true);
  assert.match(receipt.transaction, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.feeTransaction, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.network, "eip155:8453");
  assert.equal(receipt.payer, authorization.from);
  assert.equal(receipt.amount, quotedFor(DEMO_PRICE).toString());
  assert.match(await page.$eval('[data-http="settle"] .gd-http-res', (node) => node.textContent), /"settled":true,"amount":"500000","network":"eip155:8453","recipient":"[0-9a-f]{32}"/);
  // The chat's "Settled, tx" line quotes the receipt's payee transaction.
  assert.match(research, new RegExp(`Settled, tx ${receipt.transaction.slice(0, 6)}\u2026${receipt.transaction.slice(-4)}\\.`));

  const books = await decoded(page, "books");
  assert.equal(books.creditedAtomic, DEMO_PRICE);
  assert.equal(books.feeAtomic, feeFor(DEMO_PRICE).toString());
  assert.equal(books.settledCount, 1);
  assert.deepEqual(Object.keys(books), ["creditedAtomic", "feeAtomic", "settledCount", "priceAtomic", "costAtomic"]);
  assert.ok(BigInt(books.priceAtomic) > BigInt(books.costAtomic));

  // Replay resets the chat and the panel; the panel stays open.
  await press(page, '.gd-pane-actions [data-action="replay"]');
  await page.waitForSelector('.gd[data-state="intro"]');
  assert.equal(await page.$$eval(".gd-card, .gd-http", (nodes) => nodes.length), 0);
  assert.equal((await sellerBooks(page)).value, "$0.00");
  assert.equal(await page.$eval("[data-hood-empty]", (node) => node.hidden), false);
  assert.equal(await page.$eval(".gd-hood", (node) => node.hidden), false);

  // Replay from the end-of-run link too.
  await press(page, '[data-action="send"]');
  await page.waitForSelector(".gd-end", { timeout: 20000 });
  await press(page, '.gd-end [data-action="replay"]');
  await page.waitForSelector('.gd[data-state="intro"]');
  await press(page, '[data-action="hood"]');
  assert.equal(await page.$eval(".gd-hood", (node) => node.hidden), true);
}

test("the docs demo pays Data bot with the real shapes on desktop and phone", async () => {
  const chromePath = requireChrome();
  const server = await start();
  let browser;
  try {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    if (scratch) fs.mkdirSync(scratch, { recursive: true });
    const runs = [
      { label: "desktop", viewport: { width: 1280, height: 800 }, motion: "no-preference" },
      { label: "mobile", viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, motion: "reduce" },
      { label: "desktop reduced motion", viewport: { width: 1280, height: 800 }, motion: "reduce" },
    ];
    for (const run of runs) {
      const page = await browser.newPage();
      const errors = [];
      const requests = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("request", (request) => requests.push(request.url()));
      await page.setViewport(run.viewport);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: run.motion }]);
      await page.goto(`${server.origin}/docs`, { waitUntil: "networkidle0" });
      const loaded = requests.length;
      await walkDemo(page, run.label);
      assert.equal(errors.length, 0, errors.join("\n"));
      const late = requests.slice(loaded).filter((url) => new URL(url).pathname !== "/favicon.jpg");
      assert.deepEqual(late, [], `the demo made requests:\n${late.join("\n")}`);
      for (const url of requests) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, server.origin, url);
        assert.ok(["/docs", "/brand.css", "/demo.css", "/ui.js", "/demo.js", "/mark.png", "/favicon.jpg"].includes(parsed.pathname), url);
      }
      if (scratch) await page.screenshot({ path: path.join(scratch, `docs-${run.label.replace(/\s+/g, "-")}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
});

test("home, docs and pricing fit desktop and phone widths", async () => {
  const chromePath = requireChrome();
  const server = await start();
  let browser;
  try {
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844, isMobile: true }, { width: 320, height: 640, isMobile: true }]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.setViewport(viewport);
      for (const pathname of ["/", "/docs", "/pricing"]) {
        await page.goto(`${server.origin}${pathname}`, { waitUntil: "networkidle0" });
        await noOverflow(page, `${pathname} at ${viewport.width}px`);
        const mark = await page.$eval("img.mark", (node) => ({ width: node.clientWidth, height: node.clientHeight }));
        assert.ok(mark.width > 0 && mark.height > 0, pathname);
        const nav = await page.$$eval(".site-nav a", (nodes) => nodes.filter((node) => node.getBoundingClientRect().width > 0).map((node) => node.getAttribute("href")));
        for (const href of ["/", "/docs", "/pricing"]) assert.ok(nav.includes(href), `${pathname} nav is missing ${href}`);
      }
      assert.equal(errors.length, 0, errors.join("\n"));
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
});
