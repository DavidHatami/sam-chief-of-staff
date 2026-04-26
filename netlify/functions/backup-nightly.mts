import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { writeHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM Nightly Backup — Data Insurance
 *
 * Runs at 3:00 AM ET daily (7:00 AM UTC)
 * Reads every Netlify Blob store and pushes to sam-ops GitHub repo
 * Git history = time machine. Every night's backup is a recoverable snapshot.
 *
 * Stores backed up:
 *   - sam-tasks (tasks, sub-tasks, notes)
 *   - sam-instructions (permanent memory)
 *   - sam-projects (project workspaces + knowledge bases)
 *   - email-flags (pinned/flagged emails)
 *   - zoom-processed (processed recording IDs)
 *
 * Target: github.com/DavidHatami/sam-ops/backups/sam-data-backup.json
 * ENV: GITHUB_PAT
 */

export default async (req: Request) => {
  const startTime = Date.now();
  console.log("[BACKUP] Starting nightly backup...");

  const GITHUB_PAT = Netlify.env.get("GITHUB_PAT");
  if (!GITHUB_PAT) {
    console.log("[BACKUP] ERROR: No GITHUB_PAT env var. Cannot push to sam-ops.");
    await writeHeartbeat("backup-nightly", {
      success: false,
      durationMs: Date.now() - startTime,
      error: "GITHUB_PAT env var missing",
    });
    return;
  }

  // Note: backup destinations are inlined inside the pushToRepo() calls below
  // (was previously REPO_OWNER/REPO_NAME constants — removed when going dual-repo).

  // ── 1. READ ALL BLOB STORES ──
  const backup: Record<string, any> = {
    _meta: {
      timestamp: new Date().toISOString(),
      version: "1.0",
      source: "sam-chief-of-staff.netlify.app",
      stores: [],
    },
  };

  const storeConfigs = [
    { name: "sam-tasks", keys: [], listAll: true },
    { name: "sam-instructions", keys: ["all"] },
    { name: "sam-projects", keys: ["index"] },
    { name: "email-flags", keys: ["flags"] },
    { name: "zoom-processed", keys: ["processed-list"] },
  ];

  for (const cfg of storeConfigs) {
    try {
      const store = getStore({ name: cfg.name, consistency: "strong" });
      const storeData: Record<string, any> = {};

      // Stores with listAll=true have keys-by-ID (like tasks) — enumerate then fetch in parallel
      if ((cfg as any).listAll) {
        const listResult = await store.list();
        const allKeys = listResult.blobs.map((b: any) => b.key);
        const values = await Promise.all(allKeys.map((k: string) => store.get(k, { type: "json" }).catch(() => null)));
        allKeys.forEach((k: string, i: number) => { if (values[i] !== null) storeData[k] = values[i]; });
        storeData._keyCount = allKeys.length;
      } else {
        for (const key of cfg.keys) {
          const data = await store.get(key, { type: "json" });
          storeData[key] = data;
        }
      }

      // For sam-projects, also fetch individual project blobs
      if (cfg.name === "sam-projects" && storeData.index && Array.isArray(storeData.index)) {
        const projects: Record<string, any> = {};
        for (const proj of storeData.index) {
          try {
            const projData = await store.get(`proj-${proj.id}`, { type: "json" });
            if (projData) projects[proj.id] = projData;
          } catch (e) { /* skip individual project failures */ }
        }
        storeData._projects = projects;
      }

      backup[cfg.name] = storeData;
      backup._meta.stores.push({
        name: cfg.name,
        keys: Object.keys(storeData),
        status: "ok",
      });

      console.log(`[BACKUP] Read store: ${cfg.name} — ${JSON.stringify(storeData).length} chars`);
    } catch (e) {
      backup[cfg.name] = { error: String(e) };
      backup._meta.stores.push({ name: cfg.name, status: "error", error: String(e) });
      console.log(`[BACKUP] Error reading ${cfg.name}: ${e}`);
    }
  }

  // SAFETY RAIL — refuse to push if zero stores succeeded. Prevents an empty
  // backup from overwriting the last good one (though git history still keeps it).
  const okStoreCount = backup._meta.stores.filter((s: any) => s.status === "ok").length;
  if (okStoreCount === 0) {
    console.log(`[BACKUP] ABORT — every store failed to read. Not overwriting last good backup.`);
    return;
  }

  const backupJson = JSON.stringify(backup, null, 2);
  const backupSize = backupJson.length;
  backup._meta.totalSize = backupSize;
  backup._meta.totalSizeKB = Math.round(backupSize / 1024);

  console.log(`[BACKUP] Total backup: ${Math.round(backupSize / 1024)} KB`);

  // ── 2. PUSH TO BOTH BACKUP REPOS (sam-ops primary, SAM-ops1 mirror) ──
  // Why two repos: redundancy. If one repo gets accidentally deleted or its access
  // is lost, the other survives. Both writes happen in parallel; if EITHER fails
  // we still record the heartbeat as a success so long as the primary worked,
  // but the failure is logged for diagnosis.

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });
  const commitMessage = `[SAM BACKUP] ${dateStr} ${timeStr} ET — ${Math.round(backupSize / 1024)} KB — ${backup._meta.stores.filter((s: any) => s.status === "ok").length}/${storeConfigs.length} stores`;
  const fileContent = Buffer.from(JSON.stringify(backup, null, 2)).toString("base64");

  async function pushToRepo(owner: string, repo: string, path: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
    try {
      // Check if file already exists (need SHA for update)
      let existingSHA: string | null = null;
      try {
        const checkResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers: { Authorization: `Bearer ${GITHUB_PAT}`, "User-Agent": "SAM-Backup" } }
        );
        if (checkResp.ok) {
          const checkData = await checkResp.json();
          existingSHA = checkData.sha;
        }
      } catch { /* file doesn't exist yet — that's fine */ }

      const commitBody: Record<string, any> = {
        message: commitMessage,
        content: fileContent,
        committer: { name: "SAM Chief of Staff", email: "admin@edupolicy.ai" },
      };
      if (existingSHA) commitBody.sha = existingSHA;

      const pushResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${GITHUB_PAT}`,
            "Content-Type": "application/json",
            "User-Agent": "SAM-Backup",
          },
          body: JSON.stringify(commitBody),
        }
      );

      if (pushResp.ok) {
        const data = await pushResp.json();
        return { ok: true, sha: data.commit?.sha?.substring(0, 7) };
      }
      const errText = await pushResp.text();
      return { ok: false, error: `HTTP ${pushResp.status}: ${errText.substring(0, 200)}` };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  try {
    // Push to BOTH repos in parallel
    const [primaryResult, mirrorResult] = await Promise.all([
      pushToRepo("DavidHatami", "sam-ops", "backups/sam-data-backup.json"),
      pushToRepo("DavidHatami", "SAM-ops1", "backups/sam-data-backup.json"),
    ]);

    const elapsed = Date.now() - startTime;

    // Log each independently
    if (primaryResult.ok) {
      console.log(`[BACKUP] PRIMARY ✓ sam-ops — commit ${primaryResult.sha} — ${elapsed}ms`);
    } else {
      console.log(`[BACKUP] PRIMARY ✗ sam-ops failed: ${primaryResult.error}`);
    }
    if (mirrorResult.ok) {
      console.log(`[BACKUP] MIRROR  ✓ SAM-ops1 — commit ${mirrorResult.sha}`);
    } else {
      console.log(`[BACKUP] MIRROR  ✗ SAM-ops1 failed: ${mirrorResult.error}`);
    }

    // Determine overall outcome:
    // - Both ok → green
    // - Primary ok, mirror failed → green but log the mirror failure prominently
    // - Primary failed → alarm (the mirror alone isn't enough; primary is canonical)
    const overallOk = primaryResult.ok;
    const partial = primaryResult.ok && !mirrorResult.ok;

    if (overallOk) {
      // Write status blob (driven off the primary commit info)
      try {
        const statusStore = getStore({ name: "sam-backup-status", consistency: "strong" });
        await statusStore.set("last", JSON.stringify({
          timestamp: new Date().toISOString(),
          commit: primaryResult.sha,
          mirrorCommit: mirrorResult.sha || null,
          mirrorOk: mirrorResult.ok,
          mirrorError: mirrorResult.error || null,
          sizeKB: Math.round(backupSize / 1024),
          stores: backup._meta.stores.length,
          elapsed: elapsed + "ms",
          trigger: "scheduled",
        }));
      } catch (statusErr) {
        console.log(`[BACKUP] Status blob write failed (non-fatal): ${statusErr}`);
      }
      // Heartbeat: success even if mirror failed (primary is what matters)
      await writeHeartbeat("backup-nightly", {
        success: true,
        durationMs: elapsed,
        ...(partial ? { error: `mirror failed but primary ok: ${mirrorResult.error}` } : {}),
      });
    } else {
      // Primary failed — this is an alarm condition
      await writeHeartbeat("backup-nightly", {
        success: false,
        durationMs: elapsed,
        error: `primary push to sam-ops failed: ${primaryResult.error}${mirrorResult.ok ? " (mirror ok)" : ` (mirror also failed: ${mirrorResult.error})`}`,
      });
    }
  } catch (e) {
    console.log(`[BACKUP] PUSH FAILED: ${e}`);
    await writeHeartbeat("backup-nightly", {
      success: false,
      durationMs: Date.now() - startTime,
      error: String(e).substring(0, 300),
    });
  }
};

export const config: Config = {
  schedule: "0 7 * * *", // 7:00 AM UTC = 3:00 AM ET
};

// Schedule re-registration touch: 2026-04-26 — Netlify cron scheduler had stopped firing
// these jobs (4 alarms in cron-watchdog with 'No heartbeat ever recorded'). Manual invokes
// confirmed the function code is healthy. Forcing redeploy to re-register the schedule.
