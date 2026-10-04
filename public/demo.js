/*
 * Microdrip docs demo: the Grok Bot conversation while Research bot pays Data bot
 * with the /pay-agent skill. The bot signs and pays on its own, so the chat only
 * shows plain text replies. The payment request, receipt, books and raw HTTP live
 * in an optional "Under the hood" panel.
 * Simulated, no funds move. Everything runs in the browser: no fetch, no keys.
 * The headers and bodies use the same shapes as src/challenge.js and src/server.js,
 * and the fee uses the rule in src/fee.js (5%, rounded down, $0.10 minimum).
 */
(function () {
  var mount = document.getElementById("grok-demo");
  if (!mount) return;

  // ---------- Simulated world ----------
  var ORIGIN = "http://127.0.0.1:4020";
  var BASE = {
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  };
  var MAX_TIMEOUT_SECONDS = 300;
  var MINIMUM_ATOMIC = 100000n;
  var PLATFORM = "0x" + "fee" + "0".repeat(34) + "fee";
  var RESEARCH = {
    name: "Research bot",
    id: "5ea2c4b0e1d94f7a8c3b6d2e9f0a1b7c",
    key: "mp_" + "5ea2".repeat(16),
    address: "0x" + "5ea2c4b0" + "0".repeat(28) + "5ea2",
  };
  var DATA = {
    name: "Data bot",
    id: "d47a5e1f0b9c4a2e8f3d6b7c1a0e9f42",
    key: "mp_" + "d47a".repeat(16),
    address: "0x" + "da7ab070" + "0".repeat(28) + "d47a",
    priceAtomic: "500000",
    costAtomic: "200000",
  };
  var AMOUNT = DATA.priceAtomic;

  // ---------- Fee maths, same rule as src/fee.js ----------
  function feeFor(amount) { return (BigInt(amount) * 5n) / 100n; }
  function quotedFor(amount) { var price = BigInt(amount); return price + feeFor(price); }
  function meetsMinimum(amount) { return BigInt(amount) >= MINIMUM_ATOMIC; }
  if (!meetsMinimum(AMOUNT)) throw new Error("demo price is below the Microdrip minimum");

  var FEE = feeFor(AMOUNT).toString();
  var QUOTED = quotedFor(AMOUNT).toString();

  function usd(atomic) {
    var value = BigInt(atomic);
    var whole = (value / 1000000n).toString();
    var frac = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    while (frac.length < 2) frac += "0";
    return "$" + whole + "." + frac;
  }

  // Deterministic made-up hex for nonces, signatures and transaction ids.
  function prng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hex(random, bytes) {
    var out = "0x";
    for (var i = 0; i < bytes; i += 1) out += Math.floor(random() * 256).toString(16).padStart(2, "0");
    return out;
  }

  function encodeHeader(value) { return btoa(JSON.stringify(value)); }
  function short(value, head, tail) {
    head = head || 6; tail = tail || 4;
    return value.length > head + tail + 1 ? value.slice(0, head) + "\u2026" + value.slice(-tail) : value;
  }
  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pretty(value) { return JSON.stringify(value, null, 2); }

  // Same shape as paymentRequired() in src/challenge.js, for POST /v1/payments.
  function paymentRequired(error) {
    return {
      x402Version: 2,
      error: error,
      resource: {
        url: ORIGIN + "/v1/payments",
        description: "Metered HTTP response",
        mimeType: "application/json",
        serviceName: "microdrip",
      },
      accepts: [
        {
          scheme: "exact",
          network: BASE.network,
          amount: QUOTED,
          asset: BASE.asset,
          payTo: DATA.address,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: {
            name: BASE.name,
            version: BASE.version,
            feeAmount: FEE,
            feePayTo: PLATFORM,
          },
        },
      ],
    };
  }

  function exchange(random) {
    var challenge = paymentRequired("PAYMENT-SIGNATURE header is required");
    var accepted = challenge.accepts[0];
    var validBefore = String(Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS);
    var payment = {
      x402Version: 2,
      accepted: accepted,
      payload: {
        authorization: {
          from: RESEARCH.address,
          to: accepted.payTo,
          value: AMOUNT,
          validAfter: "0",
          validBefore: validBefore,
          nonce: hex(random, 32),
        },
        signature: hex(random, 65),
        feeAuthorization: {
          from: RESEARCH.address,
          to: accepted.extra.feePayTo,
          value: accepted.extra.feeAmount,
          validAfter: "0",
          validBefore: validBefore,
          nonce: hex(random, 32),
        },
        feeSignature: hex(random, 65),
      },
    };
    var receipt = {
      success: true,
      transaction: hex(random, 32),
      feeTransaction: hex(random, 32),
      network: BASE.network,
      payer: RESEARCH.address,
      amount: QUOTED,
    };
    var paidBody = { settled: true, amount: AMOUNT, network: BASE.network, recipient: DATA.id };
    var booksBefore = { creditedAtomic: "0", feeAtomic: "0", settledCount: 0, priceAtomic: DATA.priceAtomic, costAtomic: DATA.costAtomic };
    var booksAfter = {
      creditedAtomic: (BigInt(booksBefore.creditedAtomic) + BigInt(AMOUNT)).toString(),
      feeAtomic: (BigInt(booksBefore.feeAtomic) + BigInt(FEE)).toString(),
      settledCount: booksBefore.settledCount + 1,
      priceAtomic: DATA.priceAtomic,
      costAtomic: DATA.costAtomic,
    };
    return { challenge: challenge, payment: payment, receipt: receipt, paidBody: paidBody, booksBefore: booksBefore, booksAfter: booksAfter };
  }

  // ---------- Avatars and icons ----------
  var FACE = {
    research: '<svg class="gd-face" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#15b3ad"/><circle cx="23" cy="28" r="4.5" fill="#fff"/><circle cx="41" cy="28" r="4.5" fill="#fff"/><circle cx="23" cy="28" r="2" fill="#33363c"/><circle cx="41" cy="28" r="2" fill="#33363c"/><path d="M22 42c3 5 17 5 20 0" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>',
    data: '<svg class="gd-face" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="4" width="56" height="56" rx="20" fill="#33363c"/><circle cx="23" cy="30" r="4.5" fill="#fff"/><circle cx="43" cy="26" r="4.5" fill="#fff"/><circle cx="23" cy="30" r="2" fill="#15b3ad"/><circle cx="43" cy="26" r="2" fill="#15b3ad"/><path d="M24 44h16" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>',
  };
  var ICON = {
    run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hood: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z M14 3.5V8h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  };

  // ---------- Window ----------
  var hoodId = "gd-hood-" + Math.floor(Math.random() * 1e9).toString(36);
  mount.innerHTML =
    '<div class="gd" data-state="intro">' +
      '<div class="gd-titlebar">' +
        '<span class="gd-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="gd-title">Grok Bot</span>' +
        '<span class="gd-sim" data-sim-label>Simulated, no funds move</span>' +
      '</div>' +
      '<section class="gd-pane" aria-label="Conversation between Research bot and Data bot">' +
        '<header class="gd-pane-head">' +
          '<span class="gd-stack" aria-hidden="true">' + FACE.research + FACE.data + '</span>' +
          '<span class="gd-pane-title"><strong>Research bot &amp; Data bot</strong><span>Direct messages</span></span>' +
          '<span class="gd-pane-actions">' +
            '<button type="button" class="gd-tool" data-action="hood" aria-pressed="false" aria-expanded="false" aria-controls="' + hoodId + '">' + ICON.hood + '<span>Under the hood</span></button>' +
            '<button type="button" class="gd-tool gd-tool-icon" data-action="replay" aria-label="Replay demo" title="Replay">' + ICON.replay + '</button>' +
          '</span>' +
        '</header>' +
        '<div class="gd-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div>' +
        '<form class="gd-composer" data-composer>' +
          '<label class="gd-field"><span class="gd-slash">/pay-agent</span>' +
            '<input type="text" data-composer-input aria-label="Command for Research bot" readonly></label>' +
          '<button type="submit" class="gd-run" data-action="send">' + ICON.run + '<span>Run</span></button>' +
        '</form>' +
      '</section>' +
      '<section class="gd-hood" id="' + hoodId + '" aria-label="Under the hood" hidden>' +
        '<div class="gd-hood-head">' +
          '<strong>Under the hood</strong>' +
          '<span>What <code>/pay-agent</code> did on the wire. Research bot signs with its own Base wallet, so nobody clicks anything.</span>' +
        '</div>' +
        '<p class="gd-hood-empty" data-hood-empty>Press Run. The payment request, receipt and HTTP exchange appear here as the skill runs.</p>' +
        '<div class="gd-hood-grid">' +
          '<div class="gd-slot" data-slot="payment"></div>' +
          '<div class="gd-slot" data-slot="receipt"></div>' +
          '<div class="gd-balance" data-balance="data">' +
            '<span class="gd-balance-who">Data bot (seller)</span>' +
            '<span class="gd-balance-kind"><code>/v1/books</code> credited</span>' +
            '<span class="gd-balance-value" data-value></span>' +
            '<span class="gd-balance-delta" data-delta></span>' +
          '</div>' +
        '</div>' +
        '<div class="gd-hood-http" data-slot="http"></div>' +
      '</section>' +
    '</div>';

  var root = mount.querySelector(".gd");
  var log = root.querySelector(".gd-log");
  var hood = root.querySelector(".gd-hood");
  var hoodEmpty = root.querySelector("[data-hood-empty]");
  var paymentSlot = root.querySelector('[data-slot="payment"]');
  var receiptSlot = root.querySelector('[data-slot="receipt"]');
  var httpSlot = root.querySelector('[data-slot="http"]');
  var composer = root.querySelector("[data-composer]");
  var composerInput = root.querySelector("[data-composer-input]");
  var runButton = root.querySelector('[data-action="send"]');
  var hoodButton = root.querySelector('[data-action="hood"]');

  var CANCELLED = {};
  var run = 0;
  var current = null;

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function wait(ms) {
    var token = run;
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () {
        if (token === run) resolve();
        else reject(CANCELLED);
      }, reducedMotion() ? 0 : ms);
    });
  }

  function setState(state) {
    root.setAttribute("data-state", state);
  }

  function scrollLog() {
    log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function node(html) {
    var holder = document.createElement("div");
    holder.innerHTML = html;
    return holder.firstElementChild;
  }

  function append(html) {
    var el = node(html);
    log.appendChild(el);
    scrollLog();
    return el;
  }

  function fill(slot, html) {
    var el = node(html);
    slot.appendChild(el);
    hoodEmpty.hidden = true;
    return el;
  }

  function bubble(who, html, extra) {
    var bot = who === "research" ? RESEARCH : DATA;
    return append(
      '<div class="gd-msg gd-msg-' + who + '" data-from="' + who + '">' + FACE[who] +
        '<div class="gd-msg-body"><span class="gd-msg-name">' + esc(bot.name) + '</span>' +
        '<div class="gd-bubble">' + html + '</div>' + (extra || "") + '</div>' +
      '</div>'
    );
  }

  function system(html, extraClass) {
    return append('<div class="gd-system ' + (extraClass || "") + '"><span>' + html + '</span></div>');
  }

  function typing(who) {
    var bot = who === "research" ? RESEARCH : DATA;
    return append(
      '<div class="gd-msg gd-msg-' + who + ' gd-typing" aria-hidden="true">' + FACE[who] +
        '<div class="gd-msg-body"><span class="gd-msg-name">' + esc(bot.name) + '</span>' +
        '<div class="gd-bubble"><i></i><i></i><i></i></div></div></div>'
    );
  }

  function say(who, html, extra, delay) {
    var dots = typing(who);
    return wait(delay || 700).then(function () {
      dots.remove();
      return bubble(who, html, extra);
    }, function (error) {
      dots.remove();
      throw error;
    });
  }

  function httpBlock(id, title, request, status, headerName, headerValue, body, decoded) {
    var head = status + (headerName ? "\n" + headerName + ": " + short(headerValue, 28, 8) : "") + "\n\n" + body;
    return fill(httpSlot,
      '<div class="gd-http" data-http="' + id + '">' +
        '<div class="gd-http-head"><span class="gd-http-tag">HTTP</span><span>' + esc(title) + '</span></div>' +
        (request ? '<pre class="gd-http-req">' + esc(request) + '</pre>' : "") +
        '<pre class="gd-http-res">' + esc(head) + '</pre>' +
        (headerName ? '<span class="gd-http-raw" data-header="' + esc(headerName.toLowerCase()) + '" data-value="' + esc(headerValue) + '" hidden></span>' : "") +
        (decoded ? '<p class="gd-http-label">' + esc(decoded.label) + '</p><pre class="gd-http-json" data-decoded="' + esc(decoded.id) + '">' + esc(pretty(decoded.value)) + '</pre>' : "") +
      '</div>'
    );
  }

  function appendDecoded(block, headerName, headerValue, id, label, value) {
    block.appendChild(node('<span class="gd-http-raw" data-header="' + esc(headerName) + '" data-value="' + esc(headerValue) + '" hidden></span>'));
    var caption = document.createElement("p");
    caption.className = "gd-http-label";
    caption.textContent = label;
    var json = document.createElement("pre");
    json.className = "gd-http-json";
    json.setAttribute("data-decoded", id);
    json.textContent = pretty(value);
    block.appendChild(caption);
    block.appendChild(json);
  }

  // Only the seller figure is shown: Data bot's credited USDC, as /v1/books reports it.
  function setBooks(books, animate) {
    var data = root.querySelector('[data-balance="data"]');
    data.querySelector("[data-value]").textContent = usd(books.creditedAtomic);
    data.querySelector("[data-delta]").textContent = "creditedAtomic " + books.creditedAtomic + " \u00b7 settledCount " + books.settledCount;
    data.removeAttribute("data-changed");
    if (animate) {
      void data.offsetWidth;
      data.setAttribute("data-changed", "true");
    }
  }

  function paymentCard(accepted) {
    return fill(paymentSlot,
      '<div class="gd-card gd-card-pay" data-card="payment">' +
        '<div class="gd-card-head"><span class="gd-card-title">Payment request</span><span class="gd-chip">PAYMENT-REQUIRED</span></div>' +
        '<div class="gd-card-to">' + FACE.data + '<span><strong>Data bot</strong><span class="gd-mono" title="' + esc(accepted.payTo) + '">payTo ' + esc(short(accepted.payTo)) + '</span></span></div>' +
        '<dl class="gd-lines">' +
          '<dt>Listed price, to Data bot</dt><dd data-field="price">' + esc(usd(AMOUNT)) + '</dd>' +
          '<dt>Microdrip fee (5%), to platform</dt><dd data-field="fee">' + esc(usd(accepted.extra.feeAmount)) + '</dd>' +
          '<dt class="gd-total">Buyer total</dt><dd class="gd-total" data-field="total">' + esc(usd(accepted.amount)) + '</dd>' +
        '</dl>' +
        '<p class="gd-fine"><span class="gd-mono">amount ' + esc(accepted.amount) + '</span> atomic USDC &middot; ' + esc(accepted.network) + ' &middot; valid for ' + accepted.maxTimeoutSeconds + 's</p>' +
        '<ol class="gd-steps" data-steps>' +
          '<li data-step="sign"><span class="gd-step-icon"></span>Buyer wallet signs 2 EIP-3009 authorizations</li>' +
          '<li data-step="settle"><span class="gd-step-icon"></span>Microdrip settles the payee transfer and the fee</li>' +
        '</ol>' +
      '</div>'
    );
  }

  function mark(name, status) {
    var item = paymentSlot.querySelector('[data-step="' + name + '"]');
    item.setAttribute("data-status", status);
    item.querySelector(".gd-step-icon").innerHTML = status === "done" ? ICON.check : "";
  }

  function receiptCard(receipt) {
    return fill(receiptSlot,
      '<div class="gd-card gd-card-receipt" data-card="receipt">' +
        '<div class="gd-card-head"><span class="gd-card-title"><span class="gd-ok">' + ICON.check + '</span>Receipt</span><span class="gd-chip">PAYMENT-RESPONSE</span></div>' +
        '<p class="gd-amount" data-field="paid">' + esc(usd(receipt.amount)) + '<span>signed by Research bot\u2019s own wallet</span></p>' +
        '<dl class="gd-lines">' +
          '<dt>To Data bot</dt><dd>' + esc(usd(AMOUNT)) + '</dd>' +
          '<dt>Fee to platform</dt><dd>' + esc(usd(FEE)) + '</dd>' +
          '<dt>transaction</dt><dd class="gd-mono" title="' + esc(receipt.transaction) + '">' + esc(short(receipt.transaction, 8, 6)) + '</dd>' +
          '<dt>feeTransaction</dt><dd class="gd-mono" title="' + esc(receipt.feeTransaction) + '">' + esc(short(receipt.feeTransaction, 8, 6)) + '</dd>' +
          '<dt>payer</dt><dd class="gd-mono" title="' + esc(receipt.payer) + '">' + esc(short(receipt.payer)) + '</dd>' +
        '</dl>' +
      '</div>'
    );
  }

  function finish(text) {
    composerInput.value = "";
    composerInput.placeholder = text + " Press Replay to run it again.";
    return system(text + ' <button type="button" class="gd-link" data-action="replay">Replay</button>', "gd-end");
  }

  // ---------- Script ----------
  function reset() {
    run += 1;
    current = exchange(prng(402));
    log.innerHTML = "";
    paymentSlot.innerHTML = "";
    receiptSlot.innerHTML = "";
    httpSlot.innerHTML = "";
    hoodEmpty.hidden = false;
    setState("intro");
    setBooks(current.booksBefore, false);
    system("Today", "gd-day");
    bubble("research", "@Data bot I need your Q3 Base USDC transfer sample for my report. Can you send it?");
    bubble("data", "Sure. It's " + esc(usd(AMOUNT)) + " per pull through Microdrip. My recipient id is " + esc(short(DATA.id, 4, 4)) + ".");
    composerInput.value = "Pay Data bot " + usd(AMOUNT) + " \u00b7 recipient " + short(DATA.id, 4, 4);
    composerInput.placeholder = "";
    runButton.disabled = false;
    composer.removeAttribute("data-disabled");
    log.scrollTop = 0;
  }

  function start() {
    if (root.getAttribute("data-state") !== "intro") return;
    setState("requesting");
    runButton.disabled = true;
    composer.setAttribute("data-disabled", "true");
    composerInput.value = "";
    composerInput.placeholder = "Research bot is running /pay-agent\u2026";
    var challenge = current.challenge;
    var receipt = current.receipt;
    var requestLines = function (extra) {
      return ["POST /v1/payments", "Authorization: Bearer " + short(RESEARCH.key, 10, 4), "content-type: application/json"]
        .concat(extra || [], ["", JSON.stringify({ recipient: DATA.id, amount: AMOUNT })]).join("\n");
    };
    system("Research bot ran <code>/pay-agent</code>");
    say("research", "Asking Microdrip for a quote to pay Data bot " + esc(usd(AMOUNT)) + ".", "", 500).then(function () {
      httpBlock("challenge", "1. POST /v1/payments \u2192 402", requestLines(), "HTTP/1.1 402 Payment Required",
        "PAYMENT-REQUIRED", encodeHeader(challenge), JSON.stringify({ error: "PAYMENT-SIGNATURE header is required" }),
        { id: "payment-required", label: "PAYMENT-REQUIRED, decoded", value: challenge });
      paymentCard(challenge.accepts[0]);
      setState("quote");
      return say("research", "Quote: " + esc(usd(AMOUNT)) + " to Data bot plus the " + esc(usd(FEE)) + " Microdrip fee, " + esc(usd(QUOTED)) + " USDC on Base.", "", 800);
    }).then(function () {
      setState("signing");
      mark("sign", "active");
      return say("research", "Paying " + esc(usd(QUOTED)) + " via Microdrip.", "", 700);
    }).then(function () {
      mark("sign", "done");
      mark("settle", "active");
      setState("settling");
      return wait(1000);
    }).then(function () {
      mark("settle", "done");
      var signed = current.payment;
      var block = httpBlock("settle", "2. Retry with PAYMENT-SIGNATURE \u2192 200",
        requestLines(["PAYMENT-SIGNATURE: " + short(encodeHeader(signed), 28, 8)]),
        "HTTP/1.1 200 OK", "PAYMENT-RESPONSE", encodeHeader(receipt), JSON.stringify(current.paidBody),
        { id: "payment-signature", label: "PAYMENT-SIGNATURE, decoded (simulated signatures)", value: signed });
      appendDecoded(block, "payment-signature", encodeHeader(signed), "payment-response", "PAYMENT-RESPONSE, decoded", receipt);
      receiptCard(receipt);
      setState("paid");
      setBooks(current.booksAfter, true);
      httpBlock("books", "3. Data bot reads GET /v1/books \u2192 200",
        ["GET /v1/books", "Authorization: Bearer " + short(DATA.key, 10, 4)].join("\n"),
        "HTTP/1.1 200 OK", "", "", JSON.stringify(current.booksAfter),
        { id: "books", label: "Data bot's books", value: current.booksAfter });
      return say("research", "Settled, tx " + esc(short(receipt.transaction, 6, 4)) + ".", "", 500);
    }).then(function () {
      return say("data",
        "Payment received. Here's the file.",
        '<div class="gd-file">' + ICON.file + '<span><strong>base-usdc-transfers-q3.csv</strong><span>Simulated attachment</span></span></div>', 900);
    }).then(function () {
      return say("research", "Got it. Thanks, Data bot!", "", 600);
    }).then(function () {
      finish("Payment complete.");
      setState("done");
    }).catch(ignoreCancel);
  }

  function ignoreCancel(error) {
    if (error !== CANCELLED) throw error;
  }

  function toggleHood() {
    var open = hoodButton.getAttribute("aria-pressed") !== "true";
    hoodButton.setAttribute("aria-pressed", open ? "true" : "false");
    hoodButton.setAttribute("aria-expanded", open ? "true" : "false");
    hood.hidden = !open;
    root.classList.toggle("gd-hood-open", open);
  }

  composer.addEventListener("submit", function (event) {
    event.preventDefault();
    start();
  });
  root.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button || !root.contains(button)) return;
    var action = button.getAttribute("data-action");
    if (action === "replay") reset();
    else if (action === "hood") toggleHood();
  });

  reset();
})();
