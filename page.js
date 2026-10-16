/* The control panel's page. Uses the helpers in panel.js (window.OWDPanel). */
(function () {
  "use strict";
  var P = window.OWDPanel;
  var $ = function (id) { return document.getElementById(id); };
  var client = null;
  var channel = { text: "", sha: "" };
  var steering = { sha: "" };
  var lastStatus = null;

  function say(text, bad) {
    var box = $("message");
    box.textContent = text;
    box.className = bad ? "bad" : "";
  }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function link(href, text) {
    var a = el("a", text);
    if (/^https:\/\/github\.com\//.test(href)) a.href = href;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    return a;
  }

  function busy(form, on) {
    Array.prototype.forEach.call(form.querySelectorAll("button"), function (b) { b.disabled = on; });
  }

  function fill(list, items, render, empty) {
    list.textContent = "";
    if (!items.length) { list.appendChild(el("li", empty, "empty")); return; }
    items.forEach(function (item) { list.appendChild(render(item)); });
  }

  function repoUrl(path) { return "https://github.com/" + localStorage.getItem(P.REPO_KEY) + path; }

  function renderLinks() {
    fill($("links"), [["Settings file (channel.toml)", "/blob/main/channel.toml"], ["How to use the bot", "/blob/main/docs/GUIDE.md"],
      ["How it works", "/blob/main/docs/HOW-IT-WORKS.md"], ["Where things stand", "/blob/main/docs/STATUS.md"],
      ["Keys and tokens", "/blob/main/docs/KEYS.md"], ["All runs (Actions)", "/actions"], ["Stored videos (Releases)", "/releases"]],
    function (item) {
      var li = el("li");
      li.appendChild(link(repoUrl(item[1]), item[0]));
      return li;
    }, "");
  }

  // ---------- signing in and out ----------

  function storedToken() {
    return sessionStorage.getItem(P.TOKEN_KEY) || localStorage.getItem(P.TOKEN_KEY) || "";
  }

  function signIn(token, repo, remember) {
    client = P.makeClient(window.fetch.bind(window), repo, token);
    return client.repo().then(function () {
      localStorage.setItem(P.REPO_KEY, repo);
      (remember ? localStorage : sessionStorage).setItem(P.TOKEN_KEY, token);
      $("sign-in").hidden = true;
      $("panel").hidden = false;
      $("sign-out").hidden = false;
      renderLinks();
      return loadAll();
    });
  }

  function signOut() {
    sessionStorage.removeItem(P.TOKEN_KEY);
    localStorage.removeItem(P.TOKEN_KEY);
    client = null;
    $("panel").hidden = true;
    $("sign-out").hidden = true;
    $("sign-in").hidden = false;
    $("token").value = "";
    say("Signed out. The token is gone from this browser.");
  }

  // ---------- loading ----------

  function loadAll() {
    say("Loading…");
    return Promise.all([loadStatus(), loadIssues(), loadRuns(), loadChannel(), loadSteering()])
      .then(function () { say(""); })
      .catch(function (error) { say(error.message, true); });
  }

  function loadStatus() {
    return client.status().then(function (status) {
      lastStatus = status;
      var facts = $("overview");
      facts.textContent = "";
      var add = function (term, value) { facts.appendChild(el("dt", term)); facts.appendChild(el("dd", value)); };
      var next = status.next;
      add("Next video", next ? next.cite + ", chapter " + next.chapter + ": " + next.title : "No chapters left: add a book");
      var day = P.nextVideoDay(status, new Date());
      add("Next video day", day ? P.formatWhen(day, status.schedule.timezone) : "None set");
      add("Posting", status.mode === "auto" ? "Automatic (scheduled on YouTube)" : "You post each video (review mode)");
      add("Stored videos", status.storage.stored + " of at most " + status.storage.max_videos);
      if (status.minutes) {
        var m = status.minutes;
        add("Actions minutes", m.used + (m.budget ? " of " + m.budget : "") + " this month (" + m.month + "); a video takes about "
          + m.per_video + (m.measured ? " (measured)" : " (estimate)"));
      }
      add("Chapters left", status.chapters_left);
      add("Last updated", new Date(status.updated).toLocaleString());
      renderBooks(status);
      updateEstimate();
    }).catch(function () {
      $("overview").textContent = "";
      $("overview").appendChild(el("dd", "No status yet: it appears after the bot's next daily run."));
    });
  }

  function loadIssues() {
    return client.issues().then(function (issues) {
      fill($("needs"), P.attention(issues), function (issue) {
        var li = el("li");
        li.appendChild(link(issue.html_url, issue.title)).className = "grow";
        return li;
      }, "Nothing. All good.");
      fill($("waiting"), P.waitingVideos(issues), renderWaiting, "No videos waiting.");
    });
  }

  function renderWaiting(issue) {
    var li = el("li");
    li.appendChild(link(issue.html_url, issue.title)).className = "grow";
    [["Posted", "completed", "Mark it posted? Its stored copy is deleted a week from now."],
     ["Don't post", "not_planned", "Discard this video? Its stored copy is deleted at the next daily run."]]
      .forEach(function (choice) {
        var button = el("button", choice[0], "small" + (choice[1] === "not_planned" ? " quiet" : ""));
        button.type = "button";
        button.addEventListener("click", function () {
          if (!window.confirm(choice[2])) return;
          button.disabled = true;
          client.closeIssue(issue.number, choice[1]).then(function () {
            say("Done: " + issue.title);
            return loadIssues();
          }).catch(function (error) { say(error.message, true); button.disabled = false; });
        });
        li.appendChild(button);
      });
    return li;
  }

  function loadRuns() {
    return client.runs().then(function (data) {
      fill($("runs"), data.workflow_runs || [], function (run) {
        var li = el("li");
        var state = run.status === "completed" ? (run.conclusion === "success" ? "finished" : run.conclusion) : run.status;
        var minutes = run.run_started_at ? Math.max(1, Math.ceil((new Date(run.updated_at) - new Date(run.run_started_at)) / 60000)) : 0;
        li.appendChild(link(run.html_url, run.name + ": " + state)).className = "grow";
        li.appendChild(el("span", new Date(run.created_at).toLocaleString() + (minutes ? ", about " + minutes + " min" : ""),
          run.conclusion === "failure" ? "bad" : ""));
        return li;
      }, "No runs yet.");
    });
  }

  function loadChannel() {
    return client.file("channel.toml").then(function (file) {
      channel = { text: P.fromBase64(file.content), sha: file.sha };
      var days = P.readDays(channel.text);
      var box = $("days");
      box.textContent = "";
      P.DAYS.forEach(function (day) {
        var label = el("label");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.value = day;
        input.checked = days.indexOf(day) >= 0;
        input.addEventListener("change", updateEstimate);
        label.appendChild(input);
        label.appendChild(document.createTextNode(day));
        box.appendChild(label);
      });
      $("budget").value = P.readSetting(channel.text, "monthly_minutes") || "0";
      updateEstimate();
      if (lastStatus) renderBooks(lastStatus);
    });
  }

  function loadSteering() {
    return Promise.all([
      client.file("steering/instructions.md").then(function (file) {
        steering.sha = file.sha;
        $("instructions").value = P.fromBase64(file.content);
      }),
      client.folder("steering/references").then(function (items) {
        fill($("documents"), (items || []).filter(function (i) { return i.type === "file"; }), function (item) {
          var li = el("li");
          li.appendChild(link(item.html_url, item.name)).className = "grow";
          return li;
        }, "No documents yet.");
      })
    ]);
  }

  // ---------- books, schedule, minutes ----------

  function renderBooks(status) {
    var body = $("books").querySelector("tbody");
    body.textContent = "";
    var counted = {};
    (status.books || []).forEach(function (row) { counted[row.id] = row; });
    var listed = channel.text ? P.listBooks(channel.text) : (status.books || []);
    listed.forEach(function (book) {
      var row = counted[book.id];
      var tr = el("tr");
      tr.appendChild(el("td", book.cite));
      tr.appendChild(el("td", row ? row.made : "–"));
      tr.appendChild(el("td", row ? (row.error ? "can't read it" : row.left) : "counted at the next run"));
      body.appendChild(tr);
    });
  }

  function chosenDays() {
    return Array.prototype.filter.call($("days").querySelectorAll("input"), function (i) { return i.checked; })
      .map(function (i) { return i.value; });
  }

  function updateEstimate() {
    var perVideo = lastStatus && lastStatus.minutes ? lastStatus.minutes.per_video : 120;
    var days = chosenDays();
    $("estimate").textContent = days.length + " video" + (days.length === 1 ? "" : "s") + " a week: about "
      + P.monthlyEstimate(days, perVideo) + " Actions minutes a month (videos about " + perVideo + " minutes each, plus the daily checks).";
  }

  // ---------- forms ----------

  function onSubmit(id, handler) {
    $(id).addEventListener("submit", function (event) {
      event.preventDefault();
      var form = event.target;
      busy(form, true);
      Promise.resolve().then(handler).then(function (text) { if (text) say(text); })
        .catch(function (error) { say(error.message, true); })
        .then(function () { busy(form, false); });
    });
  }

  function wire() {
    $("repo").value = localStorage.getItem(P.REPO_KEY) || P.DEFAULT_REPO;
    $("sign-out").addEventListener("click", signOut);
    $("refresh").addEventListener("click", loadAll);

    onSubmit("sign-in-form", function () {
      var token = $("token").value.trim(), repo = $("repo").value.trim();
      if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Paste the token, and the repository as owner/name.");
      return signIn(token, repo, $("remember").checked);
    });

    onSubmit("make-form", function () {
      return client.dispatch("produce.yml", { angle: $("angle").value.trim() }).then(function () {
        $("angle").value = "";
        return "Started. A \"Ready to post\" issue arrives in about 1 to 2 hours; follow it under Recent runs.";
      });
    });

    onSubmit("steer-form", function () {
      return client.save("steering/instructions.md", P.toBase64($("instructions").value), steering.sha,
        "Steering: instructions updated in the control panel").then(function (result) {
        steering.sha = result.content.sha;
        return "Saved. The next video follows these instructions.";
      });
    });

    onSubmit("upload-form", function () {
      var file = $("document").files[0];
      if (!file) throw new Error("Choose a file first.");
      if (file.size > P.MAX_UPLOAD) throw new Error("That file is over 20 MB: upload it on GitHub instead (steering/references → Add file).");
      var name = P.safeFileName(file.name);
      return file.arrayBuffer().then(function (buffer) {
        return client.save("steering/references/" + name, P.bytesToBase64(new Uint8Array(buffer)), "",
          "Steering: " + name + " added in the control panel");
      }).then(function () {
        $("document").value = "";
        return loadSteering().then(function () { return "Uploaded " + name + ". The next video uses it."; });
      });
    });

    onSubmit("book-form", function () {
      var number = $("gutenberg").value.trim().replace(/^#/, "");
      if (!/^\d+$/.test(number)) throw new Error("The Project Gutenberg number is digits only, like 14209.");
      return client.dispatch("add-book.yml", { gutenberg: number, chapters: $("book-chapters").value.trim(),
        cite: $("book-cite").value.trim() }).then(function () {
        $("gutenberg").value = "";
        return "Adding book " + number + ": about a minute. If its chapters can't be found, an issue tells you why.";
      });
    });

    onSubmit("schedule-form", function () {
      var text = P.setMonthlyMinutes(P.setMakeDays(channel.text, chosenDays()), $("budget").value.trim());
      return client.save("channel.toml", P.toBase64(text), channel.sha,
        "Settings: video days " + chosenDays().join(", ") + ", " + $("budget").value.trim() + " minutes a month (control panel)")
        .then(function (result) {
          channel = { text: text, sha: result.content.sha };
          return "Saved. The bot uses these from its next daily run.";
        });
    });

    var token = storedToken();
    if (token) {
      signIn(token, $("repo").value, !!localStorage.getItem(P.TOKEN_KEY)).catch(function (error) {
        say(error.message, true);
        $("sign-in").hidden = false;
      });
    }
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
