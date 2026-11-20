/**
 * Client downloads (the Nov 18 website spec): each selected client
 * becomes a folder named with the client's name, holding every
 * photo, the session notes and laser settings as readable text,
 * and the client's attached files (the consent form included).
 * There is deliberately NO "save all" button — "Select all" ticks
 * every checkbox and the download runs on the ticked selection.
 *
 * Destinations, chosen at save time:
 *   - a folder on the computer (File System Access API; browsers
 *     without it fall back to one ZIP download)
 *   - Google Drive (the signed-in account's own Drive, via the
 *     drive.file scope — the site can only see what it created)
 *
 * Assembly happens in memory first so the exact total size is
 * known — and shown — before anything is written.
 */
import { db } from "./db.js";
import { ensureBlob } from "./sync.js";
import {
  dateWithYear,
  formatAllSettingsLine,
  photoSessionLabel,
  sessionsOf,
} from "./labels.js";
import { GOOGLE_CLIENT_ID } from "./config.js";

export const BIG_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function sanitizeSegment(name, fallback = "Untitled") {
  const clean = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

function extFor(contentType, filename) {
  if (filename && filename.includes(".")) {
    return filename.slice(filename.lastIndexOf("."));
  }
  switch ((contentType ?? "").split(";")[0].trim()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    default:
      return ".bin";
  }
}

/**
 * Build one client's export tree:
 * [{ path, blobKey?, hash?, text? }] plus the byte total of every
 * blob whose size is already known locally (unknown sizes are
 * counted when the bytes are fetched during assembly).
 */
export function planClientExport(client, lib) {
  const entries = [];
  const root = sanitizeSegment(client.name, "Client");
  const tattoos = lib.tattoos.filter((t) => t.clientId === client.id);
  const sessionTotal = new Set(
    lib.checkins
      .filter((c) => tattoos.some((t) => t.id === c.tattooId))
      .map((c) => c.date),
  ).size;

  const info = [
    `Name: ${client.name}`,
    client.igHandle ? `Instagram: @${String(client.igHandle).replace(/^@/, "")}` : null,
    client.phone ? `Phone: ${client.phone}` : null,
    `Posting consent: ${client.allowPosting ? "Yes" : "No"}`,
    `Tattoos: ${tattoos.length}`,
    `Sessions: ${sessionTotal}`,
    "",
    "Exported from Tattoo Removal Tracker (by INKWASHER).",
  ]
    .filter((l) => l !== null)
    .join("\n");
  entries.push({ path: `${root}/client.txt`, text: info });

  for (const tattoo of tattoos) {
    const tDir = `${root}/${sanitizeSegment(tattoo.label, "Tattoo")}`;
    const sessions = sessionsOf(tattoo.id, lib.checkins);
    sessions.forEach((checkin, i) => {
      const index = i + 1;
      const sDir = `${tDir}/${String(index).padStart(2, "0")} - ${checkin.date}`;
      const lines = [
        `Session ${index}`,
        `Date: ${dateWithYear(checkin.date)}`,
      ];
      const settings = formatAllSettingsLine(checkin);
      if (settings) lines.push(`Laser settings: ${settings}`);
      if (checkin.note) lines.push(`Note: ${checkin.note}`);
      for (const [slotName, labelSlot, fileBase] of [
        ["before", "main", "before"],
        ["after", "after", "after"],
      ]) {
        const slot = checkin[slotName];
        if (slot?.displayedBlobKey) {
          entries.push({
            path: `${sDir}/${fileBase}.jpg`,
            blobKey: slot.displayedBlobKey,
            hash: slot.displayedHash,
          });
          lines.push(
            `${fileBase === "before" ? "Before" : "After"} photo: ${photoSessionLabel(index, labelSlot)}`,
          );
        }
      }
      entries.push({ path: `${sDir}/session.txt`, text: lines.join("\n") });
    });
    for (const file of lib.files.filter((f) => f.tattooId === tattoo.id)) {
      entries.push({
        path: `${tDir}/Files/${sanitizeSegment(file.filename, "file")}`,
        blobKey: file.blobKey,
        hash: file.sha256,
        size: file.sizeBytes,
      });
    }
  }
  for (const file of lib.files.filter((f) => f.clientId === client.id)) {
    entries.push({
      path: `${root}/Files/${sanitizeSegment(file.filename, "file")}`,
      blobKey: file.blobKey,
      hash: file.sha256,
      size: file.sizeBytes,
    });
  }
  return { clientName: client.name, root, entries };
}

/** Fetch every entry's bytes. Returns { files: [{path, bytes}],
 * missing: [paths] } — a photo whose bytes can't be fetched
 * (offline, not yet synced) is reported, never silently dropped. */
export async function assembleExport(plan, onProgress) {
  const files = [];
  const missing = [];
  let total = 0;
  const blobEntries = plan.entries.filter((e) => e.blobKey);
  let done = 0;
  for (const entry of plan.entries) {
    if (entry.text !== undefined) {
      const bytes = new TextEncoder().encode(entry.text);
      files.push({ path: entry.path, bytes });
      total += bytes.byteLength;
      continue;
    }
    try {
      const blob = await ensureBlob(entry.blobKey, entry.hash);
      files.push({ path: entry.path, bytes: blob.bytes });
      total += blob.bytes.byteLength;
    } catch {
      missing.push(entry.path);
    }
    done += 1;
    onProgress?.(done, blobEntries.length);
  }
  return { files, missing, totalBytes: total };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ------------------------- destinations -------------------------- */

export function folderPickerSupported() {
  return typeof window.showDirectoryPicker === "function";
}

export async function saveToFolder(files) {
  const root = await window.showDirectoryPicker({ mode: "readwrite" });
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(part, { create: true });
    }
    const handle = await dir.getFileHandle(parts[parts.length - 1], {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(file.bytes);
    await writable.close();
  }
}

export async function saveAsZip(files, zipName) {
  const zip = new window.JSZip();
  for (const file of files) zip.file(file.path, file.bytes);
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Google Drive destination: an access token for the drive.file
 * scope, then one folder per client with the same tree inside. */
export function requestDriveToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error("Google sign-in tools are still loading — try again in a moment."));
      return;
    }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (resp) => {
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.access_token);
      },
    });
    client.requestAccessToken();
  });
}

async function driveCall(token, method, url, { json, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body ?? (json !== undefined ? JSON.stringify(json) : undefined),
  });
  if (!res.ok) throw new Error(`Google Drive request failed (HTTP ${res.status}).`);
  return res.json().catch(() => ({}));
}

export async function saveToDrive(files, token, onProgress) {
  const folderIds = new Map([["", "root"]]);
  const ensureFolder = async (path) => {
    if (folderIds.has(path)) return folderIds.get(path);
    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const parentId = await ensureFolder(parentPath);
    const created = await driveCall(
      token,
      "POST",
      "https://www.googleapis.com/drive/v3/files",
      {
        json: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        },
      },
    );
    folderIds.set(path, created.id);
    return created.id;
  };
  let done = 0;
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dirPath = slash === -1 ? "" : file.path.slice(0, slash);
    const name = slash === -1 ? file.path : file.path.slice(slash + 1);
    const parentId = await ensureFolder(dirPath);
    const metadata = { name, parents: [parentId] };
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    );
    form.append("file", new Blob([file.bytes]));
    await driveCall(
      token,
      "POST",
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      { body: form },
    );
    done += 1;
    onProgress?.(done, files.length);
  }
}
