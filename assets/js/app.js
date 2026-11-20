/**
 * Tattoo Removal Tracker — website UI.
 *
 * A static front end over the tracker API, mirroring the phone
 * app: same theme, same screens (client list, client profile,
 * tattoo timeline, photo viewer), same labels, same sync rules.
 * All data renders from the local IndexedDB replica; the sync
 * engine (sync.js) keeps it in step with the account.
 */
import { GOOGLE_CLIENT_ID } from "./config.js";
import { ApiError } from "./api.js";
import { db } from "./db.js";
import {
  clearLink,
  ensureBlob,
  ingestBlob,
  nextLocalId,
  nowIso,
  pendingCount,
  readLink,
  readState,
  redoPoint,
  redoRestore,
  resetSyncState,
  restoreSnapshot,
  runSync,
  saveLocal,
  slotFromBlob,
  snapshotForHorizon,
  takeSnapshot,
  writeLink,
  EMPTY_SLOT,
} from "./sync.js";
import {
  buildClientList,
  clientThumbnail,
  dateWithYear,
  formatAllSettingsLine,
  photoSessionLabel,
  sessionBlockLabel,
  sessionsOf,
  slotHasPhoto,
  tattooPhotos,
  tattooSummary,
  CLIENT_SORTS,
} from "./labels.js";
import {
  assembleExport,
  formatBytes,
  folderPickerSupported,
  planClientExport,
  requestDriveToken,
  saveAsZip,
  saveToDrive,
  saveToFolder,
  sanitizeSegment,
  BIG_DOWNLOAD_BYTES,
} from "./downloads.js";

/* ------------------------------ helpers -------------------------- */

const $app = document.getElementById("app");
const $header = document.getElementById("app-header");
const $pill = document.getElementById("sync-pill");
const $backdrop = document.getElementById("sheet-backdrop");
const $sheet = document.getElementById("sheet");
const $viewer = document.getElementById("viewer");
const $toast = document.getElementById("toast");

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
export function toast(message, isError = false) {
  $toast.textContent = message;
  $toast.className = `toast on${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.className = "toast"), 4200);
}

const objectUrls = new Map();
async function blobUrl(blobKey, hash) {
  if (objectUrls.has(blobKey)) return objectUrls.get(blobKey);
  const promise = (async () => {
    const blob = await ensureBlob(blobKey, hash);
    return URL.createObjectURL(
      new Blob([blob.bytes], { type: blob.contentType || "image/jpeg" }),
    );
  })();
  objectUrls.set(blobKey, promise);
  try {
    return await promise;
  } catch (e) {
    objectUrls.delete(blobKey);
    throw e;
  }
}

/** Fill every <img data-blob="key" data-hash="..."> under root. */
async function hydrateImages(root) {
  const imgs = root.querySelectorAll("img[data-blob]");
  await Promise.all(
    [...imgs].map(async (img) => {
      try {
        img.src = await blobUrl(img.dataset.blob, img.dataset.hash || null);
      } catch {
        img.alt = "Photo not available offline yet";
        img.style.opacity = "0.35";
      }
    }),
  );
}

/* ------------------------------- sheets -------------------------- */

let sheetOpen = false;
function openSheet(html) {
  $sheet.innerHTML = html;
  $backdrop.className = "sheet-backdrop on";
  sheetOpen = true;
}
function closeSheet() {
  $backdrop.className = "sheet-backdrop";
  $sheet.innerHTML = "";
  sheetOpen = false;
}
$backdrop.addEventListener("click", (e) => {
  if (e.target === $backdrop) closeSheet();
});

/* ------------------------------ state ---------------------------- */

const ui = {
  lib: { clients: [], tattoos: [], checkins: [], files: [] },
  search: "",
  sort: "mostRecent",
  selected: new Set(),
  route: { name: "clients" },
};

async function reloadLib() {
  ui.lib = await db.library();
}

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "client" && parts[1]) return { name: "client", id: Number(parts[1]) };
  if (parts[0] === "tattoo" && parts[1]) return { name: "tattoo", id: Number(parts[1]) };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "clients" };
}

function go(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = `#${path}`;
}
window.addEventListener("hashchange", () => render());

/* ------------------------------- sync ---------------------------- */

function setPill(text, isError = false) {
  $pill.textContent = text;
  $pill.className = `sync-pill${isError ? " error" : ""}`;
}

async function refreshPill() {
  const state = readState();
  const pending = await pendingCount();
  if (state.lastError) {
    setPill(`Sync issue: ${state.lastError}`, true);
  } else if (pending > 0) {
    setPill(`${pending} change${pending === 1 ? "" : "s"} waiting to sync`);
  } else if (state.lastSyncAt) {
    setPill(`Synced ${new Date(state.lastSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
  } else {
    setPill("Not synced yet");
  }
}

let syncing = false;
async function syncNow({ quiet = false } = {}) {
  if (syncing || !readLink()) return;
  syncing = true;
  setPill("Syncing…");
  try {
    await runSync();
    await reloadLib();
    if (!sheetOpen) render();
    await refreshPill();
  } catch (e) {
    if (e instanceof ApiError && e.kind === "unauthorized") {
      signOut("Your sign-in was refused. Sign in again to keep syncing.");
      return;
    }
    await refreshPill();
    if (!quiet) {
      toast(
        e instanceof ApiError && e.kind === "network"
          ? "You're offline — changes stay on this device and sync later."
          : `Sync didn't finish: ${e.message}`,
        true,
      );
    }
  } finally {
    syncing = false;
  }
}
window.addEventListener("online", () => syncNow({ quiet: true }));

/* ------------------------------ sign-in -------------------------- */

function renderSignIn(message) {
  $header.hidden = true;
  const offOrigin =
    location.hostname !== "tattooremovaltracker.com";
  $app.innerHTML = `
    <div class="signin-wrap">
      <img class="logo" src="assets/icon.png" alt="Tattoo Removal Tracker icon">
      <h1>Tattoo Removal Tracker</h1>
      <div class="byline micro-label" style="color:var(--mist)">by INKWASHER</div>
      <div class="card signin-card">
        <h2>Sign in</h2>
        <p class="muted">For technicians. Sign in with the Google account
        linked to your tracker app and this browser shows the same
        client library.</p>
        <div class="gis-holder" id="gis-holder"></div>
        ${message ? `<p class="error-text" id="signin-error">${esc(message)}</p>` : ""}
        ${offOrigin ? `<p class="small faint">You're viewing the site from an
          address Google hasn't authorized for sign-in, so Google will
          refuse the sign-in window here. The live site is
          tattooremovaltracker.com.</p>` : ""}
      </div>
    </div>`;
  initGis();
}

function initGis() {
  const holder = document.getElementById("gis-holder");
  if (!holder) return;
  let tries = 0;
  const attempt = () => {
    if (window.google?.accounts?.id) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredential,
      });
      window.google.accounts.id.renderButton(holder, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "signin_with",
      });
    } else if (tries++ < 40) {
      setTimeout(attempt, 250);
    } else {
      holder.innerHTML =
        '<p class="error-text small">Google sign-in tools could not be loaded. Check your connection and reload.</p>';
    }
  };
  attempt();
}

/** The sign-in exchange: Google ID token -> device token -> app.
 * Exposed on window.TRT so the flow can be exercised in tests
 * without Google's own popup. */
export async function handleGoogleCredential(response) {
  const idToken = response?.credential;
  if (!idToken) return;
  try {
    const { api } = await import("./api.js");
    const result = await api.exchangeGoogleIdToken(idToken);
    writeLink({ token: result.deviceToken, email: result.email });
    $header.hidden = false;
    await reloadLib();
    render();
    await syncNow();
  } catch (e) {
    if (e instanceof ApiError && e.kind === "account_not_linked") {
      renderSignIn("This Google account isn't linked to a tracker library.");
    } else if (e instanceof ApiError && e.kind === "network") {
      renderSignIn("Couldn't reach the tracker service. Check your connection and try again.");
    } else {
      renderSignIn(`Sign-in didn't complete: ${e.message}`);
    }
  }
}

function signOut(message) {
  clearLink();
  resetSyncState();
  localStorage.removeItem("tattoo-tracker-web.redo-snapshot");
  void (async () => {
    await db.clearLibrary();
    await db.clearBlobs();
    for (const snap of await db.allSnapshots()) await db.deleteSnapshot(snap.id);
  })();
  ui.selected.clear();
  renderSignIn(message);
}

/* ----------------------------- clients --------------------------- */

function clientCard(item) {
  const thumb = clientThumbnail(item.id, ui.lib.tattoos, ui.lib.checkins);
  const checked = ui.selected.has(item.id) ? "checked" : "";
  return `
  <div class="client-card" data-open-client="${item.id}" role="button" tabindex="0"
       aria-label="Open ${esc(item.name)}">
    <input type="checkbox" class="pick" data-pick="${item.id}" ${checked}
           aria-label="Select ${esc(item.name)} for download">
    ${thumb
      ? `<img class="thumb" data-blob="${esc(thumb.blobKey)}" data-hash="${esc(thumb.hash ?? "")}" alt="">`
      : `<div class="thumb-placeholder">${esc(item.name.trim().charAt(0).toUpperCase() || "?")}</div>`}
    <div class="meta">
      <div class="name">${esc(item.name)}</div>
      <div class="sub">${item.igHandle ? `@${esc(String(item.igHandle).replace(/^@/, ""))} · ` : ""}${item.tattooCount} tattoo${item.tattooCount === 1 ? "" : "s"} · ${item.sessionCount} session${item.sessionCount === 1 ? "" : "s"}</div>
      <div class="sub">${item.lastSessionDate ? `Last session ${dateWithYear(item.lastSessionDate)}` : "No sessions yet"}</div>
    </div>
  </div>`;
}

function renderClients() {
  const items = buildClientList(
    ui.lib.clients, ui.lib.tattoos, ui.lib.checkins, ui.search, ui.sort,
  );
  const allChecked =
    items.length > 0 && items.every((c) => ui.selected.has(c.id));
  $app.innerHTML = `
    <div class="toolbar">
      <div class="search">
        <input type="search" id="client-search" placeholder="Search clients or Instagram…"
               value="${esc(ui.search)}" aria-label="Search clients">
      </div>
      <select id="client-sort" aria-label="Sort clients">
        ${CLIENT_SORTS.map(([v, label]) =>
          `<option value="${v}" ${ui.sort === v ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      <button class="btn btn-primary" id="add-client" type="button">+ Add client</button>
    </div>
    <label class="check-row" style="margin-top:0">
      <input type="checkbox" id="select-all" ${allChecked ? "checked" : ""}>
      <span>Select all</span>
      <span class="faint small">for download</span>
    </label>
    <div class="selection-bar ${ui.selected.size ? "on" : ""}" id="selection-bar">
      <strong>${ui.selected.size} selected</strong>
      <button class="btn btn-primary btn-small" id="download-selected" type="button">Download selected</button>
      <button class="btn btn-ghost btn-small" id="clear-selection" type="button">Clear</button>
    </div>
    ${items.length === 0
      ? `<div class="card empty-state">
           ${ui.lib.clients.length === 0
             ? `<h2>Your library is empty</h2>
                <p>Clients you add in the Tattoo Removal Tracker app appear
                here once they sync. You can also add your first client here.</p>`
             : `<h2>No matches</h2><p>No clients match that search.</p>`}
         </div>`
      : `<div class="client-grid">${items.map(clientCard).join("")}</div>`}`;

  document.getElementById("client-search").addEventListener("input", (e) => {
    ui.search = e.target.value;
    renderClients();
    const el = document.getElementById("client-search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  document.getElementById("client-sort").addEventListener("change", (e) => {
    ui.sort = e.target.value;
    renderClients();
  });
  document.getElementById("add-client").addEventListener("click", () => openClientForm(null));
  document.getElementById("select-all").addEventListener("change", (e) => {
    if (e.target.checked) items.forEach((c) => ui.selected.add(c.id));
    else items.forEach((c) => ui.selected.delete(c.id));
    renderClients();
  });
  document.getElementById("clear-selection")?.addEventListener("click", () => {
    ui.selected.clear();
    renderClients();
  });
  document.getElementById("download-selected")?.addEventListener("click", openDownloads);
  $app.querySelectorAll("[data-pick]").forEach((box) => {
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", (e) => {
      const id = Number(e.target.dataset.pick);
      if (e.target.checked) ui.selected.add(id);
      else ui.selected.delete(id);
      renderClients();
    });
  });
  $app.querySelectorAll("[data-open-client]").forEach((card) => {
    card.addEventListener("click", () => go(`/client/${card.dataset.openClient}`));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go(`/client/${card.dataset.openClient}`);
    });
  });
  void hydrateImages($app);
}

/* ----------------------------- profile --------------------------- */

function fileRow(file, tagText) {
  return `
  <div class="file-row">
    <div class="fname">${esc(file.filename)}${tagText ? `<span class="badge badge-mist">${esc(tagText)}</span>` : ""}</div>
    <span class="faint small">${esc(file.contentType || "")}</span>
    <button class="btn btn-quiet btn-small" data-view-file="${file.id}" type="button">View</button>
    <button class="btn btn-quiet btn-small" data-download-file="${file.id}" type="button">Download</button>
  </div>`;
}

function renderClient(id) {
  const client = ui.lib.clients.find((c) => c.id === id);
  if (!client) {
    $app.innerHTML = `<div class="card empty-state"><h2>Client not found</h2>
      <p>This client isn't in the library on this device.</p></div>`;
    return;
  }
  const tattoos = ui.lib.tattoos.filter((t) => t.clientId === id);
  const ownFiles = ui.lib.files.filter((f) => f.clientId === id);
  const tattooFiles = ui.lib.files.filter(
    (f) => f.tattooId != null && tattoos.some((t) => t.id === f.tattooId),
  );
  const thumb = clientThumbnail(id, ui.lib.tattoos, ui.lib.checkins);
  $app.innerHTML = `
    <p><a href="#/">&larr; All clients</a></p>
    <div class="card">
      <div class="profile-head">
        ${thumb
          ? `<img class="thumb" data-blob="${esc(thumb.blobKey)}" data-hash="${esc(thumb.hash ?? "")}" alt="">`
          : `<div class="thumb-placeholder">${esc(client.name.trim().charAt(0).toUpperCase() || "?")}</div>`}
        <div style="flex:1;min-width:200px">
          <h2 style="margin:0">${esc(client.name)}
            ${client.allowPosting
              ? `<span class="badge badge-mist">Posting OK</span>`
              : `<span class="badge badge-wine">Do not post</span>`}</h2>
          <div class="muted">
            ${client.igHandle ? `@${esc(String(client.igHandle).replace(/^@/, ""))}` : ""}
            ${client.igHandle && client.phone ? " · " : ""}
            ${client.phone ? esc(client.phone) : ""}
          </div>
          <div class="faint small">${tattoos.length} tattoo${tattoos.length === 1 ? "" : "s"}</div>
        </div>
        <button class="btn btn-quiet" id="edit-client" type="button">Edit client</button>
      </div>
    </div>

    <div class="card">
      <h3>Tattoos</h3>
      ${tattoos.length === 0 ? `<p class="muted">No tattoos yet.</p>` : ""}
      ${tattoos.map((t) => {
        const s = tattooSummary(t, ui.lib.checkins);
        const sessions = sessionsOf(t.id, ui.lib.checkins);
        const baseline = sessions.find((c) => slotHasPhoto(c.before));
        return `
        <button class="tattoo-row" data-open-tattoo="${t.id}" type="button">
          ${baseline
            ? `<img class="thumb" data-blob="${esc(baseline.before.displayedBlobKey)}" data-hash="${esc(baseline.before.displayedHash ?? "")}" alt="">`
            : `<div class="thumb-placeholder">${esc(t.label.trim().charAt(0).toUpperCase() || "?")}</div>`}
          <span style="flex:1;min-width:0">
            <span style="display:block;font-weight:700">${esc(t.label)}</span>
            <span class="muted small" style="display:block">${s.checkinCount} session${s.checkinCount === 1 ? "" : "s"}${s.lastSessionDate ? ` · last ${dateWithYear(s.lastSessionDate)}` : ""}</span>
          </span>
        </button>`;
      }).join("")}
      <div style="margin-top:14px">
        <button class="btn btn-primary" id="add-tattoo" type="button">+ Add tattoo</button>
      </div>
    </div>

    <div class="card">
      <h3>Files</h3>
      <p class="muted small">The client's own files first, then files attached
      to their tattoos — the same record either way, nothing is copied.</p>
      ${ownFiles.length === 0 && tattooFiles.length === 0
        ? `<p class="muted">No files attached yet.</p>` : ""}
      ${ownFiles.map((f) => fileRow(f, null)).join("")}
      ${tattooFiles.map((f) => {
        const t = tattoos.find((x) => x.id === f.tattooId);
        return fileRow(f, t ? `On tattoo: ${t.label}` : null);
      }).join("")}
      <div style="margin-top:14px">
        <button class="btn btn-quiet" id="add-file" type="button">+ Add file (consent form, …)</button>
      </div>
    </div>`;

  document.getElementById("edit-client").addEventListener("click", () => openClientForm(client));
  document.getElementById("add-tattoo").addEventListener("click", () => openTattooForm(client));
  document.getElementById("add-file").addEventListener("click", () => openFileForm({ clientId: id }));
  $app.querySelectorAll("[data-open-tattoo]").forEach((row) =>
    row.addEventListener("click", () => go(`/tattoo/${row.dataset.openTattoo}`)),
  );
  bindFileButtons($app);
  void hydrateImages($app);
}

function bindFileButtons(root) {
  root.querySelectorAll("[data-view-file]").forEach((btn) =>
    btn.addEventListener("click", () => openFile(Number(btn.dataset.viewFile), false)),
  );
  root.querySelectorAll("[data-download-file]").forEach((btn) =>
    btn.addEventListener("click", () => openFile(Number(btn.dataset.downloadFile), true)),
  );
}

async function openFile(fileId, download) {
  const file = ui.lib.files.find((f) => f.id === fileId);
  if (!file) return;
  try {
    const blob = await ensureBlob(file.blobKey, file.sha256);
    const url = URL.createObjectURL(
      new Blob([blob.bytes], { type: file.contentType || blob.contentType || "application/octet-stream" }),
    );
    if (download) {
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      window.open(url, "_blank");
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    toast("That file isn't available on this device right now.", true);
  }
}

/* ----------------------------- timeline -------------------------- */

function renderTattoo(id) {
  const tattoo = ui.lib.tattoos.find((t) => t.id === id);
  if (!tattoo) {
    $app.innerHTML = `<div class="card empty-state"><h2>Tattoo not found</h2>
      <p>This tattoo isn't in the library on this device.</p></div>`;
    return;
  }
  const client = tattoo.clientId != null
    ? ui.lib.clients.find((c) => c.id === tattoo.clientId)
    : null;
  const sessions = sessionsOf(id, ui.lib.checkins);
  const tattooFiles = ui.lib.files.filter((f) => f.tattooId === id);
  $app.innerHTML = `
    <p>${client
      ? `<a href="#/client/${client.id}">&larr; ${esc(client.name)}</a>`
      : `<a href="#/">&larr; All clients</a>`}</p>
    <div class="card">
      <h2 style="margin-bottom:2px">${esc(tattoo.label)}</h2>
      <div class="muted">${client ? esc(client.name) : "Unassigned"} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}</div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" id="add-session" type="button">+ Add session</button>
        <button class="btn btn-quiet" id="add-tattoo-file" type="button">+ Add file</button>
      </div>
      ${tattooFiles.length ? `<hr class="divider">${tattooFiles.map((f) => fileRow(f, null)).join("")}` : ""}
    </div>
    ${sessions.length === 0
      ? `<div class="card empty-state"><h2>No sessions yet</h2>
           <p>Add the first session with its Before photo.</p></div>`
      : sessions.map((checkin, i) => {
          const index = i + 1;
          const settings = formatAllSettingsLine(checkin);
          const tiles = [];
          for (const [slotName, labelSlot] of [["before", "main"], ["after", "after"]]) {
            const slot = checkin[slotName];
            if (slotHasPhoto(slot)) {
              tiles.push(`
              <button class="photo-tile" type="button"
                      data-view-photo="${checkin.id}:${slotName}">
                <img data-blob="${esc(slot.displayedBlobKey)}" data-hash="${esc(slot.displayedHash ?? "")}" alt="${esc(photoSessionLabel(index, labelSlot))}">
                <span class="photo-chip"><span>${esc(photoSessionLabel(index, labelSlot))}</span><span>${esc(dateWithYear(checkin.date))}</span></span>
              </button>`);
            }
          }
          return `
          <div class="card session-block">
            <div class="session-head">
              <h3>${esc(sessionBlockLabel(index))}</h3>
              <span class="muted">${dateWithYear(checkin.date)}</span>
              <span style="flex:1"></span>
              <button class="btn btn-ghost btn-small" data-edit-session="${checkin.id}" type="button">Edit</button>
            </div>
            ${tiles.length
              ? `<div class="photo-row">${tiles.join("")}</div>`
              : `<p class="faint" style="margin-top:8px">No photo this session</p>`}
            ${settings ? `<div class="settings-line">${esc(settings)}</div>` : ""}
            ${checkin.note ? `<div class="note-line">${esc(checkin.note)}</div>` : ""}
          </div>`;
        }).join("")}`;

  document.getElementById("add-session").addEventListener("click", () => openSessionForm(tattoo, null));
  document.getElementById("add-tattoo-file").addEventListener("click", () => openFileForm({ tattooId: id }));
  $app.querySelectorAll("[data-edit-session]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const checkin = ui.lib.checkins.find((c) => c.id === Number(btn.dataset.editSession));
      if (checkin) openSessionForm(tattoo, checkin);
    }),
  );
  $app.querySelectorAll("[data-view-photo]").forEach((tile) =>
    tile.addEventListener("click", () => {
      const [cid, slotName] = tile.dataset.viewPhoto.split(":");
      openViewer(id, Number(cid), slotName);
    }),
  );
  bindFileButtons($app);
  void hydrateImages($app);
}

/* ------------------------------ viewer --------------------------- */

const viewer = { photos: [], index: 0, scale: 1, tx: 0, ty: 0 };

function openViewer(tattooId, checkinId, slotName) {
  viewer.photos = tattooPhotos(tattooId, ui.lib.checkins);
  viewer.index = Math.max(
    0,
    viewer.photos.findIndex((p) => p.checkinId === checkinId && p.slotName === slotName),
  );
  viewer.scale = 1;
  viewer.tx = 0;
  viewer.ty = 0;
  renderViewer();
  $viewer.className = "viewer on";
}

function closeViewer() {
  $viewer.className = "viewer";
}

async function renderViewer() {
  const stage = document.getElementById("viewer-stage");
  const bar = document.getElementById("viewer-bar");
  const photo = viewer.photos[viewer.index];
  if (!photo) {
    closeViewer();
    return;
  }
  stage.innerHTML = `
    <img id="viewer-img" alt="${esc(photoSessionLabel(photo.sessionIndex, photo.slot))}">
    <span class="photo-chip"><span>${esc(photoSessionLabel(photo.sessionIndex, photo.slot))}</span><span>${esc(dateWithYear(photo.date))}</span></span>
    <div class="watermark"><div class="wm-1">Tattoo Removal Tracker</div><div class="wm-2">BY INKWASHER</div></div>`;
  const img = document.getElementById("viewer-img");
  img.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.scale})`;
  try {
    img.src = await blobUrl(photo.blobKey, photo.hash);
  } catch {
    toast("That photo isn't available on this device right now.", true);
  }
  bar.innerHTML = `
    <button class="btn btn-quiet btn-small" id="v-prev" type="button" ${viewer.index === 0 ? "disabled" : ""}>&larr; Prev</button>
    <span class="muted small">${viewer.index + 1} / ${viewer.photos.length}</span>
    <button class="btn btn-quiet btn-small" id="v-next" type="button" ${viewer.index >= viewer.photos.length - 1 ? "disabled" : ""}>Next &rarr;</button>
    <button class="btn btn-quiet btn-small" id="v-zout" type="button">Zoom −</button>
    <button class="btn btn-quiet btn-small" id="v-zin" type="button">Zoom +</button>
    <button class="btn btn-quiet btn-small" id="v-zreset" type="button">Reset</button>
    <button class="btn btn-primary btn-small" id="v-close" type="button">Close</button>`;
  const applyTransform = () => {
    img.style.transform = `translate(${viewer.tx}px, ${viewer.ty}px) scale(${viewer.scale})`;
  };
  document.getElementById("v-prev").addEventListener("click", () => {
    viewer.index -= 1; viewer.scale = 1; viewer.tx = 0; viewer.ty = 0; renderViewer();
  });
  document.getElementById("v-next").addEventListener("click", () => {
    viewer.index += 1; viewer.scale = 1; viewer.tx = 0; viewer.ty = 0; renderViewer();
  });
  document.getElementById("v-zin").addEventListener("click", () => {
    viewer.scale = Math.min(8, viewer.scale * 1.4); applyTransform();
  });
  document.getElementById("v-zout").addEventListener("click", () => {
    viewer.scale = Math.max(0.25, viewer.scale / 1.4); applyTransform();
  });
  document.getElementById("v-zreset").addEventListener("click", () => {
    viewer.scale = 1; viewer.tx = 0; viewer.ty = 0; applyTransform();
  });
  document.getElementById("v-close").addEventListener("click", closeViewer);
  stage.onwheel = (e) => {
    e.preventDefault();
    viewer.scale = Math.min(8, Math.max(0.25, viewer.scale * (e.deltaY < 0 ? 1.12 : 0.9)));
    applyTransform();
  };
  let drag = null;
  img.onpointerdown = (e) => {
    drag = { x: e.clientX - viewer.tx, y: e.clientY - viewer.ty };
    img.setPointerCapture(e.pointerId);
  };
  img.onpointermove = (e) => {
    if (!drag) return;
    viewer.tx = e.clientX - drag.x;
    viewer.ty = e.clientY - drag.y;
    applyTransform();
  };
  img.onpointerup = () => (drag = null);
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($viewer.className.includes("on")) closeViewer();
    else if (sheetOpen) closeSheet();
  }
});

/* ------------------------------- forms --------------------------- */

function openClientForm(client) {
  const editing = Boolean(client);
  openSheet(`
    <h2>${editing ? "Edit client" : "Add client"}</h2>
    <label class="field"><span>Client name</span>
      <input type="text" id="f-name" value="${esc(client?.name ?? "")}" autocomplete="off"></label>
    <label class="field"><span>Instagram handle</span>
      <input type="text" id="f-ig" value="${esc(client?.igHandle ?? "")}" placeholder="Optional" autocomplete="off"></label>
    <label class="field"><span>Phone</span>
      <input type="tel" id="f-phone" value="${esc(client?.phone ?? "")}" placeholder="Optional"></label>
    <label class="check-row">
      <input type="checkbox" id="f-posting" ${client?.allowPosting ? "checked" : ""}>
      <span>Posting consent given (photos may be posted)</span></label>
    <p class="error-text small" id="f-error" hidden></p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="f-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="f-save" type="button">${editing ? "Save" : "Add client"}</button>
    </div>`);
  document.getElementById("f-cancel").addEventListener("click", closeSheet);
  document.getElementById("f-save").addEventListener("click", async () => {
    const name = document.getElementById("f-name").value.trim();
    const err = document.getElementById("f-error");
    if (!name) {
      err.textContent = "A client needs a name.";
      err.hidden = false;
      return;
    }
    const ig = document.getElementById("f-ig").value.trim().replace(/^@/, "");
    const phone = document.getElementById("f-phone").value.trim();
    const payload = editing
      ? { ...client, name, igHandle: ig || null, phone: phone || null,
          allowPosting: document.getElementById("f-posting").checked }
      : { id: await nextLocalId("clients"), name, igHandle: ig || null,
          phone: phone || null,
          allowPosting: document.getElementById("f-posting").checked,
          createdAt: nowIso() };
    await saveLocal("clients", payload);
    await reloadLib();
    closeSheet();
    toast(editing ? "Client saved." : "Client added.");
    if (editing) render();
    else go(`/client/${payload.id}`);
    void syncNow({ quiet: true });
  });
}

function openTattooForm(client) {
  openSheet(`
    <h2>Add tattoo</h2>
    <p class="muted small">For ${esc(client.name)}. Use the design and body
    location, e.g. "Butterfly — left forearm".</p>
    <label class="field"><span>Tattoo label</span>
      <input type="text" id="f-label" autocomplete="off"></label>
    <p class="error-text small" id="f-error" hidden></p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="f-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="f-save" type="button">Add tattoo</button>
    </div>`);
  document.getElementById("f-cancel").addEventListener("click", closeSheet);
  document.getElementById("f-save").addEventListener("click", async () => {
    const label = document.getElementById("f-label").value.trim();
    const err = document.getElementById("f-error");
    if (!label) {
      err.textContent = "A tattoo needs a label (design — location).";
      err.hidden = false;
      return;
    }
    const payload = {
      id: await nextLocalId("tattoos"),
      clientId: client.id,
      label,
      autoAlign: true,
      createdAt: nowIso(),
    };
    await saveLocal("tattoos", payload);
    await reloadLib();
    closeSheet();
    toast("Tattoo added.");
    go(`/tattoo/${payload.id}`);
    void syncNow({ quiet: true });
  });
}

const STANDARD_WAVELENGTHS = [1064, 532];

function settingsFormHtml(settings) {
  const s = settings ?? { wavelengths: [], energyMj: null, fluenceJcm2: null, spotSizeMm: null };
  const chosen = new Set(s.wavelengths ?? []);
  const custom = (s.wavelengths ?? []).filter((w) => !STANDARD_WAVELENGTHS.includes(w));
  return `
    <fieldset style="border:none;padding:0;margin:14px 0 0">
      <legend class="small" style="color:var(--dim);padding:0">Laser settings</legend>
      <div class="wavelength-row" id="f-waves">
        ${STANDARD_WAVELENGTHS.map((w) =>
          `<button type="button" class="wave-chip ${chosen.has(w) ? "active" : ""}" data-wave="${w}">${w} nm</button>`).join("")}
        <button type="button" class="wave-chip" id="f-wave-add">+ Other</button>
      </div>
      <div id="f-wave-custom" ${custom.length ? "" : "hidden"}>
        <label class="field"><span>Other wavelength (nm)</span>
          <input type="number" id="f-wave-other" value="${custom[0] ?? ""}" min="1"></label>
      </div>
      <label class="field"><span>Energy (mJ)</span>
        <input type="number" id="f-energy" value="${s.energyMj ?? ""}" step="any"></label>
      <label class="field"><span>Fluence (J/cm²)</span>
        <input type="number" id="f-fluence" value="${s.fluenceJcm2 ?? ""}" step="any"></label>
      <label class="field"><span>Spot size (mm)</span>
        <input type="number" id="f-spot" value="${s.spotSizeMm ?? ""}" step="any"></label>
    </fieldset>`;
}

function bindSettingsForm() {
  document.querySelectorAll("[data-wave]").forEach((chip) =>
    chip.addEventListener("click", () => chip.classList.toggle("active")),
  );
  document.getElementById("f-wave-add").addEventListener("click", () => {
    document.getElementById("f-wave-custom").hidden = false;
  });
}

function readSettingsForm() {
  const wavelengths = [...document.querySelectorAll("[data-wave].active")]
    .map((c) => Number(c.dataset.wave));
  const other = Number(document.getElementById("f-wave-other")?.value);
  if (!document.getElementById("f-wave-custom").hidden && other > 0) {
    wavelengths.push(other);
  }
  const num = (id) => {
    const v = document.getElementById(id).value;
    return v === "" ? null : Number(v);
  };
  return {
    wavelengths,
    energyMj: num("f-energy"),
    fluenceJcm2: num("f-fluence"),
    spotSizeMm: num("f-spot"),
  };
}

async function photoFromInput(input) {
  const file = input.files?.[0];
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { blobKey, sha256 } = await ingestBlob(bytes, file.type || "image/jpeg");
  return slotFromBlob({ blobKey, sha256 });
}

function openSessionForm(tattoo, checkin) {
  const editing = Boolean(checkin);
  const today = new Date().toISOString().slice(0, 10);
  openSheet(`
    <h2>${editing ? "Edit session" : "Add session"}</h2>
    <p class="muted small">${esc(tattoo.label)}</p>
    <label class="field"><span>Date</span>
      <input type="date" id="f-date" value="${checkin?.date ?? today}"></label>
    ${editing && slotHasPhoto(checkin.before)
      ? `<p class="small faint" style="margin-top:14px">Before photo is on file — a saved photo is never replaced.</p>`
      : `<label class="field"><span>Before photo</span>
           <input type="file" id="f-before" accept="image/*"></label>`}
    ${editing && slotHasPhoto(checkin.after)
      ? `<p class="small faint" style="margin-top:14px">Immediately-after photo is on file — a saved photo is never replaced.</p>`
      : `<label class="field"><span>Immediately-after photo</span>
           <input type="file" id="f-after" accept="image/*"></label>`}
    ${settingsFormHtml(checkin?.settings)}
    <label class="field"><span>Session note</span>
      <textarea id="f-note">${esc(checkin?.note ?? "")}</textarea></label>
    <p class="error-text small" id="f-error" hidden></p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="f-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="f-save" type="button">${editing ? "Save" : "Add session"}</button>
    </div>`);
  bindSettingsForm();
  document.getElementById("f-cancel").addEventListener("click", closeSheet);
  document.getElementById("f-save").addEventListener("click", async () => {
    const err = document.getElementById("f-error");
    const date = document.getElementById("f-date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      err.textContent = "Pick a date.";
      err.hidden = false;
      return;
    }
    const beforeInput = document.getElementById("f-before");
    const afterInput = document.getElementById("f-after");
    const beforeSlot = beforeInput ? await photoFromInput(beforeInput) : null;
    const afterSlot = afterInput ? await photoFromInput(afterInput) : null;
    const note = document.getElementById("f-note").value.trim();
    const payload = editing
      ? { ...checkin, date, note: note || null, settings: readSettingsForm(),
          before: beforeSlot ?? checkin.before, after: afterSlot ?? checkin.after }
      : { id: await nextLocalId("checkins"), tattooId: tattoo.id, date,
          note: note || null, settings: readSettingsForm(),
          before: beforeSlot ?? { ...EMPTY_SLOT }, after: afterSlot ?? { ...EMPTY_SLOT },
          viewFraming: null, afterViewFraming: null, createdAt: nowIso() };
    await saveLocal("checkins", payload);
    await reloadLib();
    closeSheet();
    toast(editing ? "Session saved." : "Session added.");
    render();
    void syncNow({ quiet: true });
  });
}

function openFileForm(owner) {
  openSheet(`
    <h2>Add file</h2>
    <p class="muted small">Attach a consent form or any other file. It's stored
    in the library and syncs like everything else.</p>
    <label class="field"><span>File</span>
      <input type="file" id="f-file"></label>
    <label class="field"><span>File name</span>
      <input type="text" id="f-filename" autocomplete="off"></label>
    <p class="error-text small" id="f-error" hidden></p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="f-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="f-save" type="button">Add file</button>
    </div>`);
  const fileInput = document.getElementById("f-file");
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    const nameEl = document.getElementById("f-filename");
    if (f && !nameEl.value) nameEl.value = f.name;
  });
  document.getElementById("f-cancel").addEventListener("click", closeSheet);
  document.getElementById("f-save").addEventListener("click", async () => {
    const err = document.getElementById("f-error");
    const file = fileInput.files?.[0];
    const filename = document.getElementById("f-filename").value.trim();
    if (!file) {
      err.textContent = "Choose a file.";
      err.hidden = false;
      return;
    }
    if (!filename) {
      err.textContent = "A file needs a name.";
      err.hidden = false;
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { blobKey, sha256 } = await ingestBlob(bytes, file.type || "application/octet-stream");
    const payload = {
      id: await nextLocalId("files"),
      clientId: owner.clientId ?? null,
      tattooId: owner.tattooId ?? null,
      filename,
      contentType: file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      blobKey,
      sha256,
      createdAt: nowIso(),
    };
    await saveLocal("files", payload);
    await reloadLib();
    closeSheet();
    toast("File added.");
    render();
    void syncNow({ quiet: true });
  });
}

/* ----------------------------- downloads ------------------------- */

async function openDownloads() {
  const chosen = ui.lib.clients.filter((c) => ui.selected.has(c.id));
  if (chosen.length === 0) {
    toast("Tick at least one client to download.", true);
    return;
  }
  openSheet(`
    <h2>Download ${chosen.length} client${chosen.length === 1 ? "" : "s"}</h2>
    <p class="muted">Preparing the folders — every photo, the session notes
    and laser settings, and each client's files (consent form included).</p>
    <p class="progress-line" id="dl-progress">Starting…</p>`);
  const progress = document.getElementById("dl-progress");
  const allFiles = [];
  const missing = [];
  let total = 0;
  for (const client of chosen) {
    const plan = planClientExport(client, ui.lib);
    const assembled = await assembleExport(plan, (done, count) => {
      progress.textContent = `${client.name}: photo ${done} of ${count}…`;
    });
    allFiles.push(...assembled.files);
    missing.push(...assembled.missing);
    total += assembled.totalBytes;
  }
  const canFolder = folderPickerSupported();
  openSheet(`
    <h2>Download ${chosen.length} client${chosen.length === 1 ? "" : "s"}</h2>
    <div class="kv-row"><span class="k">Total size</span><strong>${formatBytes(total)}</strong></div>
    <div class="kv-row"><span class="k">Files</span><strong>${allFiles.length}</strong></div>
    ${total > BIG_DOWNLOAD_BYTES
      ? `<p class="error-text">This is a big download (${formatBytes(total)}). Make sure you have the space and a steady connection before saving.</p>`
      : ""}
    ${missing.length
      ? `<p class="error-text">${missing.length} photo${missing.length === 1 ? "" : "s"} couldn't be fetched (not synced to this device yet) and won't be in the folders: ${missing.map(esc).join(", ")}</p>`
      : ""}
    <label class="check-row"><input type="radio" name="dl-dest" value="folder" ${canFolder ? "checked" : "disabled"}>
      <span>Save to a folder on this computer${canFolder ? "" : " (not supported in this browser — ZIP is used instead)"}</span></label>
    <label class="check-row"><input type="radio" name="dl-dest" value="zip" ${canFolder ? "" : "checked"}>
      <span>Download as one ZIP file</span></label>
    <label class="check-row"><input type="radio" name="dl-dest" value="drive">
      <span>Save to Google Drive</span></label>
    <p class="progress-line" id="dl-progress"></p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="dl-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="dl-go" type="button">Save download</button>
    </div>`);
  document.getElementById("dl-cancel").addEventListener("click", closeSheet);
  document.getElementById("dl-go").addEventListener("click", async () => {
    const dest = document.querySelector("input[name='dl-dest']:checked")?.value ?? "zip";
    const goBtn = document.getElementById("dl-go");
    const line = document.getElementById("dl-progress");
    goBtn.disabled = true;
    try {
      if (dest === "folder") {
        await saveToFolder(allFiles);
      } else if (dest === "drive") {
        line.textContent = "Waiting for Google Drive permission…";
        const token = await requestDriveToken();
        await saveToDrive(allFiles, token, (done, count) => {
          line.textContent = `Uploading to Drive: ${done} of ${count} files…`;
        });
      } else {
        line.textContent = "Building the ZIP…";
        await saveAsZip(allFiles, "tattoo-removal-tracker-export.zip");
      }
      closeSheet();
      toast("Download saved.");
    } catch (e) {
      goBtn.disabled = false;
      line.innerHTML = `<span class="error-text">Saving didn't finish: ${esc(e.message)}</span>`;
    }
  });
}

/* ----------------------------- settings -------------------------- */

const HORIZON_ROWS = [
  [10 * 60 * 1000, "10 minutes ago"],
  [24 * 3600 * 1000, "Yesterday"],
  [7 * 24 * 3600 * 1000, "A week ago"],
];

async function renderSettings() {
  const link = readLink();
  const state = readState();
  const pending = await pendingCount();
  const horizonSnaps = [];
  for (const [ms, label] of HORIZON_ROWS) {
    horizonSnaps.push({ ms, label, snap: await snapshotForHorizon(ms) });
  }
  const redo = await redoPoint();
  $app.innerHTML = `
    <div class="card">
      <h2>Account</h2>
      <div class="kv-row"><span class="k">Signed in as</span><strong>${esc(link?.email ?? "")}</strong></div>
      <p class="muted small">The website and the app share this account's
      library. For technicians.</p>
      <button class="btn btn-quiet" id="sign-out" type="button">Sign out</button>
    </div>

    <div class="card">
      <h2>Sync</h2>
      <div class="kv-row"><span class="k">Last synced</span>
        <strong>${state.lastSyncAt ? esc(new Date(state.lastSyncAt).toLocaleString()) : "Never"}</strong></div>
      <div class="kv-row"><span class="k">Waiting to sync</span><strong>${pending}</strong></div>
      ${state.lastConflicts ? `<div class="kv-row"><span class="k">Notes from last sync</span><strong>${state.lastConflicts} item(s) merged with the app's copy</strong></div>` : ""}
      ${state.lastError ? `<p class="error-text small">${esc(state.lastError)}</p>` : ""}
      <button class="btn btn-primary" id="sync-now" type="button">Sync now</button>
    </div>

    <div class="card">
      <h2>Library rollback</h2>
      <p class="muted small">Restore the library to how it was at a point in
      time, using snapshots this browser keeps of your library. Restoring
      re-saves the older records and syncs them to your account. Records
      created after that point are hidden on this device — sync never
      deletes, so they stay in the account and would still appear on a
      fresh sign-in elsewhere. Restoring asks you to type UNDO first;
      afterwards, Redo brings back the state from just before the restore.</p>
      ${horizonSnaps.map(({ label, snap }, i) => `
        <div class="kv-row">
          <span class="k">${label}</span>
          ${snap
            ? `<span><span class="small muted">${esc(new Date(snap.takenAt).toLocaleString())}</span>
               <button class="btn btn-quiet btn-small" data-restore="${i}" type="button">Restore</button></span>`
            : `<span class="faint small">No snapshot reaches back that far yet</span>`}
        </div>`).join("")}
      ${redo ? `
        <hr class="divider">
        <div class="kv-row"><span class="k">Undo the last restore</span>
          <button class="btn btn-primary btn-small" id="redo-btn" type="button">Redo</button></div>` : ""}
    </div>

    <div class="card">
      <h2>About</h2>
      <p class="muted">Tattoo Removal Tracker <span class="micro-label" style="color:var(--mist)">by INKWASHER</span> —
      the technician's web companion to the app. Same library, same
      labels, same rules: sync only ever adds, and a saved photo is
      never replaced.</p>
    </div>`;

  document.getElementById("sign-out").addEventListener("click", () => signOut());
  document.getElementById("sync-now").addEventListener("click", () => syncNow());
  document.getElementById("redo-btn")?.addEventListener("click", async () => {
    try {
      await redoRestore();
      await reloadLib();
      toast("Restore undone — the library is back to how it was.");
      render();
    } catch (e) {
      toast(`Redo didn't finish: ${e.message}`, true);
    }
  });
  $app.querySelectorAll("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const { snap, label } = horizonSnaps[Number(btn.dataset.restore)];
      if (snap) openRestoreConfirm(snap, label);
    }),
  );
}

function openRestoreConfirm(snapshot, label) {
  openSheet(`
    <h2>Restore to ${esc(label.toLowerCase())}?</h2>
    <p class="muted">The library goes back to the snapshot from
    ${esc(new Date(snapshot.takenAt).toLocaleString())} and that state syncs
    to your account. Records created since are hidden on this device only.
    Type UNDO to confirm.</p>
    <label class="field"><span>Type UNDO</span>
      <input type="text" id="undo-input" autocomplete="off" style="text-transform:uppercase"></label>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="undo-cancel" type="button">Cancel</button>
      <span class="spacer"></span>
      <button class="btn btn-danger" id="undo-go" type="button" disabled>Restore</button>
    </div>`);
  const input = document.getElementById("undo-input");
  const goBtn = document.getElementById("undo-go");
  input.addEventListener("input", () => {
    goBtn.disabled = input.value !== "UNDO";
  });
  document.getElementById("undo-cancel").addEventListener("click", closeSheet);
  goBtn.addEventListener("click", async () => {
    goBtn.disabled = true;
    try {
      await restoreSnapshot(snapshot);
      await reloadLib();
      closeSheet();
      toast("Library restored. Redo is in Settings if you need to undo it.");
      go("/settings");
    } catch (e) {
      toast(`Restore didn't finish: ${e.message}`, true);
      closeSheet();
    }
  });
}

/* ------------------------------ render --------------------------- */

function render() {
  ui.route = parseRoute();
  if (!readLink()) {
    renderSignIn();
    return;
  }
  $header.hidden = false;
  if (ui.route.name === "client") renderClient(ui.route.id);
  else if (ui.route.name === "tattoo") renderTattoo(ui.route.id);
  else if (ui.route.name === "settings") void renderSettings();
  else renderClients();
  void refreshPill();
}

document.getElementById("nav-clients").addEventListener("click", () => go("/"));
document.getElementById("nav-settings").addEventListener("click", () => go("/settings"));

/* ------------------------------- boot ---------------------------- */

async function boot() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch {
      /* offline shell is a bonus, never a blocker */
    }
  }
  if (readLink()) {
    $header.hidden = false;
    await reloadLib();
    render();
    void syncNow({ quiet: true });
  } else {
    renderSignIn();
  }
}

/** Test seam: the headless suite drives the real modules through
 * this handle (sign-in exchange, library seeding, downloads). */
window.TRT = {
  handleGoogleCredential,
  db,
  sync: {
    runSync, readLink, writeLink, clearLink, readState, resetSyncState,
    saveLocal, nextLocalId, ensureBlob, pendingCount,
    takeSnapshot, snapshotForHorizon, restoreSnapshot, redoPoint, redoRestore,
  },
  labels: {
    buildClientList, clientThumbnail, photoSessionLabel, dateWithYear,
    formatAllSettingsLine, sessionsOf, tattooPhotos,
  },
  downloads: { planClientExport, assembleExport, formatBytes },
  config: { GOOGLE_CLIENT_ID },
};

void boot();
