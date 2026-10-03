/* Shared page behaviour: copy buttons and the docs sidebar highlight. No network calls. */
(function () {
  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (error) { ok = false; }
    document.body.removeChild(area);
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    }
    return fallbackCopy(text);
  }

  function textFor(button) {
    var selector = button.getAttribute("data-copy-target");
    if (selector) {
      var target = document.querySelector(selector);
      return target ? (target.value !== undefined && target.tagName === "INPUT" ? target.value : target.textContent) : "";
    }
    var block = button.closest(".code");
    var pre = block && block.querySelector("pre");
    return pre ? pre.textContent : "";
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest(".copy-btn");
    if (!button) return;
    var text = (textFor(button) || "").trim();
    if (!text) return;
    var label = button.querySelector("[data-label]") || button;
    var original = label.getAttribute("data-original") || label.textContent;
    label.setAttribute("data-original", original);
    copyText(text).then(function () {
      button.setAttribute("data-copied", "true");
      label.textContent = "Copied";
    }, function () {
      label.textContent = "Press Ctrl+C";
    }).then(function () {
      window.setTimeout(function () {
        button.removeAttribute("data-copied");
        label.textContent = original;
      }, 1600);
    });
  });

  function startDocsNav() {
    var nav = document.querySelector(".docs-nav");
    if (!nav || !("IntersectionObserver" in window)) return;
    var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
    var byId = {};
    links.forEach(function (link) { byId[link.getAttribute("href").slice(1)] = link; });
    var sections = links
      .map(function (link) { return document.getElementById(link.getAttribute("href").slice(1)); })
      .filter(Boolean);
    function mark(id) {
      links.forEach(function (link) { link.removeAttribute("aria-current"); });
      var active = byId[id];
      if (!active) return;
      active.setAttribute("aria-current", "true");
      if (nav.scrollWidth > nav.clientWidth) {
        var left = active.offsetLeft - nav.clientWidth / 2 + active.offsetWidth / 2;
        nav.scrollLeft = Math.max(0, left);
      }
    }
    var visible = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { visible[entry.target.id] = entry.isIntersecting; });
      for (var i = 0; i < sections.length; i += 1) {
        if (visible[sections[i].id]) { mark(sections[i].id); return; }
      }
    }, { rootMargin: "-80px 0px -60% 0px" });
    sections.forEach(function (section) { observer.observe(section); });
    if (sections.length) mark(sections[0].id);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startDocsNav);
  else startDocsNav();
})();
