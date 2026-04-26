// SAM REALTIME CLIENT
// Subscribes the dashboard to Postgres changes via Supabase Realtime.
// When a task changes anywhere, every open SAM tab updates without polling.
// When a domain event fires, optionally surface a toast.
//
// This file is loaded as a classic <script> from index.html, AFTER
// loadTasks/showToast are defined. It self-bootstraps from /api/realtime-config.

(function () {
  var SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/dist/umd/supabase.min.js";
  var booted = false;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function safeToast(msg, kind) {
    try { if (typeof showToast === "function") showToast(msg, kind || "info"); } catch (e) {}
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn(); }, ms);
    };
  }

  async function boot() {
    if (booted) return;
    booted = true;
    var cfg;
    try {
      var r = await fetch("/api/realtime-config", { cache: "no-store" });
      cfg = await r.json();
    } catch (e) {
      console.warn("[realtime] config fetch failed", e);
      return;
    }
    if (!cfg || !cfg.realtime_enabled) {
      console.log("[realtime] disabled (flag off or env missing). polling stays as-is.");
      return;
    }
    try {
      await loadScript(SUPABASE_CDN);
    } catch (e) {
      console.warn("[realtime] supabase-js load failed", e);
      return;
    }
    // @ts-ignore — UMD global from the CDN
    var sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_publishable_key, {
      realtime: { params: { eventsPerSecond: 5 } }
    });

    var refreshTasks = debounce(function () {
      try { if (typeof loadTasks === "function") loadTasks(); } catch (e) {}
      try { if (typeof updateDashboardTasks === "function") updateDashboardTasks(); } catch (e) {}
    }, 250);

    var tasksChan = sb
      .channel("sam-tasks")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, function (payload) {
        console.log("[realtime] tasks change", payload.eventType, payload.new && payload.new.id);
        refreshTasks();
      })
      .subscribe(function (status) {
        console.log("[realtime] tasks channel:", status);
        if (status === "SUBSCRIBED") {
          window.__samRealtimeOn = true;
          var dot = document.getElementById("rt-dot");
          if (dot) { dot.style.background = "var(--green)"; dot.title = "Realtime: connected"; }
        }
      });

    var eventsChan = sb
      .channel("sam-events")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, function (payload) {
        var row = payload.new || {};
        var t = row.event_type || "event";
        // Only toast for high-signal events. Don't toast every internal mutation.
        if (t === "task.created" || t === "task.completed" || t === "memory.extracted") {
          safeToast("• " + t.replace(/[._]/g, " "), "info");
        }
      })
      .subscribe(function (status) {
        console.log("[realtime] events channel:", status);
      });

    window.__samRealtime = { sb: sb, tasks: tasksChan, events: eventsChan };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
