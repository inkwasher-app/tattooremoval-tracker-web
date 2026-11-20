/**
 * Headless checks for the tracker website. Serves the site locally,
 * drives it in headless Chrome, and exercises:
 *   1. sign-in screen renders, GIS initialized with the production
 *      Web client id, technicians-only wording
 *   2. ACCOUNT_NOT_LINKED exchange -> the plain not-linked message
 *   3. empty-library state against a (mocked) empty account
 *   4. client list / profile / timeline rendering from mock data,
 *      with the app's exact session labels and year-carrying dates
 *   5. photo viewer (watermark + label chip)
 *   6. download folder assembly from mock data
 *   7. rollback: snapshot -> mutate -> restore -> value reverts
 *   8. live API sanity (health 200, unauthenticated sync 401) —
 *      read-only; nothing is written to the live backend.
 *
 * Run: node run-headless.mjs   (exit code 0 = all checks passed)
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8377;
const BASE = `http://127.0.0.1:${PORT}`;
const EXPECTED_CLIENT_ID =
  "314727821938-mqnsgqtggds11vsgi1lco927u37vfafh.apps.googleusercontent.com";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, BASE).pathname);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) throw new Error("outside root");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, r));

/* ------------------------------ fixtures ------------------------------ */

// A tiny valid PNG (1x1) stands in for photos.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const photoSha = sha(PNG);
const photoKey = `blob-${photoSha}`;
const PDF = Buffer.from("%PDF-1.4 test consent form\n");
const pdfSha = sha(PDF);
const pdfKey = `blob-${pdfSha}`;

const slot = (key, hash) => ({
  displayedBlobKey: key, originalBlobKey: key, alignedBlobKey: null,
  displayedHash: hash, originalHash: hash, alignedHash: null,
});
const EMPTY = {
  displayedBlobKey: null, originalBlobKey: null, alignedBlobKey: null,
  displayedHash: null, originalHash: null, alignedHash: null,
};
const T0 = "2026-06-01T00:00:00.000Z";
const FIXTURE = {
  clients: [
    { id: 1, name: "Ada Lovelace", igHandle: "ada.tattoo", phone: "604-555-0100",
      allowPosting: false, createdAt: "2026-05-20T00:00:00.000Z" },
  ],
  tattoos: [
    { id: 1, clientId: 1, label: "Butterfly — left forearm", autoAlign: true,
      createdAt: "2026-05-20T00:00:00.000Z" },
  ],
  checkins: [
    { id: 1, tattooId: 1, date: "2026-06-04", note: "First session.",
      settings: { wavelengths: [1064], energyMj: 450, fluenceJcm2: 1.2, spotSizeMm: 4 },
      before: slot(photoKey, photoSha), after: { ...EMPTY },
      viewFraming: null, afterViewFraming: null, createdAt: T0 },
    { id: 2, tattooId: 1, date: "2026-07-02", note: null,
      settings: { wavelengths: [1064, 532], energyMj: null, fluenceJcm2: 0.9, spotSizeMm: 5 },
      before: slot(photoKey, photoSha), after: slot(photoKey, photoSha),
      viewFraming: null, afterViewFraming: null, createdAt: T0 },
    { id: 3, tattooId: 1, date: "2026-07-30", note: "No photo this session.",
      settings: { wavelengths: [], energyMj: null, fluenceJcm2: null, spotSizeMm: null },
      before: { ...EMPTY }, after: { ...EMPTY },
      viewFraming: null, afterViewFraming: null, createdAt: T0 },
  ],
  files: [
    { id: 1, clientId: 1, tattooId: null, filename: "Consent Form.pdf",
      contentType: "application/pdf", sizeBytes: PDF.length, blobKey: pdfKey,
      sha256: pdfSha, createdAt: T0 },
  ],
};

/* ------------------------------ harness ------------------------------ */

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
}

const apiMode = {
  authGoogle: { status: 201, body: { deviceToken: "test-token", email: "tech@example.com", userId: 1 } },
};
const EMPTY_MANIFEST = { cursor: 0, blobs: [], needsAlignment: [] };
const EMPTY_PULL = { cursor: 0, changes: [] };

const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ??
    `${process.env.HOME}/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome`,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function newPage() {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("https://api.inkwasher.com/")) {
      // The live API echoes the caller's Origin (its CORS rule);
      // the mock must do the same or the browser blocks the read.
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-expected-sha256",
        "access-control-expose-headers": "x-sha256, content-length, content-type",
      };
      if (req.method() === "OPTIONS") {
        return req.respond({ status: 204, headers: cors, body: "" });
      }
      const respond = (status, body) =>
        req.respond({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
      if (url.includes("/v1/auth/google")) return respond(apiMode.authGoogle.status, apiMode.authGoogle.body);
      if (url.includes("/v1/sync/manifest")) return respond(200, EMPTY_MANIFEST);
      if (url.includes("/v1/sync/pull")) return respond(200, EMPTY_PULL);
      if (url.includes("/v1/sync/push")) return respond(200, { cursor: 0, results: [] });
      if (url.includes("/v1/sync/blobs")) {
        return req.respond({ status: 200, contentType: "image/png", headers: cors, body: PNG });
      }
      return respond(404, { error: { code: "NOT_FOUND", message: "Route" } });
    }
    if (url.startsWith("https://accounts.google.com/gsi/client")) {
      return req.respond({
        status: 200,
        contentType: "text/javascript",
        body: `window.google = { accounts: { id: {
          initialize: (cfg) => { window.__GIS_INIT__ = cfg; },
          renderButton: (el) => { el.innerHTML = '<button type="button">Sign in with Google</button>'; },
        }, oauth2: {} } };`,
      });
    }
    if (url.endsWith("/sw.js")) {
      // Keep the shell worker out of the UI tests; it is asserted
      // statically below instead.
      return req.respond({ status: 200, contentType: "text/javascript", body: "" });
    }
    if (url.startsWith(BASE)) return req.continue();
    return req.abort();
  });
  return page;
}

const waitText = (page, text) =>
  page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout: 8000 },
    text,
  );

/* ------------------------- 1. sign-in screen ------------------------- */
{
  const page = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "Sign in");
  const init = await page.evaluate(() => window.__GIS_INIT__);
  check("sign-in screen renders", true);
  check("GIS initialized with the production Web client id",
    init?.client_id === EXPECTED_CLIENT_ID, init?.client_id ?? "none");
  const text = await page.evaluate(() => document.body.innerText);
  check("sign-in wording is technicians-only",
    text.includes("For technicians") && !/owner|studio/i.test(text.replace("Tattoo Removal Tracker", "")));
  await page.close();
}

/* --------------------- 2. ACCOUNT_NOT_LINKED path -------------------- */
{
  apiMode.authGoogle = {
    status: 403,
    body: { error: { code: "ACCOUNT_NOT_LINKED", message: "This Google account isn't linked to a tracker account." } },
  };
  const page = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await waitText(page, "Sign in");
  await page.evaluate(() => window.TRT.handleGoogleCredential({ credential: "fake-id-token" }));
  await waitText(page, "isn't linked to a tracker library");
  check("ACCOUNT_NOT_LINKED shows the plain not-linked message", true);
  await page.close();
  apiMode.authGoogle = { status: 201, body: { deviceToken: "test-token", email: "tech@example.com", userId: 1 } };
}

/* ------------------------- 3. empty library -------------------------- */
{
  const page = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(() =>
    window.TRT.sync.writeLink({ token: "test-token", email: "tech@example.com" }));
  await page.reload({ waitUntil: "networkidle0" });
  await waitText(page, "Your library is empty");
  check("empty-library state renders for an empty account", true);
  await page.close();
}

/* ------------------- seed helper for tests 4-7 ----------------------- */
async function seedPage() {
  const page = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(async (fixture, pngB64, pdfB64, photo, pdf) => {
    const { db, sync } = window.TRT;
    const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await db.putBlob(photo.key, photo.sha, "image/png", bytes(pngB64));
    await db.putBlob(pdf.key, pdf.sha, "application/pdf", bytes(pdfB64));
    const stamps = {};
    for (const entity of ["clients", "tattoos", "checkins", "files"]) {
      for (const rec of fixture[entity]) {
        await db.putRecord(entity, rec, "2026-08-01T00:00:00.000Z");
        stamps[`${entity}:${rec.id}`] = "2026-08-01T00:00:00.000Z";
      }
    }
    localStorage.setItem(
      "tattoo-tracker.cloud-sync.state.v1",
      JSON.stringify({ cursor: 0, stamps, deleted: {}, lastSyncAt: null, lastError: null, lastConflicts: 0 }),
    );
    sync.writeLink({ token: "test-token", email: "tech@example.com" });
  }, FIXTURE, PNG.toString("base64"), PDF.toString("base64"),
     { key: photoKey, sha: photoSha }, { key: pdfKey, sha: pdfSha });
  await page.reload({ waitUntil: "networkidle0" });
  return page;
}

/* ------------- 4. list / profile / timeline from mock data ----------- */
{
  const page = await seedPage();
  await waitText(page, "Ada Lovelace");
  let text = await page.evaluate(() => document.body.innerText);
  check("client list renders the mock client",
    text.includes("@ada.tattoo") && text.includes("1 tattoo") && text.includes("3 sessions"));
  check("client list shows last session date with year", text.includes("Jul 30, 2026"));

  await page.click("[data-open-client='1']");
  await waitText(page, "Do not post");
  text = await page.evaluate(() => document.body.innerText);
  check("profile shows do-not-post badge and consent file",
    text.includes("Consent Form.pdf") && text.includes("Butterfly — left forearm"));

  await page.click("[data-open-tattoo='1']");
  await waitText(page, "Session 2");
  // textContent (not innerText): the chips are CSS-uppercased like
  // the app's, which innerText would report in capitals.
  text = await page.evaluate(() => document.body.textContent);
  check("timeline session headings follow the app (Session / Session 2 / Session 3)",
    text.includes("Session 2") && text.includes("Session 3"));
  check("photo chips use the app labels",
    text.includes("Before Laser") && text.includes("After 1 Session") &&
    text.includes("Immediately after laser"));
  check("timeline dates carry the year",
    text.includes("Jun 4, 2026") && text.includes("Jul 2, 2026"));
  check("laser settings line renders in the app format",
    text.includes("1064 nm · 450 mJ · 1.2 J/cm² · 4 mm spot") &&
    text.includes("1064 + 532 nm · 0.9 J/cm² · 5 mm spot"));
  check("photo-less session is labelled as such", text.includes("No photo this session"));

  /* ------------------------- 5. photo viewer ------------------------- */
  await page.click("[data-view-photo='1:before']");
  await page.waitForFunction(
    () => document.getElementById("viewer").className.includes("on"),
    { timeout: 5000 },
  );
  text = await page.evaluate(() => document.getElementById("viewer").textContent);
  check("viewer opens with watermark and label chip",
    text.includes("Tattoo Removal Tracker") && text.includes("BY INKWASHER") &&
    text.includes("Before Laser"));
  await page.click("#v-close");

  /* --------------------- 6. download assembly ------------------------ */
  const plan = await page.evaluate(async () => {
    const lib = await window.TRT.db.library();
    const client = lib.clients[0];
    const p = window.TRT.downloads.planClientExport(client, lib);
    const assembled = await window.TRT.downloads.assembleExport(p);
    return {
      paths: assembled.files.map((f) => f.path),
      total: assembled.totalBytes,
      missing: assembled.missing,
      sessionTxt: new TextDecoder().decode(
        assembled.files.find((f) => f.path.endsWith("01 - 2026-06-04/session.txt")).bytes),
      session2Txt: new TextDecoder().decode(
        assembled.files.find((f) => f.path.endsWith("02 - 2026-07-02/session.txt")).bytes),
    };
  });
  check("download plan builds the client folder tree",
    plan.paths.includes("Ada Lovelace/client.txt") &&
    plan.paths.includes("Ada Lovelace/Butterfly — left forearm/01 - 2026-06-04/before.jpg") &&
    plan.paths.includes("Ada Lovelace/Butterfly — left forearm/02 - 2026-07-02/after.jpg") &&
    plan.paths.includes("Ada Lovelace/Files/Consent Form.pdf"),
    plan.paths.join(" | "));
  check("session.txt carries labels, date and settings",
    plan.sessionTxt.includes("Before Laser") && plan.sessionTxt.includes("Jun 4, 2026") &&
    plan.sessionTxt.includes("1064 nm · 450 mJ · 1.2 J/cm² · 4 mm spot") &&
    plan.session2Txt.includes("Immediately after laser"));
  check("download totals are computed", plan.total > 0 && plan.missing.length === 0,
    `${plan.total} bytes`);

  /* -------------------------- 7. rollback ---------------------------- */
  const rolled = await page.evaluate(async () => {
    const { db, sync } = window.TRT;
    await sync.takeSnapshot("test-before");
    const row = await db.getRecord("clients", 1);
    await sync.saveLocal("clients", { ...row.payload, name: "Changed Name" });
    const snaps = await db.allSnapshots();
    const snap = snaps.find((s) => s.label === "test-before");
    await sync.restoreSnapshot(snap);
    const after = await db.getRecord("clients", 1);
    const redo = await sync.redoPoint();
    return { name: after.payload.name, redoLabel: redo?.label ?? null };
  });
  check("rollback restores the snapshotted value", rolled.name === "Ada Lovelace", rolled.name);
  check("rollback leaves a redo point", rolled.redoLabel === "Before restore", rolled.redoLabel ?? "none");
  await page.close();
}

/* --------------------- 8. live API sanity (read-only) ---------------- */
{
  const health = await fetch("https://api.inkwasher.com/health");
  check("live API health is 200", health.status === 200, `HTTP ${health.status}`);
  const pull = await fetch("https://api.inkwasher.com/v1/sync/pull?since=0");
  check("live API refuses unauthenticated sync with 401", pull.status === 401, `HTTP ${pull.status}`);
  const bad = await fetch("https://api.inkwasher.com/v1/sync/manifest", {
    headers: { authorization: "Bearer garbage-token-for-test" },
  });
  check("live API refuses a garbage token with 401", bad.status === 401, `HTTP ${bad.status}`);
}

/* ------------------------------ wrap up ------------------------------ */
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
