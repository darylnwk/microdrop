import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findChrome } from "./chrome.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = path.join(root, "site", "index.html");
const scratch = process.env.X402_SCRATCH || "";
const chromePath = findChrome();

function writeLog(name, text) {
  if (!scratch) return;
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, name), text);
}

function servePage() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const siteRoot = path.dirname(pagePath);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.normalize(path.join(siteRoot, pathname));
    const allowed = file === siteRoot || file.startsWith(siteRoot + path.sep);
    if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = file.endsWith(".png")
      ? "image/png"
      : file.endsWith(".jpg") || file.endsWith(".jpeg")
        ? "image/jpeg"
        : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function assertSourceIsStatic(source) {
  assert.equal(source.includes("import "), false);
  assert.equal(/<script\b/i.test(source), false);
  assert.equal(source.includes("type=\"module\""), false);
  assert.equal(source.includes("require("), false);
  assert.match(source, /data-stage/);
  assert.match(source, /microdrip/i);
  assert.match(source, /coming soon/i);
  assert.equal(source.includes("id=\"register-form\""), false);
  assert.equal(source.includes("register-button"), false);
}

test("coming soon homepage paints at desktop and phone widths", async () => {
  const source = fs.readFileSync(pagePath, "utf8");
  assertSourceIsStatic(source);
  const hosted = await servePage();
  let browser;
  try {
    if (!fs.existsSync(chromePath)) throw new Error(`Chrome is not installed at ${chromePath}`);
    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.default.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    writeLog("browser-failure.txt", error instanceof Error ? error.stack ?? error.message : String(error));
    await hosted.close();
    throw error;
  }

  try {
    for (const run of [1, 2]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const viewports = [
        { name: "desktop", width: 1280, height: 800, shot: `run-${run}-desktop.png` },
        { name: "narrow", width: 390, height: 844, shot: `run-${run}-narrow.png` },
      ];
      for (const viewport of viewports) {
        await page.setViewport({ width: viewport.width, height: viewport.height });
        await page.goto(hosted.origin, { waitUntil: "networkidle0" });
        const seen = await page.evaluate(() => {
          const stage = document.querySelector("[data-stage]");
          const box = stage.getBoundingClientRect();
          const style = getComputedStyle(stage);
          return {
            text: document.body.innerText,
            width: box.width,
            height: box.height,
            vw: window.innerWidth,
            vh: window.innerHeight,
            backgroundImage: style.backgroundImage,
            form: Boolean(document.querySelector("form, #register-form, #base-address")),
          };
        });
        const icon = await page.evaluate(async () => {
          const link = document.querySelector('link[rel="icon"]');
          const href = link.getAttribute("href");
          const response = await fetch(href);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {
            href,
            type: link.getAttribute("type"),
            status: response.status,
            contentType: response.headers.get("content-type"),
            size: bytes.byteLength,
          };
        });
        const faviconPath = path.join(path.dirname(pagePath), "favicon.jpg");
        assert.equal(icon.href, "favicon.jpg");
        assert.equal(icon.type, "image/jpeg");
        assert.equal(icon.status, 200);
        assert.equal(icon.contentType, "image/jpeg");
        assert.equal(icon.size, fs.statSync(faviconPath).size);
        const mark = await page.evaluate(async () => {
          const img = document.querySelector("img.mark");
          const href = img.getAttribute("src");
          const response = await fetch(href);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return {
            href,
            status: response.status,
            contentType: response.headers.get("content-type"),
            size: bytes.byteLength,
            naturalWidth: img.naturalWidth,
          };
        });
        const markPath = path.join(path.dirname(pagePath), "mark.png");
        assert.equal(mark.href, "mark.png");
        assert.equal(mark.status, 200);
        assert.equal(mark.contentType, "image/png");
        assert.equal(mark.size, fs.statSync(markPath).size);
        assert.ok(mark.naturalWidth > 0);
        assert.match(seen.text, /microdrip/i);
        assert.match(seen.text, /coming soon/i);
        assert.match(seen.text, /agent payments/i);
        const lines = await page.evaluate(() => {
          const box = (selector) => {
            const node = document.querySelector(selector);
            const rect = node.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
          };
          return {
            soon: box(".soon"),
            name: box("h1"),
            tag: box(".tag"),
            vh: window.innerHeight,
            vw: window.innerWidth,
          };
        });
        for (const key of ["soon", "name", "tag"]) {
          const line = lines[key];
          assert.ok(line.top >= 0 && line.bottom <= lines.vh + 1, JSON.stringify({ key, line, lines }));
          assert.ok(line.left >= 0 && line.right <= lines.vw + 1, JSON.stringify({ key, line, lines }));
        }
        assert.equal(seen.form, false);
        assert.equal(/base address/i.test(seen.text), false);
        assert.equal(/api key/i.test(seen.text), false);
        assert.ok(seen.width >= seen.vw * 0.9, JSON.stringify(seen));
        assert.ok(seen.height >= seen.vh * 0.9, JSON.stringify(seen));
        assert.match(seen.backgroundImage, /gradient/);
        if (scratch) {
          await page.screenshot({ path: path.join(scratch, viewport.shot) });
        }
        console.log(`run ${run} ${viewport.name} painted ${Math.round(seen.width)}x${Math.round(seen.height)} of ${seen.vw}x${seen.vh}`);
      }
      assert.equal(errors.length, 0, errors.join("\n"));
      await page.close();
    }
  } finally {
    await browser.close();
    await hosted.close();
  }
});
