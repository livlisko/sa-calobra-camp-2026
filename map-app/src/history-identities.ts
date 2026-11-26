import type { ComparisonEffort } from "./comparison";

export interface IdentityDecision {
  key: string;
  olderId: string;
  fitId: string;
  same: boolean;
}

export interface HistoryRows {
  efforts: ComparisonEffort[];
  aliases: IdentityDecision[];
}

export interface IdentityQuestion {
  older: ComparisonEffort;
  fit: ComparisonEffort;
  key: string;
}

export function fitIdentity(version: string, start: number, end: number): string {
  return `fit:${version}:${start}:${end}`;
}

export function migratedEffort(stored: ComparisonEffort): ComparisonEffort {
  // Copy only the summary fields emitted by the old application.
  const { effortId, segmentId, segmentVersionKey, activityDate, elapsedSeconds, averagePowerW,
    averageHeartRateBpm, scope, matchStatus, source, label, quality, coverage, rankSnapshot } = stored;
  const effort: ComparisonEffort = {
    effortId, segmentId, segmentVersionKey, activityDate, elapsedSeconds, averagePowerW,
    averageHeartRateBpm, scope, matchStatus, source, label, quality,
  };
  if (coverage) {
    const { power, heartRate, cadence, altitude } = coverage;
    effort.coverage = { power, heartRate, cadence, altitude };
  }
  if (rankSnapshot) {
    const { position, fieldSize, scope, capturedDate } = rankSnapshot;
    effort.rankSnapshot = { position, fieldSize, scope, capturedDate };
  }
  // V1 rounded its elapsed metric to seconds, including when an interpolated
  // boundary fell between samples. Those rows cannot supply an exact end.
  const start = Date.parse(effort.activityDate);
  const duration = effort.elapsedSeconds;
  if (effort.source === "fit-derived" && effort.segmentVersionKey && effort.activityDate.includes("T") &&
      duration !== null && duration > 0 && !Number.isInteger(duration) && Number.isInteger(duration * 1000)) {
    const end = start + duration * 1000;
    if (Number.isFinite(new Date(end).getTime())) {
      return { ...effort, endedAtIso: new Date(end).toISOString(), effortId: fitIdentity(effort.segmentVersionKey, start, end) };
    }
  }
  return effort;
}

export function emptyRows(): HistoryRows {
  return { efforts: [], aliases: [] };
}

// Earlier rows win. An explicit/timestamped identity survives a reimport with
// different sensors, source IDs or file order.
export function mergeRows(first: HistoryRows, second: HistoryRows): HistoryRows {
  const efforts = new Map(first.efforts.map((row) => [row.effortId, row]));
  for (const row of second.efforts) if (!efforts.has(row.effortId)) efforts.set(row.effortId, row);
  const aliases = new Map(first.aliases.map((row) => [row.key, row]));
  for (const row of second.aliases) {
    if (aliases.has(row.key)) continue;
    if (row.same && [...aliases.values()].some((existing) => existing.same && existing.olderId === row.olderId)) continue;
    aliases.set(row.key, row);
  }
  return { efforts: [...efforts.values()], aliases: [...aliases.values()] };
}

const campDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
});

function mayBeSame(older: ComparisonEffort, fit: ComparisonEffort): boolean {
  if (older.segmentVersionKey !== fit.segmentVersionKey || fit.source !== "fit-derived" || older === fit) return false;
  if (older.source === "published-reviewed") {
    const parts = Object.fromEntries(campDay.formatToParts(new Date(fit.activityDate)).map((part) => [part.type, part.value]));
    return older.activityDate === `${parts.year}-${parts.month}-${parts.day}`;
  }
  return Boolean(fit.endedAtIso) && Date.parse(older.activityDate) === Date.parse(fit.activityDate) && older.elapsedSeconds === fit.elapsedSeconds;
}

export function resolveIdentities(rows: HistoryRows): { counted: ComparisonEffort[]; questions: IdentityQuestion[] } {
  // A date-only reference can be linked to an older FIT summary, which can in
  // turn link to its precise reimport. Follow that chain to its most precise
  // row so earlier same/separate choices survive migration and reimport.
  const same = new Map(rows.aliases.filter((row) => row.same).map((row) => [row.olderId, row.fitId]));
  const representative = (id: string) => {
    const target = same.get(id) ?? id;
    return same.get(target) ?? target;
  };
  const distinct = new Set(rows.aliases.filter((row) => !row.same).map((row) =>
    JSON.stringify([representative(row.olderId), representative(row.fitId)])));
  const candidates = rows.efforts.filter((row) => representative(row.effortId) === row.effortId);
  const firstSeen = new Map<string, number>();
  for (const row of rows.efforts) {
    const id = representative(row.effortId);
    firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, row.addedAt ?? 0));
  }
  const hidden = new Set<string>();
  const questions: IdentityQuestion[] = [];
  // Resolve legacy-vs-precise uncertainty before counting published references.
  const ambiguous = candidates.filter((row) => !row.endedAtIso)
    .sort((a, b) => Number(a.source === "published-reviewed") - Number(b.source === "published-reviewed"));
  for (const older of ambiguous) {
    if (hidden.has(older.effortId)) continue;
    const possible = candidates.filter((fit) => !hidden.has(fit.effortId) && mayBeSame(older, fit));
    const pending = possible.filter((fit) => {
      const key = JSON.stringify([older.effortId, fit.effortId]);
      if (distinct.has(key)) return false;
      questions.push({ older, fit, key });
      return true;
    });
    if (!pending.length) continue;
    // A partial decision about the date-only row must never replace one of
    // two independently timed ascents in the comparison.
    if (possible.length > 1 || pending.some((fit) => firstSeen.get(fit.effortId)! < firstSeen.get(older.effortId)!)) hidden.add(older.effortId);
    else hidden.add(pending[0].effortId);
  }
  return { counted: candidates.filter((row) => !hidden.has(row.effortId)), questions };
}
