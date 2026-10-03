/*
 * Microdrip docs demo: a Grok bot style chat where Research bot pays Data bot.
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
    walletAtomic: "5000000",
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
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z M14 3.5V8h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  };

  // ---------- Window ----------
  mount.innerHTML =
    '<div class="gd" data-state="intro">' +
      '<div class="gd-titlebar">' +
        '<span class="gd-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
        '<span class="gd-title">Grok bots</span>' +
        '<span class="gd-sim" data-sim-label>Simulated, no funds move</span>' +
      '</div>' +
      '<div class="gd-body">' +
        '<aside class="gd-side" aria-label="Bots and balances">' +
          '<p class="gd-side-label">Bots</p>' +
          '<ul class="gd-bots">' +
            '<li class="gd-bot" data-bot="research" aria-current="true">' + FACE.research +
              '<span class="gd-bot-text"><span class="gd-bot-name">Research bot</span><span class="gd-bot-sub">Buyer</span></span><span class="gd-online" aria-hidden="true"></span></li>' +
            '<li class="gd-bot" data-bot="data">' + FACE.data +
              '<span class="gd-bot-text"><span class="gd-bot-name">Data bot</span><span class="gd-bot-sub">Seller &middot; ' + esc(usd(DATA.priceAtomic)) + ' per pull</span></span><span class="gd-online" aria-hidden="true"></span></li>' +
          '</ul>' +
          '<p class="gd-side-label">Balances</p>' +
          '<div class="gd-balances">' +
            '<div class="gd-balance" data-balance="research">' +
              '<span class="gd-balance-who">Research bot</span>' +
              '<span class="gd-balance-kind">Simulated wallet</span>' +
              '<span class="gd-balance-value" data-value></span>' +
              '<span class="gd-balance-delta" data-delta></span>' +
            '</div>' +
            '<div class="gd-balance" data-balance="data">' +
              '<span class="gd-balance-who">Data bot</span>' +
              '<span class="gd-balance-kind"><code>/v1/books</code> credited</span>' +
              '<span class="gd-balance-value" data-value></span>' +
              '<span class="gd-balance-delta" data-delta></span>' +
            '</div>' +
          '</div>' +
        '</aside>' +
        '<section class="gd-pane" aria-label="Conversation between Research bot and Data bot">' +
          '<header class="gd-pane-head">' +
            '<span class="gd-stack" aria-hidden="true">' + FACE.research + FACE.data + '</span>' +
            '<span class="gd-pane-title"><strong>Research bot &amp; Data bot</strong><span>Direct messages &middot; paid with Microdrip</span></span>' +
            '<span class="gd-pane-actions">' +
              '<button type="button" class="gd-tool" data-action="raw" aria-pressed="false" aria-label="Raw HTTP">' + ICON.code + '<span>Raw HTTP</span></button>' +
              '<button type="button" class="gd-tool" data-action="replay" aria-label="Replay demo">' + ICON.replay + '<span>Replay</span></button>' +
            '</span>' +
          '</header>' +
          '<div class="gd-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0"></div>' +
          '<form class="gd-composer" data-composer>' +
            '<label class="gd-field"><span class="gd-slash">/pay-agent</span>' +
              '<input type="text" data-composer-input aria-label="Message" readonly></label>' +
            '<button type="submit" class="gd-send" data-action="send" aria-label="Send /pay-agent">' + ICON.send + '</button>' +
          '</form>' +
        '</section>' +
      '</div>' +
    '</div>';

  var root = mount.querySelector(".gd");
  var log = root.querySelector(".gd-log");
  var composer = root.querySelector("[data-composer]");
  var composerInput = root.querySelector("[data-composer-input]");
  var sendButton = root.querySelector('[data-action="send"]');
  var rawButton = root.querySelector('[data-action="raw"]');

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

  function append(html) {
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var node = holder.firstElementChild;
    log.appendChild(node);
    scrollLog();
    return node;
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
    return append(
      '<div class="gd-http" data-http="' + id + '">' +
        '<div class="gd-http-head"><span class="gd-http-tag">HTTP</span><span>' + esc(title) + '</span></div>' +
        (request ? '<pre class="gd-http-req">' + esc(request) + '</pre>' : "") +
        '<pre class="gd-http-res">' + esc(head) + '</pre>' +
        (headerName ? '<span class="gd-http-raw" data-header="' + esc(headerName.toLowerCase()) + '" data-value="' + esc(headerValue) + '" hidden></span>' : "") +
        (decoded ? '<p class="gd-http-label">' + esc(decoded.label) + '</p><pre class="gd-http-json" data-decoded="' + esc(decoded.id) + '">' + esc(pretty(decoded.value)) + '</pre>' : "") +
      '</div>'
    );
  }

  function setBalances(walletAtomic, books, animate) {
    var research = root.querySelector('[data-balance="research"]');
    var data = root.querySelector('[data-balance="data"]');
    research.querySelector("[data-value]").textContent = usd(walletAtomic) + " USDC";
    data.querySelector("[data-value]").textContent = usd(books.creditedAtomic);
    research.querySelector("[data-delta]").textContent = animate ? "\u2212" + usd(QUOTED) + " (price + fee)" : "Starting balance";
    data.querySelector("[data-delta]").textContent = "creditedAtomic " + books.creditedAtomic + " \u00b7 settledCount " + books.settledCount;
    [research, data].forEach(function (node) {
      node.removeAttribute("data-changed");
      if (animate) {
        void node.offsetWidth;
        node.setAttribute("data-changed", "true");
      }
    });
  }

  function paymentCard(accepted) {
    return append(
      '<div class="gd-card gd-card-pay" data-card="payment">' +
        '<div class="gd-card-head"><span class="gd-card-title">Payment request</span><span class="gd-chip">x402 &middot; Base USDC</span></div>' +
        '<div class="gd-card-to">' + FACE.data + '<span><strong>Pay Data bot</strong><span class="gd-mono" title="' + esc(accepted.payTo) + '">payTo ' + esc(short(accepted.payTo)) + '</span></span></div>' +
        '<dl class="gd-lines">' +
          '<dt>Listed price, to Data bot</dt><dd data-field="price">' + esc(usd(AMOUNT)) + '</dd>' +
          '<dt>Microdrip fee (5%), to platform</dt><dd data-field="fee">' + esc(usd(accepted.extra.feeAmount)) + '</dd>' +
          '<dt class="gd-total">Total from your wallet</dt><dd class="gd-total" data-field="total">' + esc(usd(accepted.amount)) + '</dd>' +
        '</dl>' +
        '<p class="gd-fine"><span class="gd-mono">amount ' + esc(accepted.amount) + '</span> atomic USDC &middot; ' + esc(accepted.network) + ' &middot; valid for ' + accepted.maxTimeoutSeconds + 's</p>' +
        '<div class="gd-card-actions" data-actions>' +
          '<button type="button" class="gd-btn gd-btn-primary" data-action="approve">Approve &amp; pay ' + esc(usd(accepted.amount)) + '</button>' +
          '<button type="button" class="gd-btn" data-action="decline">Decline</button>' +
        '</div>' +
      '</div>'
    );
  }

  function receiptCard(receipt) {
    return append(
      '<div class="gd-card gd-card-receipt" data-card="receipt">' +
        '<div class="gd-card-head"><span class="gd-card-title"><span class="gd-ok">' + ICON.check + '</span>Payment settled</span><span class="gd-chip gd-chip-warn">Simulated</span></div>' +
        '<p class="gd-amount" data-field="paid">' + esc(usd(receipt.amount)) + '<span>paid by Research bot</span></p>' +
        '<dl class="gd-lines">' +
          '<dt>To Data bot</dt><dd>' + esc(usd(AMOUNT)) + '</dd>' +
          '<dt>Fee to platform</dt><dd>' + esc(usd(FEE)) + '</dd>' +
          '<dt>transaction</dt><dd class="gd-mono" title="' + esc(receipt.transaction) + '">' + esc(short(receipt.transaction, 8, 6)) + '</dd>' +
          '<dt>feeTransaction</dt><dd class="gd-mono" title="' + esc(receipt.feeTransaction) + '">' + esc(short(receipt.feeTransaction, 8, 6)) + '</dd>' +
          '<dt>payer</dt><dd class="gd-mono" title="' + esc(receipt.payer) + '">' + esc(short(receipt.payer)) + '</dd>' +
          '<dt>network</dt><dd class="gd-mono">' + esc(receipt.network) + '</dd>' +
        '</dl>' +
      '</div>'
    );
  }

  function progress(card) {
    var actions = card.querySelector("[data-actions]");
    actions.outerHTML =
      '<ol class="gd-steps" data-steps>' +
        '<li data-step="sign"><span class="gd-step-icon"></span>Signing 2 EIP-3009 authorizations</li>' +
        '<li data-step="settle"><span class="gd-step-icon"></span>Settling the payee transfer and the fee on Base</li>' +
      '</ol>';
    return card.querySelector("[data-steps]");
  }

  function mark(steps, name, status) {
    var item = steps.querySelector('[data-step="' + name + '"]');
    item.setAttribute("data-status", status);
    item.querySelector(".gd-step-icon").innerHTML = status === "done" ? ICON.check : "";
  }

  function finish(text) {
    composerInput.placeholder = text + " Press Replay to run it again.";
    return system(text + ' <button type="button" class="gd-link" data-action="replay">Replay</button>', "gd-end");
  }

  // ---------- Script ----------
  function reset() {
    run += 1;
    current = exchange(prng(402));
    log.innerHTML = "";
    setState("intro");
    setBalances(RESEARCH.walletAtomic, current.booksBefore, false);
    system("Today", "gd-day");
    system("Raw HTTP is on. Requests and responses appear here as the payment runs.", "gd-raw-only");
    bubble("research", "@Data bot I need your Q3 Base USDC transfer sample for my report. Can you send it?");
    bubble("data", "Sure. It's <strong>" + esc(usd(AMOUNT)) + "</strong> per pull through Microdrip. My recipient id is <code>" + esc(short(DATA.id, 4, 4)) + "</code>.");
    composerInput.value = "Pay Data bot " + usd(AMOUNT) + " \u00b7 recipient " + short(DATA.id, 4, 4);
    composerInput.placeholder = "";
    sendButton.disabled = false;
    composer.removeAttribute("data-disabled");
    log.scrollTop = 0;
  }

  function send() {
    if (root.getAttribute("data-state") !== "intro") return;
    setState("requesting");
    sendButton.disabled = true;
    composer.setAttribute("data-disabled", "true");
    composerInput.value = "";
    composerInput.placeholder = "Waiting for the payment to finish\u2026";
    var challenge = current.challenge;
    var requestText = [
      "POST /v1/payments",
      "Authorization: Bearer " + short(RESEARCH.key, 10, 4),
      "content-type: application/json",
      "",
      JSON.stringify({ recipient: DATA.id, amount: AMOUNT }),
    ].join("\n");
    bubble("research", "<code>/pay-agent</code> Pay Data bot <strong>" + esc(usd(AMOUNT)) + "</strong> (<code>" + esc(AMOUNT) + "</code> atomic USDC).");
    wait(450).then(function () {
      httpBlock("challenge", "POST /v1/payments \u2192 402", requestText, "HTTP/1.1 402 Payment Required",
        "PAYMENT-REQUIRED", encodeHeader(challenge), JSON.stringify({ error: "PAYMENT-SIGNATURE header is required" }),
        { id: "payment-required", label: "PAYMENT-REQUIRED, decoded", value: challenge });
      system("Microdrip answered <strong>402 Payment Required</strong>");
      return wait(500);
    }).then(function () {
      paymentCard(challenge.accepts[0]);
      setState("quote");
      var approve = root.querySelector('[data-action="approve"]');
      if (approve) approve.focus({ preventScroll: true });
    }).catch(ignoreCancel);
  }

  function approve() {
    if (root.getAttribute("data-state") !== "quote") return;
    setState("signing");
    var card = root.querySelector('[data-card="payment"]');
    var steps = progress(card);
    mark(steps, "sign", "active");
    wait(750).then(function () {
      mark(steps, "sign", "done");
      mark(steps, "settle", "active");
      setState("settling");
      return wait(950);
    }).then(function () {
      mark(steps, "settle", "done");
      card.setAttribute("data-status", "approved");
      var signed = current.payment;
      httpBlock("settle", "Retry with PAYMENT-SIGNATURE \u2192 200",
        [
          "POST /v1/payments",
          "Authorization: Bearer " + short(RESEARCH.key, 10, 4),
          "content-type: application/json",
          "PAYMENT-SIGNATURE: " + short(encodeHeader(signed), 28, 8),
          "",
          JSON.stringify({ recipient: DATA.id, amount: AMOUNT }),
        ].join("\n"),
        "HTTP/1.1 200 OK", "PAYMENT-RESPONSE", encodeHeader(current.receipt), JSON.stringify(current.paidBody),
        { id: "payment-signature", label: "PAYMENT-SIGNATURE, decoded (simulated signatures)", value: signed });
      var sigRaw = document.createElement("span");
      sigRaw.className = "gd-http-raw";
      sigRaw.hidden = true;
      sigRaw.setAttribute("data-header", "payment-signature");
      sigRaw.setAttribute("data-value", encodeHeader(signed));
      log.lastElementChild.appendChild(sigRaw);
      var responseLabel = document.createElement("p");
      responseLabel.className = "gd-http-label";
      responseLabel.textContent = "PAYMENT-RESPONSE, decoded";
      var responseJson = document.createElement("pre");
      responseJson.className = "gd-http-json";
      responseJson.setAttribute("data-decoded", "payment-response");
      responseJson.textContent = pretty(current.receipt);
      log.lastElementChild.appendChild(responseLabel);
      log.lastElementChild.appendChild(responseJson);
      receiptCard(current.receipt);
      setState("paid");
      setBalances((BigInt(RESEARCH.walletAtomic) - BigInt(QUOTED)).toString(), current.booksAfter, true);
      httpBlock("books", "Data bot reads GET /v1/books \u2192 200",
        ["GET /v1/books", "Authorization: Bearer " + short(DATA.key, 10, 4)].join("\n"),
        "HTTP/1.1 200 OK", "", "", JSON.stringify(current.booksAfter),
        { id: "books", label: "Data bot's books", value: current.booksAfter });
      return say("data",
        "Payment received. My <code>/v1/books</code> now shows <code>settledCount: " + current.booksAfter.settledCount + "</code>. Here's the file.",
        '<div class="gd-file">' + ICON.file + '<span><strong>base-usdc-transfers-q3.csv</strong><span>Simulated attachment</span></span></div>', 800);
    }).then(function () {
      return say("research", "Got it. Thanks, Data bot!", "", 600);
    }).then(function () {
      finish("Payment complete.");
      setState("done");
    }).catch(ignoreCancel);
  }

  function decline() {
    if (root.getAttribute("data-state") !== "quote") return;
    setState("declined");
    var card = root.querySelector('[data-card="payment"]');
    card.setAttribute("data-status", "declined");
    card.querySelector("[data-actions]").outerHTML = '<p class="gd-declined" data-declined>Declined. Nothing was signed and no funds moved.</p>';
    say("data", "No problem. The quote stands if you change your mind.", "", 700).then(function () {
      finish("Payment declined.");
    }).catch(ignoreCancel);
  }

  function ignoreCancel(error) {
    if (error !== CANCELLED) throw error;
  }

  function toggleRaw() {
    var on = rawButton.getAttribute("aria-pressed") !== "true";
    rawButton.setAttribute("aria-pressed", on ? "true" : "false");
    root.classList.toggle("gd-raw", on);
    scrollLog();
  }

  composer.addEventListener("submit", function (event) {
    event.preventDefault();
    send();
  });
  root.addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button || !root.contains(button)) return;
    var action = button.getAttribute("data-action");
    if (action === "approve") approve();
    else if (action === "decline") decline();
    else if (action === "replay") reset();
    else if (action === "raw") toggleRaw();
  });

  reset();
})();
