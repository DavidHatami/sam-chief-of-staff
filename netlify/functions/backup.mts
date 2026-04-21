import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM On-Demand Backup — Manual trigger
 *
 * POST /api/backup → Run backup immediately, push to sam-ops
 * GET  /api/backup → Check last backup status
 *
 * Same logic as backup-nightly.mts but triggerable via API.
 */

export default async (req: Request, context: Context) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method === "GET") {
    // Return last backup info from a status blob
    try {
      const statusStore = getStore({ name: "sam-backup-status", consistency: "strong" });
      const status = await statusStore.get("last", { type: "json" });
      return new Response(JSON.stringify({ lastBackup: status || null }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ lastBackup: null }), { headers });
    }
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST to run backup, GET for status" }), { status: 405, headers });
  }

  const startTime = Date.now();
  const GITHUB_PAT = Netlify.env.get("GITHUB_PAT");
  if (!GITHUB_PAT) {
    return new Response(JSON.stringify({ error: "No GITHUB_PAT env var" }), { status: 500, headers });
  }

  const REPO_OWNER = "DavidHatami";
  const REPO_NAME = "sam-ops";
  const FILE_PATH = "backups/sam-data-backup.json";

  // Read all stores
  const backup: Record<string, any> = {
    _meta: {
      timestamp: new Date().toISOString(),
      version: "1.0",
      source: "sam-chief-of-staff.netlify.app",
      trigger: "manual",
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
      if (cfg.name === "sam-projects" && storeData.index && Array.isArray(storeData.index)) {
        const projects: Record<string, any> = {};
        for (const proj of storeData.index) {
          try {
            const projData = await store.get(`proj-${proj.id}`, { type: "json" });
            if (projData) projects[proj.id] = projData;
          } catch (e) {}
        }
        storeData._projects = projects;
      }
      backup[cfg.name] = storeData;
      backup._meta.stores.push({ name: cfg.name, status: "ok" });
    } catch (e) {
      backup[cfg.name] = { error: String(e) };
      backup._meta.stores.push({ name: cfg.name, status: "error", error: String(e) });
    }
  }

  // SAFETY RAIL — refuse to push if zero stores succeeded
  const okStoreCount = backup._meta.stores.filter((s: any) => s.status === "ok").length;
  if (okStoreCount === 0) {
    return new Response(JSON.stringify({ error: "Every store failed to read. Not overwriting last good backup.", results: backup._meta.stores }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const backupJson = JSON.stringify(backup, null, 2);
  backup._meta.totalSizeKB = Math.round(backupJson.length / 1024);

  // Push to GitHub
  try {
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
    } catch (e) {}

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

    const commitBody: Record<string, any> = {
      message: `[SAM BACKUP] ${dateStr} ${timeStr} ET — ${backup._meta.totalSizeKB} KB — Manual`,
      content: Buffer.from(JSON.stringify(backup, null, 2)).toString("base64"),
      committer: { name: "SAM Chief of Staff", email: "admin@edupolicy.ai" },
    };
    if (existingSHA) commitBody.sha = existingSHA;

    const pushResp = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${GITHUB_PAT}`, "Content-Type": "application/json", "User-Agent": "SAM-Backup" },
        body: JSON.stringify(commitBody),
      }
    );

    const elapsed = Date.now() - startTime;

    if (pushResp.ok) {
      const pushData = await pushResp.json();
      const statusInfo = {
        timestamp: now.toISOString(),
        commit: pushData.commit?.sha?.substring(0, 7),
        sizeKB: backup._meta.totalSizeKB,
        stores: backup._meta.stores.length,
        elapsed: elapsed + "ms",
        trigger: "manual",
      };

      // Save status
      const statusStore = getStore({ name: "sam-backup-status", consistency: "strong" });
      await statusStore.set("last", JSON.stringify(statusInfo));

      return new Response(JSON.stringify({
        success: true,
        commit: pushData.commit?.sha?.substring(0, 7),
        url: pushData.content?.html_url,
        sizeKB: backup._meta.totalSizeKB,
        storesBackedUp: backup._meta.stores.filter((s: any) => s.status === "ok").length,
        elapsed: elapsed + "ms",
      }), { headers });
    } else {
      const errText = await pushResp.text();
      return new Response(JSON.stringify({ error: "GitHub push failed: " + errText.substring(0, 200) }), { status: 500, headers });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: "Backup failed: " + String(e) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: "/api/backup",
};
