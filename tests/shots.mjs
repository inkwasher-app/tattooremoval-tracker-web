import http from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import puppeteer from "puppeteer-core";
const ROOT = "/home/hatch/workspace/tracker-web";
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    const body = await readFile(path.join(ROOT, p));
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
    res.writeHead(200, { "content-type": mime[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8379, r));
const browser = await puppeteer.launch({
  executablePath: `${process.env.HOME}/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome`,
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
// A larger, visible photo: solid-colour SVG converted? Use a 200x200 PNG via canvas in-page instead.
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-expected-sha256",
  "access-control-expose-headers": "x-sha256, content-length, content-type",
};
async function wire(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("https://api.inkwasher.com/")) {
      if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors, body: "" });
      if (url.includes("/sync/manifest")) return req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ cursor: 0, blobs: [], needsAlignment: [] }) });
      if (url.includes("/sync/pull")) return req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ cursor: 0, changes: [] }) });
      if (url.includes("/sync/push")) return req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ cursor: 0, results: [] }) });
      if (url.includes("/sync/blobs")) return req.respond({ status: 200, contentType: "image/png", headers: cors, body: PNG });
      return req.respond({ status: 404, contentType: "application/json", headers: cors, body: "{}" });
    }
    if (url.startsWith("https://accounts.google.com/gsi/client")) return req.respond({ status: 200, contentType: "text/javascript", body: "window.google={accounts:{id:{initialize:()=>{},renderButton:(el)=>{el.innerHTML='<button style=\"padding:10px 22px;border-radius:999px\">Sign in with Google</button>'}},oauth2:{}}};" });
    if (url.endsWith("/sw.js")) return req.respond({ status: 200, contentType: "text/javascript", body: "" });
    if (url.startsWith("http://127.0.0.1:8379")) return req.continue();
    return req.abort();
  });
}
const page = await browser.newPage();
await wire(page);
await page.setViewport({ width: 1280, height: 900 });
await page.goto("http://127.0.0.1:8379", { waitUntil: "networkidle0" });
await page.screenshot({ path: "/tmp/shot-signin.png" });
// Seed a colourful photo via canvas: draw a gradient tattoo-ish blob, export PNG bytes.
await page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 400; c.height = 400;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 400, 400);
  grad.addColorStop(0, "#caa27e"); grad.addColorStop(1, "#8a6844");
  g.fillStyle = grad; g.fillRect(0, 0, 400, 400);
  g.strokeStyle = "#222"; g.lineWidth = 10;
  g.beginPath(); g.moveTo(200, 90); g.bezierCurveTo(90, 200, 200, 320, 200, 200);
  g.bezierCurveTo(200, 320, 310, 200, 200, 90); g.stroke();
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `blob-${sha}`;
  const { db, sync } = window.TRT;
  await db.putBlob(key, sha, "image/png", bytes);
  const slot = { displayedBlobKey: key, originalBlobKey: key, alignedBlobKey: null, displayedHash: sha, originalHash: sha, alignedHash: null };
  const EMPTY = { displayedBlobKey: null, originalBlobKey: null, alignedBlobKey: null, displayedHash: null, originalHash: null, alignedHash: null };
  const stamps = {};
  const put = async (e, rec) => { await db.putRecord(e, rec, "2026-08-01T00:00:00.000Z"); stamps[`${e}:${rec.id}`] = "2026-08-01T00:00:00.000Z"; };
  await put("clients", { id: 1, name: "Ada Lovelace", igHandle: "ada.tattoo", phone: "604-555-0100", allowPosting: false, createdAt: "2026-05-20T00:00:00.000Z" });
  await put("clients", { id: 2, name: "Grace Hopper", igHandle: null, phone: null, allowPosting: true, createdAt: "2026-06-11T00:00:00.000Z" });
  await put("tattoos", { id: 1, clientId: 1, label: "Butterfly — left forearm", autoAlign: true, createdAt: "2026-05-20T00:00:00.000Z" });
  await put("checkins", { id: 1, tattooId: 1, date: "2026-06-04", note: "First session.", settings: { wavelengths: [1064], energyMj: 450, fluenceJcm2: 1.2, spotSizeMm: 4 }, before: slot, after: { ...EMPTY }, viewFraming: null, afterViewFraming: null, createdAt: "2026-06-01T00:00:00.000Z" });
  await put("checkins", { id: 2, tattooId: 1, date: "2026-07-02", note: null, settings: { wavelengths: [1064, 532], energyMj: null, fluenceJcm2: 0.9, spotSizeMm: 5 }, before: slot, after: slot, viewFraming: null, afterViewFraming: null, createdAt: "2026-06-01T00:00:00.000Z" });
  localStorage.setItem("tattoo-tracker.cloud-sync.state.v1", JSON.stringify({ cursor: 0, stamps, deleted: {}, lastSyncAt: null, lastError: null, lastConflicts: 0 }));
  sync.writeLink({ token: "t", email: "tech@example.com" });
});
await page.reload({ waitUntil: "networkidle0" });
await page.waitForFunction(() => document.body.innerText.includes("Ada Lovelace"), { timeout: 8000 });
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: "/tmp/shot-clients.png" });
await page.click("[data-open-client='1']");
await page.waitForFunction(() => document.body.innerText.includes("Do not post"), { timeout: 8000 });
await page.screenshot({ path: "/tmp/shot-profile.png" });
await page.click("[data-open-tattoo='1']");
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: "/tmp/shot-timeline.png" });
await page.setViewport({ width: 390, height: 844 });
await page.goto("http://127.0.0.1:8379/#/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: "/tmp/shot-phone.png" });
await browser.close(); server.close();
console.log("shots done");
