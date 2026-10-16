/* Old Wisdom, Decoded: control panel.
 * A static page with no server: it talks straight to GitHub's API with the owner's own token, which stays
 * in this browser (sessionStorage, or localStorage if "Remember on this device" is ticked). Every piece of
 * text from GitHub is shown with textContent, never parsed as HTML.
 */
(function () {
  "use strict";

  var API = "https://api.github.com";
  var DEFAULT_REPO = "breme-analytics/Youtube-automation";
  var TOKEN_KEY = "owd-panel-token";
  var REPO_KEY = "owd-panel-repo";
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MAX_UPLOAD = 20 * 1024 * 1024;
  var DAILY_CHECK_MINUTES = 2; // the daily checks on days without a video

  // ---------- pure helpers ----------

  function bytesToBase64(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function toBase64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
  }

  function fromBase64(encoded) {
    var binary = atob(String(encoded).replace(/\s/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function readSetting(toml, name) {
    var match = new RegExp("^" + name + "\\s*=\\s*(.+?)\\s*(#.*)?$", "m").exec(toml);
    return match ? match[1] : null;
  }

  function readDays(toml) {
    var raw = readSetting(toml, "make_days");
    return raw ? (raw.match(/"([A-Za-z]+)"/g) || []).map(function (d) { return d.slice(1, 4); }) : [];
  }

  function setMakeDays(toml, days) {
    var clean = DAYS.filter(function (d) { return days.indexOf(d) >= 0; });
    if (!clean.length || clean.length !== days.length) throw new Error("Choose at least one day, from Mon to Sun.");
    if (!/^make_days\s*=.*$/m.test(toml)) throw new Error("channel.toml has no make_days line to change.");
    var line = "make_days = [" + clean.map(function (d) { return '"' + d + '"'; }).join(", ") + "]";
    return toml.replace(/^make_days\s*=.*$/m, line);
  }

  function setMonthlyMinutes(toml, value) {
    var number = Number(value);
    if (!Number.isInteger(number) || number < 0) throw new Error("Minutes must be a whole number, 0 or more.");
    if (!/^monthly_minutes\s*=.*$/m.test(toml)) throw new Error("channel.toml has no monthly_minutes line to change.");
    return toml.replace(/^monthly_minutes\s*=\s*\d+/m, "monthly_minutes = " + number);
  }

  function listBooks(toml) {
    return toml.split(/^\[\[books\]\]\s*$/m).slice(1).map(function (block) {
      block = block.split(/^\[(?!\[books\])/m)[0];
      var get = function (key) { var m = new RegExp("^" + key + '\\s*=\\s*"([^"]*)"', "m").exec(block); return m ? m[1] : ""; };
      return { id: get("id"), cite: get("cite") };
    }).filter(function (book) { return book.id; });
  }

  function hasLabel(issue, names) {
    return (issue.labels || []).some(function (label) { return names.indexOf(label.name || label) >= 0; });
  }

  function waitingVideos(issues) {
    return issues.filter(function (i) { return !i.pull_request && hasLabel(i, ["ready-to-post", "scheduled"]); });
  }

  function attention(issues) {
    return issues.filter(function (i) { return !i.pull_request && hasLabel(i, ["bot-needs", "bot-problem"]); });
  }

  function safeFileName(name) {
    var base = String(name || "").trim();
    if (!base || base.length > 120 || /[\/\\]/.test(base) || base.charAt(0) === "." || !/\.(pdf|docx|txt|md)$/i.test(base)) {
      throw new Error("Use a PDF, Word (.docx), text or Markdown file with a plain name.");
    }
    return base.replace(/\s+/g, "-");
  }

  function monthlyEstimate(days, perVideo) {
    var videoDays = days.length * 52 / 12;
    var otherDays = 365 / 12 - videoDays;
    return Math.round(videoDays * perVideo + otherDays * DAILY_CHECK_MINUTES);
  }

  function nextVideoDay(status, now) {
    var schedule = status.schedule || {};
    var time = String(schedule.run_time_utc || "03:15").split(":");
    for (var offset = 0; offset < 8; offset++) {
      var day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, +time[0], +time[1]));
      var weekday = DAYS[(day.getUTCDay() + 6) % 7];
      if (day > now && (schedule.make_days || []).indexOf(weekday) >= 0) return day;
    }
    return null;
  }

  function formatWhen(date, zone) {
    try {
      return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit",
        minute: "2-digit", timeZone: zone || "UTC", timeZoneName: "short" }).format(date);
    } catch (error) {
      return date.toUTCString();
    }
  }

  // ---------- GitHub's API ----------

  function explain(status, text) {
    if (status === 401) return "GitHub refused the token: it may have expired. Sign out and paste a new one.";
    if (status === 403) return "The token isn't allowed to do that. Check its permissions (docs/GUIDE.md, \"Control panel\").";
    if (status === 404) return "Not found: check the repository name, and that the token can see it.";
    if (status === 409) return "Someone changed that file at the same time. Refresh and try again.";
    if (status === 422) return "GitHub didn't accept that: " + text.slice(0, 160);
    return "GitHub answered " + status + ".";
  }

  function makeClient(fetchImpl, repo, token) {
    function call(method, path, body, accept) {
      var options = { method: method, headers: { Authorization: "Bearer " + token, Accept: accept || "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28" } };
      if (body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      return fetchImpl(API + path, options).then(function (response) {
        if (response.status === 204) return null;
        return response.text().then(function (text) {
          if (!response.ok) throw new Error(explain(response.status, text));
          if (accept && accept.indexOf("raw") >= 0) return text;
          return text ? JSON.parse(text) : null;
        });
      });
    }
    var base = "/repos/" + repo;
    var encodePath = function (path) { return path.split("/").map(encodeURIComponent).join("/"); };
    return {
      repo: function () { return call("GET", base); },
      status: function () {
        return call("GET", base + "/contents/state/status.json", undefined, "application/vnd.github.raw+json").then(JSON.parse);
      },
      issues: function () { return call("GET", base + "/issues?state=open&per_page=100"); },
      closeIssue: function (number, reason) {
        return call("PATCH", base + "/issues/" + number, { state: "closed", state_reason: reason });
      },
      runs: function () { return call("GET", base + "/actions/runs?per_page=8"); },
      dispatch: function (workflow, inputs) {
        return call("POST", base + "/actions/workflows/" + workflow + "/dispatches", { ref: "main", inputs: inputs });
      },
      file: function (path) { return call("GET", base + "/contents/" + encodePath(path)); },
      folder: function (path) { return call("GET", base + "/contents/" + encodePath(path)); },
      save: function (path, base64, sha, message) {
        var body = { message: message, content: base64 };
        if (sha) body.sha = sha;
        return call("PUT", base + "/contents/" + encodePath(path), body);
      }
    };
  }

  var helpers = { toBase64: toBase64, fromBase64: fromBase64, bytesToBase64: bytesToBase64, readSetting: readSetting,
    readDays: readDays, setMakeDays: setMakeDays, setMonthlyMinutes: setMonthlyMinutes, listBooks: listBooks,
    waitingVideos: waitingVideos, attention: attention, safeFileName: safeFileName, monthlyEstimate: monthlyEstimate,
    nextVideoDay: nextVideoDay, formatWhen: formatWhen, makeClient: makeClient, DAYS: DAYS, DEFAULT_REPO: DEFAULT_REPO,
    TOKEN_KEY: TOKEN_KEY, REPO_KEY: REPO_KEY, MAX_UPLOAD: MAX_UPLOAD };

  if (typeof module === "object" && module.exports) module.exports = helpers;
  if (typeof window !== "undefined") window.OWDPanel = helpers;
})();
