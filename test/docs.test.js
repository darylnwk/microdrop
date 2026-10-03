import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";


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

test("the pay-agent skill and the docs page agree", () => {
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

  assert.match(docs, new RegExp(skill.name));
  assert.match(docs, new RegExp(`/${skill.name}`));
  assert.match(docs, /one Grok agent to another/i);
  assert.match(docs, /How the skill works/);
  assert.match(docs, /who pays, who is paid, and the listed price/);
  assert.match(docs, /listed price/);
  assert.match(docs, /buyer total/);
  assert.match(docs, /two authorizations/);
  assert.match(docs, /recipient Base address/);
  assert.match(docs, /fee to the platform/);
  assert.match(docs, /challenge amount unchanged/);
  assert.match(docs, /both transfers settle/);
  assert.match(docs, /\$0\.10/);
  assert.match(docs, /data-step="next"/);
  assert.match(docs, /data-step="back"/);
  assert.equal((docs.match(/data-moment="/g) || []).length, 4);
  assert.match(docs, /class="transcript"/);
  assert.match(docs, /class="composer"/);
  assert.match(docs, /Grok bots/);
  assert.match(docs, /data-bot="ada"/);
  assert.match(docs, /data-bot="nia"/);
  const adaFace = docs.slice(docs.indexOf('data-bot="ada"'), docs.indexOf('data-bot="ada"') + 700);
  const niaFace = docs.slice(docs.indexOf('data-bot="nia"'), docs.indexOf('data-bot="nia"') + 700);
  assert.match(adaFace, /<circle/);
  assert.equal(adaFace.includes("<rect"), false);
  assert.match(niaFace, /<rect/);
  assert.match(docs, /class="speaker">Ada</);
  assert.match(docs, /class="speaker">Nia</);
  const composer = docs.slice(docs.indexOf('class="composer"'));
  assert.match(composer, new RegExp(`/${skill.name}`));
  assert.match(docs, /no challenge/);
  assert.match(docs, /payment stays unavailable/);
  assert.match(docs, /npm start/);
  assert.match(docs, /microdrip\.xyz/);
  assert.equal(/POST\s+\/v1\//.test(docs), false);
  assert.equal(docs.includes("price * 5 / 100"), false);
  assert.equal(docs.includes("105000"), false);
  assert.equal(docs.includes("5000"), false);
  assert.match(docs, /href="\/pricing"/);

  assert.match(pricing, /5% per transaction/);
  assert.match(pricing, /buyer pays the fee/i);
  assert.match(pricing, /payee receives the listed price/i);
  assert.match(pricing, /\$0\.10/);
  assert.equal(pricing.includes("price * 5 / 100"), false);
  assert.equal(pricing.includes("105000"), false);
  assert.equal(pricing.includes("5000"), false);
  assert.equal(pricing.includes("solana"), false);

  assert.match(home, /href="\/pricing"/);
  assert.match(home, /href="\/docs"/);
  assert.match(home, /id="register-form"/);
  assert.match(brand, /#15b3ad/);
  assert.match(brand, /#33363c/);
  assert.match(brand, /#8d8f90/);
  for (const page of [pricing, docs]) {
    assert.match(page, /href="\/brand\.css"/);
    assert.match(page, /src="\/mark\.png"/);
    assert.match(page, /Microdrip/);
    assert.match(page, /Agent payments/);
    assert.equal(page.includes("Iowan"), false);
    assert.equal(page.includes("#f4f0e6"), false);
  }
});

test("the running service serves the same docs page twice", async () => {
  const skill = skillParts(fs.readFileSync(skillPath, "utf8"));
  const bodies = [];
  for (const pass of [1, 2]) {
    const server = await start();
    try {
      const homeResponse = await fetch(`${server.origin}/`);
      assert.equal(homeResponse.status, 200);
      const home = await homeResponse.text();
      assert.match(home, /id="register-form"/);
      const docsLink = home.match(/href="(\/docs)"/);
      assert.ok(docsLink, "home page links to the docs page");
      const docsResponse = await fetch(`${server.origin}${docsLink[1]}`);
      assert.equal(docsResponse.status, 200);
      const docs = await docsResponse.text();
      assert.match(docs, new RegExp(skill.name));
      assert.match(docs, new RegExp(`/${skill.name}`));
      assert.match(docs, /How the skill works/);
      assert.match(docs, /two authorizations/);
      assert.match(docs, /class="transcript"/);
      assert.match(docs, /class="composer"/);
      assert.equal(/POST\s+\/v1\//.test(docs), false);
      assert.match(docs, /src="\/mark\.png"/);
      const mark = await fetch(`${server.origin}/mark.png`);
      assert.equal(mark.status, 200);
      assert.match(mark.headers.get("content-type") ?? "", /image\/png/);
      bodies.push(docs);
      writeScratch(`docs-${pass}.html`, docs);
    } finally {
      await server.stop();
    }
  }
  assert.equal(bodies[0], bodies[1]);
});

const chromePath = process.env.CHROME_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function readMoment(page) {
  return page.evaluate(() => {
    const node = document.querySelector("[data-moment][data-current='true']");
    const mark = document.querySelector("img.mark");
    const avatars = [...document.querySelectorAll("[data-bot] .face")].map((el) => {
      const box = el.getBoundingClientRect();
      return {
        bot: el.closest("[data-bot]").getAttribute("data-bot"),
        width: box.width,
        height: box.height,
      };
    });
    const composer = document.querySelector(".composer");
    return {
      id: node ? node.getAttribute("data-moment") : "",
      text: node ? node.innerText.replace(/\s+/g, " ").trim() : "",
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      markWidth: mark ? mark.clientWidth : 0,
      markHeight: mark ? mark.clientHeight : 0,
      avatars,
      composer: composer ? composer.innerText : "",
      visibleCount: [...document.querySelectorAll("[data-moment]")].filter((el) => el.getBoundingClientRect().height > 0).length,
    };
  });
}

async function walkMoments(page) {
  const forward = [];
  const layouts = [];
  for (let step = 0; step < 6; step += 1) {
    const seen = await readMoment(page);
    forward.push(seen.text);
    layouts.push(seen);
    const disabled = await page.$eval("[data-step='next']", (button) => button.disabled);
    if (disabled) break;
    await page.click("[data-step='next']");
  }
  const back = [];
  for (let step = 0; step < 6; step += 1) {
    const disabled = await page.$eval("[data-step='back']", (button) => button.disabled);
    if (disabled) break;
    await page.click("[data-step='back']");
    const seen = await readMoment(page);
    back.push(seen.text);
    layouts.push(seen);
  }
  return { forward, back, layouts };
}

test("the docs page steps through the same moments twice", async () => {
  if (!fs.existsSync(chromePath)) {
    writeScratch("browser-failure.txt", `Chrome is not installed at ${chromePath}`);
    return;
  }
  const server = await start();
  let browser;
  try {
    const puppeteer = await import("puppeteer-core");
    try {
      browser = await puppeteer.default.launch({
        executablePath: chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    } catch (error) {
      writeScratch("browser-failure.txt", error instanceof Error ? error.stack ?? error.message : String(error));
      return;
    }
    if (scratch) fs.mkdirSync(scratch, { recursive: true });
    const runs = [];
    const viewports = [
      { name: "desktop", width: 1280, height: 800, shot: "docs-desktop.png" },
      { name: "mobile", width: 390, height: 844, shot: "docs-mobile.png" },
    ];
    for (const run of [1, 2]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      for (const viewport of viewports) {
        await page.setViewport({ width: viewport.width, height: viewport.height });
        await page.goto(`${server.origin}/`, { waitUntil: "networkidle0" });
        const href = await page.$eval('a[href="/docs"]', (link) => link.getAttribute("href"));
        assert.equal(href, "/docs");
        await page.goto(`${server.origin}${href}`, { waitUntil: "networkidle0" });
        await page.waitForSelector("[data-step='next']");
        const walked = await walkMoments(page);
        assert.equal(errors.length, 0, errors.join("\n"));
        for (const seen of walked.layouts) {
          assert.equal(seen.overflow, false, JSON.stringify(seen));
          assert.ok(seen.markWidth > 0 && seen.markHeight > 0, JSON.stringify(seen));
          assert.ok(seen.avatars.length >= 2, JSON.stringify(seen.avatars));
          const names = new Set(seen.avatars.map((avatar) => avatar.bot));
          assert.ok(names.size >= 2, JSON.stringify(seen.avatars));
          for (const avatar of seen.avatars) {
            assert.ok(avatar.width > 0 && avatar.height > 0, JSON.stringify(avatar));
          }
          assert.match(seen.composer, /\/pay-agent/);
        }
        assert.equal(walked.forward.length, 4, walked.forward.join("\n---\n"));
        walked.layouts.slice(0, walked.forward.length).forEach((seen, index) => {
          assert.equal(seen.visibleCount, index + 1, JSON.stringify(seen));
        });
        walked.layouts.slice(walked.forward.length).forEach((seen, index) => {
          assert.equal(seen.visibleCount, walked.forward.length - 1 - index, JSON.stringify(seen));
        });
        for (let index = 1; index < walked.forward.length; index += 1) {
          assert.notEqual(walked.forward[index], walked.forward[index - 1]);
        }
        assert.match(walked.forward[0], /who pays, who is paid, and the listed price/);
        assert.equal(/two authorizations/.test(walked.forward[0]), false);
        assert.ok(walked.forward.some((text) => /buyer total/.test(text) && /Base USDC challenge/.test(text)));
        assert.ok(walked.forward.some((text) => /two authorizations/.test(text) && /recipient Base address/.test(text) && /fee to the platform/.test(text) && /challenge amount unchanged/.test(text)));
        assert.ok(walked.forward.some((text) => /both transfers settle/.test(text) && /platform receives the fee/.test(text)));
        assert.deepEqual(walked.back, walked.forward.slice(0, -1).reverse());
        const pageText = await page.evaluate(() => document.body.innerText);
        assert.equal(/POST\s+\/v1\//.test(pageText), false);
        if (scratch && run === 1) {
          await page.click("[data-step='next']");
          await page.click("[data-step='next']");
          const shown = await readMoment(page);
          assert.match(shown.text, /two authorizations/);
          assert.equal(shown.overflow, false);
          await page.screenshot({ path: path.join(scratch, viewport.shot), fullPage: true });
        }
        runs.push({ run, viewport: viewport.name, forward: walked.forward, back: walked.back });
      }
      await page.close();
    }
    const firstDesktop = runs.find((entry) => entry.run === 1 && entry.viewport === "desktop");
    const secondDesktop = runs.find((entry) => entry.run === 2 && entry.viewport === "desktop");
    const firstMobile = runs.find((entry) => entry.run === 1 && entry.viewport === "mobile");
    const secondMobile = runs.find((entry) => entry.run === 2 && entry.viewport === "mobile");
    assert.deepEqual(secondDesktop.forward, firstDesktop.forward);
    assert.deepEqual(secondMobile.forward, firstMobile.forward);
    assert.deepEqual(firstMobile.forward, firstDesktop.forward);
    writeScratch("docs-interact.log", `${JSON.stringify(runs, null, 2)}\n`);
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
});
