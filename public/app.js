(function () {
  var ATOMIC_PER_USDC = 1000000n;
  var MINIMUM_ATOMIC = 100000n;
  var RESOURCE_PATH = "{{resourcePath}}";

  var MESSAGES = {
    base_address_invalid: "That doesn't look like a Base address. Use 0x followed by 40 hex characters.",
    price_invalid: "Enter a price in USDC, for example 0.50. USDC has at most 6 decimal places.",
    cost_invalid: "Enter your cost in USDC, for example 0.10. Use 0 if you have none.",
    session_required: "Your registration session has ended. Register again to create a key.",
    api_key_required: "Paste an API key first.",
    unknown_api_key: "This Microdrip service doesn't recognise that API key.",
    invalid_json: "The request couldn't be read. Refresh the page and try again.",
    body_too_large: "The request was too large. Refresh the page and try again.",
    server_error: "Something went wrong on the server. Try again in a moment.",
    network: "Couldn't reach the Microdrip service. Check that it's running and try again.",
  };

  function readable(code, fallback) {
    if (code && MESSAGES[code]) return MESSAGES[code];
    if (code) return fallback + " (" + code + ")";
    return fallback;
  }

  // "0.5", "$1.25", "3" -> atomic USDC string, or null. No floating point.
  function toAtomic(text) {
    var match = /^\s*\$?\s*(\d{0,12})(?:\.(\d{0,6}))?\s*$/.exec(String(text || ""));
    if (!match || (match[1] === "" && (match[2] === undefined || match[2] === ""))) return null;
    var whole = BigInt(match[1] || "0");
    var frac = BigInt(((match[2] || "") + "000000").slice(0, 6));
    return (whole * ATOMIC_PER_USDC + frac).toString();
  }

  function usd(atomic) {
    var value = BigInt(atomic);
    var negative = value < 0n;
    if (negative) value = -value;
    var whole = (value / ATOMIC_PER_USDC).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var frac = (value % ATOMIC_PER_USDC).toString().padStart(6, "0").replace(/0+$/, "");
    while (frac.length < 2) frac += "0";
    return (negative ? "-$" : "$") + whole + "." + frac;
  }

  function feeFor(atomic) {
    return (BigInt(atomic) * 5n) / 100n;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var node = byId(id);
    if (node) node.textContent = text;
  }

  function setHidden(id, hidden) {
    var node = byId(id);
    if (node) node.hidden = hidden;
  }

  function value(id) {
    var node = byId(id);
    return node ? String(node.value || "").trim() : "";
  }

  function updateQuote() {
    var price = toAtomic(value("price"));
    var cost = toAtomic(value("cost"));
    var warning = "";
    setText("price-atomic", price === null ? (value("price") ? "Use a USDC amount like 0.50" : "Atomic USDC appears here") : "= " + price + " atomic USDC");
    setText("cost-atomic", cost === null ? (value("cost") ? "Use a USDC amount like 0.10" : "Use 0 if you have none") : "= " + cost + " atomic USDC");
    if (price === null) {
      setText("quote-price", "\u2014");
      setText("quote-fee", "\u2014");
      setText("quote-total", "\u2014");
      setText("quote-margin", "\u2014");
    } else {
      var fee = feeFor(price);
      setText("quote-price", usd(price));
      setText("quote-fee", usd(fee));
      setText("quote-total", usd(BigInt(price) + fee));
      setText("quote-margin", cost === null ? "\u2014" : usd(BigInt(price) - BigInt(cost)));
      if (BigInt(price) < MINIMUM_ATOMIC) {
        warning = "Below the $0.10 minimum. Buyers can't pay a listing under $0.10.";
      } else if (cost !== null && BigInt(price) <= BigInt(cost)) {
        warning = "Your price must be above your cost, or Microdrip won't offer buyers a payment challenge.";
      }
    }
    setText("quote-warning", warning);
  }

  function showBearer(apiKey) {
    var origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
    setText("bearer-snippet", [
      "# Ask for a paid response (first answer is a 402 challenge)",
      "curl -i " + origin + RESOURCE_PATH + " \\",
      "  -H \"Authorization: Bearer " + apiKey + "\"",
      "",
      "# Check what you've been credited",
      "curl " + origin + "/v1/books \\",
      "  -H \"Authorization: Bearer " + apiKey + "\"",
    ].join("\n"));
  }

  function showBooks(books) {
    var count = Number(books.settledCount || 0);
    setText("books-credited", usd(books.creditedAtomic || "0"));
    setText("books-count", String(count));
    var fees = byId("books-fees");
    if (fees) fees.textContent = usd(books.feeAtomic || "0");
    var terms = "Listed price " + usd(books.priceAtomic || "0") + " \u00b7 cost " + usd(books.costAtomic || "0");
    setText("books-terms", terms);
    setHidden("books-idle", true);
    setHidden("books-result", false);
    setHidden("books-empty", count !== 0);
  }

  function start() {
    var form = byId("register-form");
    var error = byId("form-error");
    var keySection = byId("key-section");
    var createKey = byId("create-key");
    var apiKey = byId("api-key");
    if (!form || !createKey || !error || !keySection || !apiKey) return;

    ["price", "cost"].forEach(function (id) {
      var input = byId(id);
      if (input) input.addEventListener("input", updateQuote);
    });
    updateQuote();

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.textContent = "";
      var priceAtomic = toAtomic(value("price"));
      var costAtomic = toAtomic(value("cost"));
      if (!/^0x[0-9a-fA-F]{40}$/.test(value("base-address"))) {
        error.textContent = readable("base_address_invalid");
        return Promise.resolve();
      }
      if (priceAtomic === null) {
        error.textContent = readable("price_invalid");
        return Promise.resolve();
      }
      if (costAtomic === null) {
        error.textContent = readable("cost_invalid");
        return Promise.resolve();
      }
      var body = {
        baseAddress: value("base-address"),
        priceAtomic: priceAtomic,
        costAtomic: costAtomic,
      };
      var button = byId("register-button");
      if (button) button.disabled = true;
      return fetch("/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            error.textContent = readable(payload.error, "Registration failed");
            return;
          }
          setText("recipient-id", payload.id || "");
          keySection.hidden = false;
          if (keySection.scrollIntoView) keySection.scrollIntoView({ block: "nearest" });
        });
      }).catch(function () {
        error.textContent = readable("network");
      }).then(function () {
        if (button) button.disabled = false;
      });
    });

    createKey.addEventListener("click", function () {
      error.textContent = "";
      return fetch("/v1/keys", {
        method: "POST",
        credentials: "same-origin",
      }).then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            error.textContent = readable(payload.error, "Could not create an API key");
            return;
          }
          apiKey.textContent = payload.apiKey;
          setHidden("key-output", false);
          createKey.textContent = "Create another key";
          showBearer(payload.apiKey);
          var booksKey = byId("books-key");
          if (booksKey && !booksKey.value) booksKey.value = payload.apiKey;
        });
      }).catch(function () {
        error.textContent = readable("network");
      });
    });

    var booksForm = byId("books-form");
    if (booksForm) {
      booksForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var key = value("books-key");
        setText("books-error", "");
        if (!key) {
          setText("books-error", readable("api_key_required"));
          return Promise.resolve();
        }
        return fetch("/v1/books", {
          headers: { authorization: "Bearer " + key },
          credentials: "same-origin",
        }).then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok) {
              setHidden("books-result", true);
              setHidden("books-idle", false);
              setText("books-error", readable(payload.error, "Could not load books"));
              return;
            }
            showBooks(payload);
          });
        }).catch(function () {
          setText("books-error", readable("network"));
        });
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
