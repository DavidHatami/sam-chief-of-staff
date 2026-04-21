import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

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
    return;
  }

  const REPO_OWNER = "DavidHatami";
  const REPO_NAME = "sam-ops";
  const FILE_PATH = "backups/sam-data-backup.json";

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

  // ── 2. PUSH TO GITHUB ──
  try {
    // Check if file already exists (need SHA for update)
    let existingSHA: string | null = null;
    try {
      const checkResp = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
        { headers: { Authorization: `Bearer ${GITHUB_PAT}`, "User-Agent": "SAM-Backup" } }
      );
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        existingSHA = checkData.sha;
      }
    } catch (e) { /* file doesn't exist yet — that's fine */ }

    // Create or update the file
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

    const commitBody: Record<string, any> = {
      message: `[SAM BACKUP] ${dateStr} ${timeStr} ET — ${Math.round(backupSize / 1024)} KB — ${backup._meta.stores.filter((s: any) => s.status === "ok").length}/${storeConfigs.length} stores`,
      content: Buffer.from(JSON.stringify(backup, null, 2)).toString("base64"),
      committer: {
        name: "SAM Chief of Staff",
        email: "admin@edupolicy.ai",
      },
    };

    if (existingSHA) {
      commitBody.sha = existingSHA;
    }

    const pushResp = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
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
      const pushData = await pushResp.json();
      const elapsed = Date.now() - startTime;
      console.log(`[BACKUP] SUCCESS — Pushed to sam-ops/${FILE_PATH} — commit: ${pushData.commit?.sha?.substring(0, 7)} — ${elapsed}ms`);
    } else {
      const errText = await pushResp.text();
      console.log(`[BACKUP] GITHUB ERROR: ${pushResp.status} — ${errText.substring(0, 200)}`);
    }
  } catch (e) {
    console.log(`[BACKUP] PUSH FAILED: ${e}`);
  }
};

export const config: Config = {
  schedule: "0 7 * * *", // 7:00 AM UTC = 3:00 AM ET
};
