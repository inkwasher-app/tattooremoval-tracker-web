/**
 * The website's local library: an IndexedDB replica of the account's
 * tracker library, so the site works offline and renders instantly.
 *
 * Stores:
 *   records   "entity:id" -> { key, entity, id, payload, updatedAt }
 *   blobs     blobKey     -> { blobKey, sha256, contentType, bytes }
 *   snapshots id (auto)   -> { takenAt, label, records: [...] }
 *
 * Blob bytes are content-addressed (blob-<sha256>) and shared by
 * every surface that references them, exactly like the app's blob
 * store. Records hold references only, never bytes.
 */

const DB_NAME = "tattoo-removal-tracker-web";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        db.createObjectStore("records", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "blobKey" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const finish = () => resolve(result);
    t.oncomplete = finish;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    run(s, (v) => {
      result = v;
    });
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const recordKey = (entity, id) => `${entity}:${id}`;

export const db = {
  async putRecord(entity, payload, updatedAt) {
    const d = await openDb();
    await tx(d, "records", "readwrite", (s) => {
      s.put({
        key: recordKey(entity, payload.id),
        entity,
        id: payload.id,
        payload,
        updatedAt,
      });
    });
  },

  async getRecord(entity, id) {
    const d = await openDb();
    const row = await requestToPromise(
      d.transaction("records").objectStore("records").get(recordKey(entity, id)),
    );
    return row ?? null;
  },

  async deleteRecord(entity, id) {
    const d = await openDb();
    await tx(d, "records", "readwrite", (s) => {
      s.delete(recordKey(entity, id));
    });
  },

  async allRecords(entity) {
    const d = await openDb();
    const rows = await requestToPromise(
      d.transaction("records").objectStore("records").getAll(),
    );
    return rows
      .filter((r) => !entity || r.entity === entity)
      .sort((a, b) => a.id - b.id);
  },

  /** The whole library as plain payload arrays — what every screen
   * renders from and what snapshots capture. */
  async library() {
    const rows = await this.allRecords(null);
    const lib = { clients: [], tattoos: [], checkins: [], files: [] };
    for (const r of rows) lib[r.entity].push(r.payload);
    return lib;
  },

  async putBlob(blobKey, sha256, contentType, bytes) {
    const d = await openDb();
    await tx(d, "blobs", "readwrite", (s) => {
      s.put({ blobKey, sha256, contentType, bytes });
    });
  },

  async getBlob(blobKey) {
    const d = await openDb();
    const row = await requestToPromise(
      d.transaction("blobs").objectStore("blobs").get(blobKey),
    );
    return row ?? null;
  },

  async hasBlob(blobKey) {
    const d = await openDb();
    const key = await requestToPromise(
      d.transaction("blobs").objectStore("blobs").getKey(blobKey),
    );
    return key !== undefined;
  },

  async addSnapshot(snapshot) {
    const d = await openDb();
    return tx(d, "snapshots", "readwrite", (s, done) => {
      const req = s.add(snapshot);
      req.onsuccess = () => done(req.result);
    });
  },

  async allSnapshots() {
    const d = await openDb();
    const rows = await requestToPromise(
      d.transaction("snapshots").objectStore("snapshots").getAll(),
    );
    return rows.sort((a, b) => b.takenAt - a.takenAt); // newest first
  },

  async deleteSnapshot(id) {
    const d = await openDb();
    await tx(d, "snapshots", "readwrite", (s) => {
      s.delete(id);
    });
  },

  async clearLibrary() {
    const d = await openDb();
    await tx(d, "records", "readwrite", (s) => s.clear());
  },

  async clearBlobs() {
    const d = await openDb();
    await tx(d, "blobs", "readwrite", (s) => s.clear());
  },
};
