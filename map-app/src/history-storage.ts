import type { ComparisonEffort } from "./comparison";
import { emptyRows, mergeRows, migratedEffort } from "./history-identities";
import type { HistoryRows, IdentityDecision } from "./history-identities";

const DATABASE = "mallorca-camp-segment-history";
const LEGACY = "mallorca-camp-segment-history-v1";
const STORES = ["metadata", "attempts", "aliases"];
export interface HistoryMetadata {
  remembered: boolean;
  generation: number;
  lastForget: number;
  lastForgetAt?: number;
  migration: "done" | "damaged";
}
export interface StoredHistory extends HistoryRows {
  meta: HistoryMetadata;
  warning?: string;
}
export type HistoryChange =
  | { kind: "read" }
  | { kind: "add" | "enable"; generation: number; rows: HistoryRows }
  | { kind: "forget" | "disable" };

export const initialMetadata = (): HistoryMetadata => ({
  remembered: false, generation: 0, lastForget: 0, migration: "done",
});

function validMetadata(meta: HistoryMetadata): boolean {
  return Boolean(meta && typeof meta.remembered === "boolean" &&
    Number.isSafeInteger(meta.generation) && meta.generation >= 0 &&
    Number.isSafeInteger(meta.lastForget) && meta.lastForget >= 0 && meta.lastForget <= meta.generation &&
    (meta.migration === "done" || meta.migration === "damaged"));
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DATABASE, 1);
    let blocked = false;
    req.onupgradeneeded = () => {
      req.result.createObjectStore("metadata");
      req.result.createObjectStore("attempts", { keyPath: "effortId" });
      req.result.createObjectStore("aliases", { keyPath: "key" });
    };
    req.onblocked = () => {
      blocked = true;
      reject(new Error("Close other atlas tabs and retry browser storage."));
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      if (blocked) req.result.close();
      else resolve(req.result);
    };
  });
}

function readLegacy(valid: (effort: unknown) => effort is ComparisonEffort): StoredHistory {
  const meta = initialMetadata();
  // A denied read must abort migration. Otherwise the one-time marker could
  // permanently mask a valid legacy history that this tab could not access.
  const raw = window.localStorage.getItem(LEGACY);
  if (raw === null) return { meta, ...emptyRows() };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed.efforts)) throw new Error();
    const efforts = parsed.efforts.filter(valid).map(migratedEffort);
    meta.remembered = true;
    return {
      meta, efforts, aliases: [], warning: efforts.length < parsed.efforts.length
        ? "Recovered the valid older summaries. Some damaged entries could not be read." : undefined,
    };
  } catch {
    meta.migration = "damaged";
    return { meta, ...emptyRows() };
  }
}

export function createHistoryStorage(valid: (effort: unknown) => effort is ComparisonEffort) {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const database = () => {
    dbPromise ??= openDatabase().then((db) => {
      db.onversionchange = () => { db.close(); dbPromise = null; };
      return db;
    }).catch((error) => { dbPromise = null; throw error; });
    return dbPromise;
  };

  async function transact(change: HistoryChange, initialize = false): Promise<StoredHistory> {
    const db = await database();
    const tx = db.transaction(STORES, change.kind === "read" && !initialize ? "readonly" : "readwrite");
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Browser storage transaction was cancelled."));
    });
    // Request failures can reject before the transaction's abort event.
    void complete.catch(() => {});
    const metadata = tx.objectStore("metadata");
    const attempts = tx.objectStore("attempts");
    const aliases = tx.objectStore("aliases");
    try {
      const [storedMeta, savedEfforts, savedAliases] = await Promise.all([
        request<HistoryMetadata | undefined>(metadata.get("state")),
        request<ComparisonEffort[]>(attempts.getAll()),
        request<IdentityDecision[]>(aliases.getAll()),
      ]);
      let meta = storedMeta;
      let rows: HistoryRows = { efforts: savedEfforts.filter(valid), aliases: savedAliases.filter((row) =>
        row && typeof row.key === "string" && typeof row.same === "boolean" &&
        typeof row.olderId === "string" && typeof row.fitId === "string") };
      let warning = savedEfforts.length === rows.efforts.length ? undefined : "Some damaged saved efforts could not be read.";
      if (meta !== undefined && !validMetadata(meta)) {
        if (change.kind !== "forget" && change.kind !== "disable") {
          throw new Error("Saved history settings are damaged. Use Forget imported history to clear them.");
        }
        // Fence off work from tabs that held the previous, unreadable settings.
        meta = { ...initialMetadata(), generation: Date.now() };
      }
      // An explicit erase does not require decoding the legacy copy first.
      if (!meta && (change.kind === "forget" || change.kind === "disable")) meta = initialMetadata();
      if (!meta) {
        if (!initialize) throw new Error("History migration has not completed.");
        const legacy = readLegacy(valid);
        meta = legacy.meta;
        rows = mergeRows(rows, legacy);
        warning = legacy.warning;
        for (const effort of rows.efforts) attempts.put(effort);
        metadata.put(meta, "state");
      }
      if (change.kind === "forget" || change.kind === "disable") {
        meta = { ...meta, remembered: false, generation: meta.generation + 1, migration: "done" };
        if (change.kind === "forget") {
          meta.lastForget = meta.generation;
          meta.lastForgetAt = performance.timeOrigin + performance.now();
        }
        attempts.clear();
        aliases.clear();
        rows = emptyRows();
        metadata.put(meta, "state");
      } else if ((change.kind === "add" || change.kind === "enable") &&
          change.generation === meta.generation && (change.kind === "enable" || meta.remembered)) {
        if (!meta.remembered) {
          meta = { ...meta, remembered: true };
          metadata.put(meta, "state");
        }
        const ids = new Set([...rows.efforts, ...change.rows.efforts].map((row) => row.effortId));
        const merged = mergeRows(rows, {
          efforts: change.rows.efforts,
          aliases: change.rows.aliases.filter((row) => ids.has(row.olderId) && ids.has(row.fitId)),
        });
        const existingEfforts = new Set(rows.efforts.map((row) => row.effortId));
        const existingAliases = new Set(rows.aliases.map((row) => row.key));
        for (const row of merged.efforts) if (!existingEfforts.has(row.effortId)) attempts.put(row);
        for (const row of merged.aliases) if (!existingAliases.has(row.key)) aliases.put(row);
        rows = merged;
      }
      await complete;
      if (meta.migration === "damaged") warning = "Older history could not be read. Use Forget imported history to clear the damaged copy.";
      else if (initialize || change.kind === "forget" || change.kind === "disable") {
        // Never remove the only legacy copy until the new transaction commits.
        try { window.localStorage.removeItem(LEGACY); }
        catch { warning = "The browser could not erase the older history copy. Allow site storage and retry Forget imported history."; }
      }
      return { ...rows, meta, warning };
    } catch (error) {
      try { tx.abort(); } catch { /* Already closed. */ }
      throw error;
    }
  }
  return { transact };
}
