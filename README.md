# Tattoo Removal Tracker — Website

The technician web companion to the Tattoo Removal Tracker app:
same library, same theme, same labels, same sync rules. A static
site (no server of its own) that signs technicians in with Google
and talks to the tracker backend at `https://api.inkwasher.com`.
Served from `tattooremovaltracker.com` (see `CNAME`).

**Audience: technicians only** — the site speaks to the technician
who uses the app; there is no owner/studio framing anywhere.

## How it works

- **Sign-in** — Google Identity Services (popup flow, Web OAuth
  client `314727821938-…u37vfafh`). The ID token is exchanged once
  at the API for a device token, which is all the browser keeps
  (localStorage `tattoo-tracker.cloud-sync.device`, the same key
  name the app uses). An unlinked Google account gets the API's
  `ACCOUNT_NOT_LINKED` refusal and a plain message saying so.
- **Local replica** — the whole library (clients, tattoos,
  check-ins, files) lives in IndexedDB; photos/files live in a
  content-addressed blob store (`blob-<sha256>`, SHA-256 verified
  on download). Every screen renders from the replica, so the
  site works offline; a service worker caches the app shell.
- **Sync** — the same protocol as the app's cloud sync
  (`app/src/engine/cloud-sync.ts`): state-based diff by
  `updatedAt`, pull since the `sync_seq` cursor, push of dirty
  records, blobs uploaded before the records that reference them,
  "kept-server" answers trigger a re-pull in the same run. Sync
  runs on sign-in, on demand (Settings → Sync now), and when the
  browser comes back online. **Additive only**: the site never
  pushes tombstones and never applies pulled ones as deletions —
  exactly like the app.
- **Labels** — render-time only, ported from the app: a Before
  photo reads "Before Laser" (session 1) or "After N Session(s)";
  an Immediately-after photo always reads "Immediately after
  laser"; timeline blocks read "Session" / "Session N"; every
  date carries the year ("Jun 4, 2026"); laser settings render as
  "1064 nm · 450 mJ · 1.2 J/cm² · 4 mm spot".

## Screens → API calls

All data calls send `Authorization: Bearer <device token>`.

| Screen | What it does | API calls |
| --- | --- | --- |
| Sign-in | Google popup → token exchange | `POST /v1/auth/google` `{idToken}` → `201 {deviceToken, email, userId}` |
| Clients (home) | Search + the app's six sorts, thumbnails (baseline → latest → initial), download checkboxes + "Select all" | Local replica only; kept fresh by sync: `GET /v1/sync/manifest`, `GET /v1/sync/pull?since=<cursor>`, `POST /v1/sync/push` |
| Client profile | Details, posting badge, tattoos, Files (own files first, then tattoo files tagged "On tattoo: …" — the app's aggregation, no copies) | Local replica; file view/download via `GET /v1/sync/blobs/<key>` when not cached |
| Tattoo timeline | Session blocks with Before / Immediately-after tiles, label chips, settings line, notes | Local replica; photos via blob cache / `GET /v1/sync/blobs/<key>` |
| Photo viewer | Full-screen photo, label chip, watermark, prev/next, zoom + pan | Blob cache only |
| Add / edit client, add tattoo | Local write with a fresh stamp, then sync | `POST /v1/sync/blobs` (photos/files first), `POST /v1/sync/push` |
| Add / edit session | Date, note, laser settings (1064/532 chips + "Other" behind a +), Before / Immediately-after photo into an **empty** slot — a saved photo is never replaced | Same push path |
| Add file | Consent form or any file, on a client or a tattoo | Blob upload, then push of the `files` record |
| Downloads | Checkbox-selected clients → per-client folders (photos, `session.txt` with labels/settings/notes, `client.txt`, attached files incl. the consent form); exact total size shown before saving; destinations: computer folder (File System Access), one ZIP, or Google Drive (`drive.file` scope) | Blob fetches via cache / `GET /v1/sync/blobs/<key>`; Drive via `googleapis.com/drive/v3` |
| Settings | Account, sync status + Sync now, rollback, sign out | Sync calls as above |

## Rollback — what it honestly is

Settings offers "10 minutes ago / Yesterday / A week ago",
restoring requires typing **UNDO**, and **Redo** (one press)
brings back the state captured just before a restore.

The API's change feed carries only each record's *latest* state —
there is no server-side history to rewind to. So rollback is
built on **snapshots this browser takes of the local library**
(after syncs, and before every restore). Restoring writes the
snapshot's records back with fresh stamps and pushes them, which
is what carries the restore to the account. Consequences, stated
on the Settings screen itself:

- Only points this browser has a snapshot for can be restored;
  a horizon with no snapshot says so instead of pretending.
- Records created after the restore point are **hidden on this
  device** (suppressed, the sync model's local delete) — sync
  never deletes, so they remain in the account and would appear
  on a fresh sign-in elsewhere.
- Photos are content-addressed and are not snapshotted; a restore
  never loses photo bytes.

## Files

```
index.html            shell (GIS + JSZip scripts, header, viewer, sheet)
CNAME                 tattooremovaltracker.com
sw.js                 offline app-shell cache (never caches the API)
assets/icon.png       the app icon (logo-final-v8)
assets/css/app.css    the app's theme tokens, verbatim values
assets/js/config.js   client id, API base, storage keys
assets/js/api.js      HTTP transport (the app's error vocabulary)
assets/js/db.js       IndexedDB replica + blob store + snapshots
assets/js/sync.js     sync engine, offline queue, rollback
assets/js/labels.js   label model, dates, settings lines, list maths
assets/js/downloads.js folder assembly, folder/ZIP/Drive saving
assets/js/app.js      screens, forms, viewer, settings
assets/vendor/        JSZip 3.10.1 (vendored, MIT)
tests/                headless suite (not part of the site UX)
```

## Tests

`tests/run-headless.mjs` — serves the site locally, drives headless
Chrome with a mocked API (and a stubbed Google sign-in script),
and checks: the sign-in screen + the exact client id it initializes
with, the `ACCOUNT_NOT_LINKED` message, the empty-library state,
client list/profile/timeline rendering from mock data with the
app's labels, the photo viewer, download folder assembly, and a
snapshot → mutate → restore rollback round trip. It also sanity-
checks the live API read-only (health 200; unauthenticated and
garbage-token sync calls 401). **Nothing is ever written to the
live backend by the tests.** Run: `cd tests && npm install && node
run-headless.mjs` (needs a Chrome/Chromium binary; `CHROME_PATH`
overrides the puppeteer-cache default).

## Known gaps

- **No deletes from the web** (by design): the API has no DELETE
  routes and sync is additive-only, so clients/tattoos/sessions
  can't be removed here — delete in the app. (Rollback's handling
  of post-snapshot records is the one local exception, documented
  above.)
- **No Compare / Layout / exports-with-watermark tooling**: the
  app's Compare stage, layout designer and animated exports are
  not part of the website build. The photo viewer carries the
  standard watermark pill, as the app's presentation surfaces do.
- **No photo alignment on the web**: alignment renders are made
  by the app on-device (the API flags API-added photos
  `needsAlignment` and the app clears them on sync). Photos added
  here join that queue like any API-added photo.
- **No calendar sync / booking import**: those are app features
  with no website counterpart in this build.
- **Sign-in only works from the authorized origin**
  (`https://tattooremovaltracker.com`). From any other origin
  Google refuses the popup; the sign-in screen says so plainly
  instead of failing silently.
- **Fonts load from Google Fonts**; offline, the site falls back
  to system sans (the app bundles its fonts; a static site can't
  assume the same payload budget). The shell, data and photos are
  fully offline-capable regardless.
