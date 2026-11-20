/**
 * The website's sync engine — the same protocol and rules as the
 * phone app's cloud sync (app/src/engine/cloud-sync.ts), over the
 * website's IndexedDB replica:
 *
 *  - State-based reconciliation: local rows carry an updatedAt
 *    outside the payload; a sidecar (localStorage) remembers the
 *    last-reconciled stamp per record and the sync_seq cursor.
 *  - ADDITIVE ONLY: the website never pushes tombstones and never
 *    applies pulled ones as deletions. A record removed from this
 *    device's view is remembered as a suppression; an older server
 *    copy cannot resurrect it, a newer server edit can.
 *  - Blobs move by content hash, SHA-256 verified on download.
 *  - "kept-server" push answers trigger a re-pull from 0 in the
 *    same run (the app's rule), so the server's winning version is
 *    adopted instead of fought.
 *
 * Rollback is snapshot-based (see the rollback section below):
 * the API's change feed carries only each record's latest state,
 * so no server-side point-in-time history exists to restore from.
 * The website keeps its own snapshots of the local library and
 * restores from those; restored records are re-stamped and pushed,
 * which is what carries the restore to the account.
 */
import { api, sha256Hex, ApiError } from "./api.js";
import { db, recordKey } from "./db.js";
import { DEVICE_KEY, STATE_KEY } from "./config.js";

const REDO_KEY = "tattoo-tracker-web.redo-snapshot";
export const ENTITIES = ["clients", "tattoos", "checkins", "files"];

/* ------------------------- device link --------------------------- */

export function readLink() {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.token === "string" && parsed.token
      ? { token: parsed.token, email: parsed.email ?? "" }
      : null;
  } catch {
    return null;
  }
}

export function writeLink(link) {
  localStorage.setItem(DEVICE_KEY, JSON.stringify(link));
}

export function clearLink() {
  localStorage.removeItem(DEVICE_KEY);
}

/* --------------------------- sync state -------------------------- */

const EMPTY_STATE = {
  cursor: 0,
  stamps: {},
  deleted: {},
  lastSyncAt: null,
  lastError: null,
  lastConflicts: 0,
};

export function readState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return { ...EMPTY_STATE };
    const p = JSON.parse(raw);
    return {
      cursor: typeof p.cursor === "number" ? p.cursor : 0,
      stamps: p.stamps ?? {},
      deleted: p.deleted ?? {},
      lastSyncAt: p.lastSyncAt ?? null,
      lastError: p.lastError ?? null,
      lastConflicts: typeof p.lastConflicts === "number" ? p.lastConflicts : 0,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function resetSyncState() {
  localStorage.removeItem(STATE_KEY);
}

/* --------------------------- local writes ------------------------ */

export const nowIso = () => new Date().toISOString();

/** Next local id for an entity: one past the highest id in the
 * replica (the replica holds every server record after a pull, so
 * this tracks the account's id space the same way the app's
 * counters do). */
export async function nextLocalId(entity) {
  const rows = await db.allRecords(entity);
  return rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

/** Save a record locally with a fresh stamp. It becomes a push
 * candidate on the next sync run. */
export async function saveLocal(entity, payload) {
  await db.putRecord(entity, payload, nowIso());
}

/** Hide a record on this device only (additive rule: nothing is
 * ever deleted from the account). Used by rollback for records
 * created after the restore point. */
export async function suppressLocal(entity, id) {
  const state = readState();
  state.deleted[recordKey(entity, id)] = nowIso();
  writeState(state);
  await db.deleteRecord(entity, id);
}

/** Turn picked photo bytes into a stored blob + slot contents.
 * A fresh upload's displayed version IS its original until the
 * app produces an aligned render (the app's rule). */
export async function ingestBlob(bytes, contentType) {
  const sha256 = await sha256Hex(bytes);
  const blobKey = `blob-${sha256}`;
  await db.putBlob(blobKey, sha256, contentType || "application/octet-stream", bytes);
  return { blobKey, sha256 };
}

export function slotFromBlob({ blobKey, sha256 }) {
  return {
    displayedBlobKey: blobKey,
    originalBlobKey: blobKey,
    alignedBlobKey: null,
    displayedHash: sha256,
    originalHash: sha256,
    alignedHash: null,
  };
}

export const EMPTY_SLOT = {
  displayedBlobKey: null,
  originalBlobKey: null,
  alignedBlobKey: null,
  displayedHash: null,
  originalHash: null,
  alignedHash: null,
};

/** Records whose local stamp moved past the last reconciled one. */
export async function dirtyRecords(state) {
  const out = [];
  for (const entity of ENTITIES) {
    for (const row of await db.allRecords(entity)) {
      const key = recordKey(entity, row.id);
      if (state.deleted[key]) continue;
      const stamp = state.stamps[key];
      if (!stamp || row.updatedAt > stamp) {
        out.push({ entity, id: row.id, payload: row.payload, updatedAt: row.updatedAt });
      }
    }
  }
  return out;
}

export async function pendingCount() {
  const state = readState();
  return (await dirtyRecords(state)).length;
}

/* ------------------------------ sync ----------------------------- */

function applyPullChange(change, state) {
  const key = recordKey(change.entity, change.id);
  if (change.payload == null) {
    // A tombstone from another device. Additive rule: never a
    // deletion here — the local copy (if any) stays.
    return Promise.resolve(false);
  }
  const suppressedAt = state.deleted[key];
  if (suppressedAt && change.updatedAt <= suppressedAt) return Promise.resolve(false);
  if (suppressedAt && change.updatedAt > suppressedAt) {
    delete state.deleted[key]; // a newer edit resurrects (the app's rule)
  }
  state.stamps[key] = change.updatedAt;
  return db.getRecord(change.entity, change.id).then((local) => {
    // Scalars are last-writer-wins by updatedAt: a local edit newer
    // than this change (e.g. a rollback restore mid-flight) stays
    // and will win on the push leg instead.
    if (local && local.updatedAt > change.updatedAt) return false;
    return db
      .putRecord(change.entity, change.payload, change.updatedAt)
      .then(() => true);
  });
}

async function ensureBlobsForRecords(token, records, serverBlobKeys) {
  const wanted = new Map(); // blobKey -> hash
  const want = (key, hash) => {
    if (key && !serverBlobKeys.has(key)) wanted.set(key, hash);
  };
  for (const rec of records) {
    if (rec.entity === "checkins") {
      for (const slotName of ["before", "after"]) {
        const slot = rec.payload[slotName] ?? {};
        want(slot.displayedBlobKey, slot.displayedHash);
        want(slot.originalBlobKey, slot.originalHash);
        want(slot.alignedBlobKey, slot.alignedHash);
      }
    } else if (rec.entity === "files") {
      want(rec.payload.blobKey, rec.payload.sha256);
    }
  }
  for (const [blobKey, hash] of wanted) {
    const local = await db.getBlob(blobKey);
    if (!local) {
      throw new ApiError(
        "sync_failed",
        "A photo in this change is missing its image data on this device, so nothing was sent. Re-add the photo and sync again.",
      );
    }
    await api.uploadBlob(token, hash ?? local.sha256, local.bytes, local.contentType);
    serverBlobKeys.add(blobKey);
  }
}

/**
 * One full sync run. Throws ApiError on failure; on a throw,
 * neither the cursor nor the stamps have advanced, so the next
 * run redoes the work (the protocol is idempotent end to end).
 */
export async function runSync({ onPhase } = {}) {
  const link = readLink();
  if (!link) throw new ApiError("not_linked", "Not signed in.");
  const state = readState();
  let conflicts = 0;
  try {
    onPhase?.("Checking the library…");
    const manifest = await api.manifest(link.token);
    const serverBlobKeys = new Set(manifest.blobs.map((b) => b.blobKey));

    onPhase?.("Pulling changes…");
    const pulled = await api.pull(link.token, state.cursor);
    for (const change of pulled.changes) await applyPullChange(change, state);
    let cursor = pulled.cursor;

    const dirty = await dirtyRecords(state);
    if (dirty.length > 0) {
      onPhase?.(`Sending ${dirty.length} change${dirty.length === 1 ? "" : "s"}…`);
      await ensureBlobsForRecords(link.token, dirty, serverBlobKeys);
      const result = await api.push(link.token, dirty);
      cursor = Math.max(cursor, result.cursor);
      for (const rec of dirty) {
        state.stamps[recordKey(rec.entity, rec.id)] = rec.updatedAt;
      }
      const kept = result.results.filter((r) => r.resolution === "kept-server");
      conflicts = result.results.filter((r) =>
        ["kept-server", "merged", "kept-server-edit-newer"].includes(r.resolution),
      ).length;
      if (kept.length > 0) {
        // Adopt the server's winning versions wholesale.
        const repull = await api.pull(link.token, 0);
        for (const change of repull.changes) {
          if (change.payload != null) {
            state.stamps[recordKey(change.entity, change.id)] = change.updatedAt;
            await db.putRecord(change.entity, change.payload, change.updatedAt);
          }
        }
        cursor = Math.max(cursor, repull.cursor);
      }
    }

    state.cursor = cursor;
    state.lastSyncAt = nowIso();
    state.lastError = null;
    state.lastConflicts = conflicts;
    writeState(state);
    await maybeSnapshot("Sync");
    void prefetchBlobs(link.token);
    return { cursor, conflicts, pushed: dirty.length };
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : "Sync failed.";
    writeState(state);
    throw e;
  }
}

/** Background-fill the local blob cache so the library works
 * offline: every blob any local record references, downloaded
 * once and hash-verified. Best-effort — a failure just leaves
 * that photo to load on demand. */
export async function prefetchBlobs(token) {
  const lib = await db.library();
  const wanted = new Map();
  const want = (key, hash) => {
    if (key && !wanted.has(key)) wanted.set(key, hash);
  };
  for (const c of lib.checkins) {
    for (const slotName of ["before", "after"]) {
      const slot = c[slotName] ?? {};
      want(slot.displayedBlobKey, slot.displayedHash);
      want(slot.originalBlobKey, slot.originalHash);
      want(slot.alignedBlobKey, slot.alignedHash);
    }
  }
  for (const f of lib.files) want(f.blobKey, f.sha256);
  for (const [blobKey] of wanted) {
    if (await db.hasBlob(blobKey)) continue;
    try {
      await ensureBlob(blobKey, wanted.get(blobKey));
    } catch {
      /* offline or refused — on-demand load will retry */
    }
  }
}

/** One blob's bytes, from the local cache or the API. Verifies the
 * hash against the record's expectation when one is known. */
export async function ensureBlob(blobKey, expectedHash) {
  const local = await db.getBlob(blobKey);
  if (local) return local;
  const link = readLink();
  if (!link) throw new ApiError("not_linked", "Not signed in.");
  const { bytes, sha256, contentType } = await api.downloadBlob(link.token, blobKey);
  if (expectedHash && expectedHash !== sha256) {
    throw new ApiError(
      "sync_failed",
      "A photo failed its integrity check and was not saved.",
    );
  }
  await db.putBlob(blobKey, sha256, contentType, bytes);
  return { blobKey, sha256, contentType, bytes };
}

/* ---------------------------- rollback --------------------------- */
/*
 * Snapshots of the local library (records only — photos are
 * content-addressed and stay in the blob cache). Restoring writes
 * the snapshot's records back with fresh stamps and pushes, so
 * the restore propagates to the account like any other edit.
 * Records created after the snapshot are hidden on this device
 * (suppressed) — sync never deletes, so they remain in the
 * account and a fresh sign-in elsewhere would still see them;
 * the Settings screen says exactly that.
 */

export async function takeSnapshot(label) {
  const rows = await db.allRecords(null);
  const snapshot = {
    takenAt: Date.now(),
    label,
    records: rows.map((r) => ({
      entity: r.entity,
      id: r.id,
      payload: r.payload,
      updatedAt: r.updatedAt,
    })),
  };
  const id = await db.addSnapshot(snapshot);
  await pruneSnapshots();
  return id;
}

async function maybeSnapshot(label) {
  const snaps = await db.allSnapshots();
  const newest = snaps[0];
  if (!newest || Date.now() - newest.takenAt > 5 * 60 * 1000) {
    await takeSnapshot(label);
  }
}

const HORIZONS = [10 * 60 * 1000, 24 * 3600 * 1000, 7 * 24 * 3600 * 1000];

async function pruneSnapshots() {
  const snaps = await db.allSnapshots(); // newest first
  if (snaps.length <= 24) return;
  const keep = new Set([snaps[0].id]);
  for (const h of HORIZONS) {
    const cutoff = Date.now() - h;
    const candidate = snaps.find((s) => s.takenAt <= cutoff);
    if (candidate) keep.add(candidate.id);
  }
  for (const s of snaps.slice(24)) {
    if (!keep.has(s.id)) await db.deleteSnapshot(s.id);
  }
}

/** The snapshot a "restore to <horizon>" would use: the newest one
 * taken at or before that moment, or null when none reaches back
 * that far. */
export async function snapshotForHorizon(horizonMs) {
  const snaps = await db.allSnapshots();
  const cutoff = Date.now() - horizonMs;
  return snaps.find((s) => s.takenAt <= cutoff) ?? null;
}

export async function restoreSnapshot(snapshot) {
  // Capture the present first — it becomes the Redo point.
  const redoId = await takeSnapshot("Before restore");
  localStorage.setItem(REDO_KEY, String(redoId));

  const inSnapshot = new Set(
    snapshot.records.map((r) => recordKey(r.entity, r.id)),
  );
  const stamp = nowIso();
  for (const rec of snapshot.records) {
    await db.putRecord(rec.entity, rec.payload, stamp);
  }
  const state = readState();
  for (const entity of ENTITIES) {
    for (const row of await db.allRecords(entity)) {
      const key = recordKey(entity, row.id);
      if (!inSnapshot.has(key)) {
        state.deleted[key] = stamp;
        await db.deleteRecord(entity, row.id);
      }
    }
  }
  // Restored records must push: drop their reconciled stamps.
  for (const rec of snapshot.records) {
    delete state.stamps[recordKey(rec.entity, rec.id)];
    delete state.deleted[recordKey(rec.entity, rec.id)];
  }
  writeState(state);
  await runSync();
}

export async function redoPoint() {
  const raw = localStorage.getItem(REDO_KEY);
  if (!raw) return null;
  const snaps = await db.allSnapshots();
  return snaps.find((s) => s.id === Number(raw)) ?? null;
}

export async function redoRestore() {
  const snap = await redoPoint();
  if (!snap) return false;
  localStorage.removeItem(REDO_KEY);
  await restoreSnapshot(snap);
  return true;
}
