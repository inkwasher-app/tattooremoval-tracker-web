/**
 * Labels, dates, settings lines and library derivations — a direct
 * port of the phone app's render-time rules (app/src/ui/photo-labels.tsx,
 * app/src/ui/photos-grid.ts, app/src/ui/ported-app.tsx formatSettingsLine,
 * server/src/records.ts derivations). Labels are RENDER-TIME ONLY:
 * nothing here writes to a stored record.
 */

export const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jun 4, 2026" — every label date carries the year. */
export function dateWithYear(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return String(iso);
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

/**
 * One photo's session label (the app's completed-sessions model):
 *  - after slot, any session: "Immediately after laser" (no number)
 *  - before slot, session 1: "Before Laser" (the only one)
 *  - before slot, session N>=2: "After (N-1) Session(s)"
 */
export function photoSessionLabel(sessionIndex, slot) {
  if (slot === "after") return "Immediately after laser";
  if (sessionIndex <= 1) return "Before Laser";
  const done = sessionIndex - 1;
  return `After ${done} Session${done === 1 ? "" : "s"}`;
}

/** Timeline block heading: session 1 -> "Session", N -> "Session N". */
export function sessionBlockLabel(sessionIndex) {
  if (sessionIndex <= 1) return "Session";
  return `Session ${sessionIndex}`;
}

function fmtSettingNum(n) {
  return String(Math.round(n * 1000) / 1000);
}

/** "1064 nm · 450 mJ · 1.2 J/cm² · 4 mm spot" — null when unset.
 * Handles the single settings object and, when a payload carries
 * several sets, joins their lines with "; " (the app's
 * formatSettingsSetsLine). */
export function formatSettingsLine(s) {
  if (!s) return null;
  const parts = [];
  if (s.laserName) parts.push(String(s.laserName));
  if (Array.isArray(s.wavelengths) && s.wavelengths.length > 0) {
    parts.push(`${s.wavelengths.map(fmtSettingNum).join(" + ")} nm`);
  }
  if (s.energyMj != null) parts.push(`${fmtSettingNum(s.energyMj)} mJ`);
  if (s.fluenceJcm2 != null) parts.push(`${fmtSettingNum(s.fluenceJcm2)} J/cm²`);
  if (s.spotSizeMm != null) parts.push(`${fmtSettingNum(s.spotSizeMm)} mm spot`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatAllSettingsLine(checkin) {
  const sets = checkin?.settingsSets;
  if (Array.isArray(sets) && sets.length > 0) {
    const lines = sets.map(formatSettingsLine).filter(Boolean);
    if (lines.length > 0) return lines.join("; ");
  }
  return formatSettingsLine(checkin?.settings);
}

/* ------------------------- derivations --------------------------- */

export function slotHasPhoto(slot) {
  return Boolean(slot && slot.displayedBlobKey);
}

/** A tattoo's sessions in session order: by date, createdAt as the
 * tiebreak. The 1-based position in this array IS the session
 * index every label uses; photo-less check-ins count. */
export function sessionsOf(tattooId, checkins) {
  return checkins
    .filter((c) => c.tattooId === tattooId)
    .slice()
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        a.id - b.id,
    );
}

export function tattooSummary(tattoo, checkins) {
  const own = sessionsOf(tattoo.id, checkins);
  const photoSessions = own.filter((c) => slotHasPhoto(c.before));
  return {
    ...tattoo,
    checkinCount: own.length,
    photoCount: photoSessions.length,
    lastSessionDate: own.length ? own[own.length - 1].date : null,
    baselineCheckinId: photoSessions.length ? photoSessions[0].id : null,
  };
}

/** Client list rows, mirroring server/src/records.ts buildClientList:
 * sessionCount counts UNIQUE session dates across the client's
 * tattoos; date sorts put clients with no sessions LAST either way. */
export function buildClientList(clients, tattoos, checkins, search, sort) {
  const q = (search ?? "").trim().toLowerCase();
  const items = clients
    .filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.igHandle ?? "").toLowerCase().includes(q),
    )
    .map((client) => {
      const own = tattoos.filter((t) => t.clientId === client.id);
      const ownIds = new Set(own.map((t) => t.id));
      const dates = new Set(
        checkins.filter((c) => ownIds.has(c.tattooId)).map((c) => c.date),
      );
      return {
        ...client,
        tattooCount: own.length,
        sessionCount: dates.size,
        lastSessionDate: dates.size ? [...dates].sort().pop() : null,
      };
    });
  const byDate = (get, dir) => (a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av == null && bv == null) return a.name.localeCompare(b.name);
    if (av == null) return 1; // nulls last, both directions
    if (bv == null) return -1;
    return dir * av.localeCompare(bv) || a.name.localeCompare(b.name);
  };
  const byNum = (get, dir) => (a, b) =>
    dir * (get(a) - get(b)) || a.name.localeCompare(b.name);
  switch (sort) {
    case "leastRecent":
      return items.sort(byDate((c) => c.lastSessionDate, 1));
    case "mostSessions":
      return items.sort(byNum((c) => c.sessionCount, -1));
    case "fewestSessions":
      return items.sort(byNum((c) => c.sessionCount, 1));
    case "newestClients":
      return items.sort(byDate((c) => c.createdAt, -1));
    case "oldestClients":
      return items.sort(byDate((c) => c.createdAt, 1));
    case "mostRecent":
    default:
      return items.sort(byDate((c) => c.lastSessionDate, -1));
  }
}

export const CLIENT_SORTS = [
  ["mostRecent", "Most recent session"],
  ["leastRecent", "Least recent session"],
  ["mostSessions", "Most sessions"],
  ["fewestSessions", "Fewest sessions"],
  ["newestClients", "Newest clients"],
  ["oldestClients", "Oldest clients"],
];

/**
 * Client thumbnail (the app's rule): the baseline (session-1
 * Before) photo of the client's earliest tattoo that has one;
 * otherwise the latest photo anywhere in the client's library;
 * otherwise null (the UI renders the initial-letter placeholder).
 * Returns { blobKey, hash } or null.
 */
export function clientThumbnail(clientId, tattoos, checkins) {
  const own = tattoos
    .filter((t) => t.clientId === clientId)
    .slice()
    .sort(
      (a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        a.id - b.id,
    );
  for (const t of own) {
    const sessions = sessionsOf(t.id, checkins);
    const baseline = sessions.find((c) => slotHasPhoto(c.before));
    if (baseline) {
      return {
        blobKey: baseline.before.displayedBlobKey,
        hash: baseline.before.displayedHash,
      };
    }
  }
  let latest = null;
  for (const t of own) {
    for (const c of sessionsOf(t.id, checkins)) {
      for (const slotName of ["before", "after"]) {
        const slot = c[slotName];
        if (slotHasPhoto(slot)) {
          if (!latest || c.date >= latest.date) {
            latest = {
              date: c.date,
              blobKey: slot.displayedBlobKey,
              hash: slot.displayedHash,
            };
          }
        }
      }
    }
  }
  return latest ? { blobKey: latest.blobKey, hash: latest.hash } : null;
}

/** Every photo of a tattoo in timeline order, for the viewer:
 * [{ checkinId, sessionIndex, slot, date, blobKey, hash }]. */
export function tattooPhotos(tattooId, checkins) {
  const out = [];
  sessionsOf(tattooId, checkins).forEach((c, i) => {
    for (const slotName of ["before", "after"]) {
      const slot = c[slotName];
      if (slotHasPhoto(slot)) {
        out.push({
          checkinId: c.id,
          sessionIndex: i + 1,
          slot: slotName === "before" ? "main" : "after",
          slotName,
          date: c.date,
          blobKey: slot.displayedBlobKey,
          hash: slot.displayedHash,
        });
      }
    }
  });
  return out;
}
