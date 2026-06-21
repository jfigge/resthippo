/* Rest Hippo website — feature-request list.
 *
 * Reads open feature requests straight from the public GitHub Issues API (no
 * auth, CORS-enabled) and renders them most-upvoted first. Progressive
 * enhancement: if the fetch fails or is rate-limited, the static "View on
 * GitHub" fallback already in features.html is left in place. A short-lived
 * localStorage cache keeps repeat visits under GitHub's 60 req/hr/IP
 * unauthenticated limit. Submitting is handled entirely by GitHub — the
 * "Request a Feature" button deep-links to the new-issue form, where the user
 * signs into their own account. */
(function () {
  "use strict";

  var REPO = "jfigge/resthippo";
  var LABEL = "enhancement";
  var API =
    "https://api.github.com/repos/" + REPO + "/issues" +
    "?state=open&labels=" + LABEL + "&per_page=100&sort=created&direction=desc";
  var ISSUES_URL = "https://github.com/" + REPO + "/issues?q=is%3Aissue+label%3A" + LABEL;
  var CACHE_KEY = "rh-feature-requests-v1";
  var TTL_MS = 10 * 60 * 1000; // 10 minutes

  var ARROW =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  // Compact "2d ago" style relative time.
  function relTime(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return plural(m, "minute", "minutes") + " ago";
    var h = Math.floor(m / 60);
    if (h < 24) return plural(h, "hour", "hours") + " ago";
    var d = Math.floor(h / 24);
    if (d < 30) return plural(d, "day", "days") + " ago";
    var mo = Math.floor(d / 30);
    if (mo < 12) return plural(mo, "month", "months") + " ago";
    return plural(Math.floor(mo / 12), "year", "years") + " ago";
  }

  function thumbsUp(issue) {
    return (issue.reactions && issue.reactions["+1"]) || 0;
  }

  // Drop a leading "[Feature] " / "[Feature Request] " tag for cleaner display.
  function cleanTitle(title) {
    return (title || "").replace(/^\s*\[feature[^\]]*\]\s*/i, "").trim() || title;
  }

  function row(issue) {
    var a = el(
      '<a class="fr-row">' +
        '<span class="fr-votes"><span class="fr-votes-count"></span><span class="fr-votes-label">votes</span></span>' +
        '<div class="fr-main"><div class="fr-title"></div><div class="fr-meta"></div></div>' +
        '<span class="fr-arrow">' + ARROW + "</span>" +
        "</a>"
    );
    a.href = issue.html_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.querySelector(".fr-votes-count").textContent = thumbsUp(issue);
    a.querySelector(".fr-title").textContent = cleanTitle(issue.title);
    var parts = [plural(issue.comments || 0, "comment", "comments")];
    var when = relTime(issue.created_at);
    if (when) parts.push("opened " + when);
    a.querySelector(".fr-meta").textContent = parts.join(" · ");
    return a;
  }

  function msg(html) {
    var d = document.createElement("div");
    d.className = "fr-msg";
    d.innerHTML = html;
    return d;
  }

  function render(issues) {
    var list = document.getElementById("feature-list");
    if (!list) return;
    // Exclude pull requests (the issues endpoint returns both).
    var items = issues.filter(function (i) { return !i.pull_request; });
    items.sort(function (a, b) {
      var d = thumbsUp(b) - thumbsUp(a);
      if (d) return d;
      d = (b.comments || 0) - (a.comments || 0);
      if (d) return d;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    list.textContent = "";
    if (!items.length) {
      list.appendChild(
        msg(
          "No feature requests yet — be the first! &nbsp;" +
            '<a href="https://github.com/' + REPO + '/issues/new?template=feature_request.yml">Request a feature →</a>'
        )
      );
      return;
    }
    items.forEach(function (i) { list.appendChild(row(i)); });

    var sub = document.getElementById("list-sub");
    if (sub) {
      sub.textContent = plural(items.length, "request", "requests") + " · sorted by most 👍";
    }
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || !Array.isArray(c.issues)) return null;
      return c;
    } catch (e) {
      return null;
    }
  }

  function writeCache(issues) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), issues: issues }));
    } catch (e) {
      /* storage unavailable / full — non-fatal */
    }
  }

  function fail(cached) {
    if (cached && cached.issues.length) {
      render(cached.issues); // stale-but-better-than-nothing
      return;
    }
    var list = document.getElementById("feature-list");
    if (!list) return;
    list.textContent = "";
    list.appendChild(
      msg(
        "Couldn't load requests right now. &nbsp;" +
          '<a href="' + ISSUES_URL + '">View feature requests on GitHub →</a>'
      )
    );
  }

  function init() {
    var cached = readCache();
    if (cached && Date.now() - cached.at < TTL_MS) {
      render(cached.issues); // fresh cache — skip the network
      return;
    }

    fetch(API, { cache: "no-cache", headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("GitHub " + r.status);
        return r.json();
      })
      .then(function (issues) {
        if (!Array.isArray(issues)) throw new Error("bad payload");
        writeCache(issues);
        render(issues);
      })
      .catch(function () {
        fail(cached);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
