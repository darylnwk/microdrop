(function () {
  function start() {
    var form = document.getElementById("register-form");
    var error = document.getElementById("form-error");
    var keySection = document.getElementById("key-section");
    var createKey = document.getElementById("create-key");
    var apiKey = document.getElementById("api-key");
    if (!form || !createKey || !error || !keySection || !apiKey) return;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.textContent = "";
      var body = {
        baseAddress: document.getElementById("base-address").value.trim(),
        priceAtomic: document.getElementById("price").value.trim(),
        costAtomic: document.getElementById("cost").value.trim(),
      };
      fetch("/v1/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            error.textContent = payload.error || "Registration failed";
            return;
          }
          keySection.hidden = false;
        });
      }).catch(function () {
        error.textContent = "Registration failed";
      });
    });

    createKey.addEventListener("click", function () {
      error.textContent = "";
      fetch("/v1/keys", {
        method: "POST",
        credentials: "same-origin",
      }).then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            error.textContent = payload.error || "Could not create an API key";
            return;
          }
          apiKey.textContent = payload.apiKey;
        });
      }).catch(function () {
        error.textContent = "Could not create an API key";
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
