import fs from "node:fs";

// Browser tests need Chrome. CHROME_PATH wins; otherwise try the usual macOS and Linux paths.
const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? CANDIDATES[0];
}

export function requireChrome() {
  const chromePath = findChrome();
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome is not installed at ${chromePath}. Set CHROME_PATH to a Chrome or Chromium binary.`);
  }
  return chromePath;
}
