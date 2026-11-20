/**
 * HTTP transport for the tracker API — the website's counterpart of
 * the app's HttpCloudTransport (app/src/engine/cloud-sync.ts). Same
 * routes, same error vocabulary:
 *   401                    -> "unauthorized"
 *   ACCOUNT_NOT_LINKED     -> "account_not_linked"
 *   transport failure/5xx  -> "network"
 *   anything else          -> "sync_failed"
 */
import { API_BASE } from "./config.js";

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function call(method, path, { token, json, bytes, headers } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(headers ?? {}),
      },
      body: bytes ?? (json !== undefined ? JSON.stringify(json) : undefined),
    });
  } catch (e) {
    throw new ApiError(
      "network",
      e instanceof Error ? e.message : "Network request failed.",
    );
  }
  if (res.status === 401) {
    throw new ApiError(
      "unauthorized",
      "The sign-in was refused. Sign in again to keep syncing.",
    );
  }
  if (!res.ok) {
    let code = "";
    let message = `Request failed (HTTP ${res.status}).`;
    try {
      const body = await res.json();
      code = body?.error?.code ?? "";
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep the generic message */
    }
    if (code === "ACCOUNT_NOT_LINKED") {
      throw new ApiError("account_not_linked", message);
    }
    throw new ApiError(res.status >= 500 ? "network" : "sync_failed", message);
  }
  return res;
}

export const api = {
  /** Google ID token -> device token (201 {deviceToken,email,userId}). */
  async exchangeGoogleIdToken(idToken) {
    const res = await call("POST", "/auth/google", { json: { idToken } });
    return res.json();
  },

  async manifest(token) {
    const res = await call("GET", "/sync/manifest", { token });
    return res.json();
  },

  async pull(token, since) {
    const res = await call("GET", `/sync/pull?since=${since}`, { token });
    return res.json();
  },

  async push(token, records) {
    const res = await call("POST", "/sync/push", { token, json: { records } });
    return res.json();
  },

  async uploadBlob(token, sha256, bytes, contentType) {
    await call("POST", "/sync/blobs", {
      token,
      bytes,
      headers: {
        "content-type": contentType || "application/octet-stream",
        "x-expected-sha256": sha256,
      },
    });
  },

  /** Downloads the blob and verifies it against the server's
   * x-sha256 header before handing the bytes back. */
  async downloadBlob(token, blobKey) {
    const res = await call("GET", `/sync/blobs/${encodeURIComponent(blobKey)}`, {
      token,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const expected = res.headers.get("x-sha256");
    const actual = await sha256Hex(bytes);
    if (expected && expected !== actual) {
      throw new ApiError(
        "sync_failed",
        "A downloaded photo failed its integrity check and was not saved.",
      );
    }
    return { bytes, sha256: actual, contentType: res.headers.get("content-type") };
  },
};
