import {
  comparisonEffortFromImportedHistory,
  createComparisonController,
  segmentVersionKey,
  summarizeComparisonDataset,
} from "./comparison";
import type {
  ComparisonController,
  ComparisonDataset,
  ComparisonEffort,
  ComparisonImportState,
  ComparisonSegment,
  ComparisonViewState,
} from "./comparison";
import { importHistoryFitFiles } from "./history";
import type { HistoryImportWarning, HistorySegmentCatalog, ImportedHistoryEffort } from "./history";
import type { AtlasData, Segment } from "./types";

import { emptyRows, mergeRows, resolveIdentities } from "./history-identities";
import type { HistoryRows } from "./history-identities";
import { createHistoryStorage, initialMetadata } from "./history-storage";
import type { HistoryChange, HistoryMetadata, StoredHistory } from "./history-storage";

const BOUNDARY_VERSION = "public-rider-trace-2026-v1";
const CATALOG_VERSION = "mallorca-public-segments-2026-v1";

export interface LocalHistoryExperienceOptions {
  data: AtlasData;
  onSegmentSelect: (segmentId: string | null) => void;
  onSummaryChange?: (summary: { personalEffortCount: number; repeatedCount: number }) => void;
  announce: (message: string) => void;
}

export interface LocalHistoryExperience {
  mount(root: HTMLElement, selectedSegmentId?: string | null): void;
  unmount(): void;
  repeatedCount(): number;
  personalEffortCount(): number;
}

function canonicalStravaId(value: string | number | null): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function versionKeyForSegment(segment: Segment): string | null {
  const stravaId = canonicalStravaId(segment.stravaSegmentId);
  return stravaId ? `strava:${stravaId}@${BOUNDARY_VERSION}` : null;
}

function comparisonSegments(data: AtlasData): ComparisonSegment[] {
  return data.segments.flatMap((segment) => {
    const versionKey = versionKeyForSegment(segment);
    if (!segment.matched || !segment.geometry || !versionKey) return [];
    return [{
      segmentId: segment.segmentId,
      campLabel: segment.campLabel,
      stravaSegmentId: segment.stravaSegmentId,
      versionKey,
      stageLabel: data.rides.find((ride) => ride.rideId === segment.rideId)?.label ?? null,
    }];
  });
}

function publishedReferences(data: AtlasData, segments: ComparisonSegment[]): ComparisonEffort[] {
  const segmentIds = new Set(segments.map((segment) => segment.segmentId));
  return data.segments.flatMap((segment) => {
    if (!segmentIds.has(segment.segmentId)) return [];
    const ride = data.rides.find((candidate) => candidate.rideId === segment.rideId);
    return [{
      effortId: `published-reference:${segment.segmentId}:2026`,
      segmentId: segment.segmentId,
      segmentVersionKey: versionKeyForSegment(segment),
      activityDate: ride?.date ?? "2026",
      elapsedSeconds: segment.stats.elapsedSeconds,
      averagePowerW: segment.stats.averagePowerW,
      averageHeartRateBpm: segment.stats.averageHeartRateBpm,
      scope: "published-reference" as const,
      matchStatus: "exact" as const,
      source: "published-reviewed" as const,
      label: "Published 2026 camp week",
    }];
  });
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCoverage(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object") return false;
  const coverage = value as Record<string, unknown>;
  return ["power", "heartRate", "cadence", "altitude"].every((key) =>
    typeof coverage[key] === "number" && Number.isFinite(coverage[key]) && coverage[key] >= 0 && coverage[key] <= 1,
  );
}

function isStoredPersonalEffort(value: unknown, segments: ComparisonSegment[]): value is ComparisonEffort {
  if (!value || typeof value !== "object") return false;
  const effort = value as Partial<ComparisonEffort>;
  const segment = segments.find((candidate) => candidate.segmentId === effort.segmentId);
  return Boolean(
    segment &&
    typeof effort.effortId === "string" && effort.effortId.length > 0 && effort.effortId.length <= 300 &&
    (effort.label == null || typeof effort.label === "string") &&
    (effort.addedAt === undefined || Number.isFinite(effort.addedAt)) &&
    (!effort.rankSnapshot || (Number.isFinite(effort.rankSnapshot.position) && Number.isFinite(effort.rankSnapshot.fieldSize) &&
      (effort.rankSnapshot.scope == null || typeof effort.rankSnapshot.scope === "string") &&
      (effort.rankSnapshot.capturedDate == null || typeof effort.rankSnapshot.capturedDate === "string"))) &&
    typeof effort.activityDate === "string" && Number.isFinite(Date.parse(effort.activityDate)) &&
    (effort.endedAtIso === undefined || (typeof effort.endedAtIso === "string" && Date.parse(effort.endedAtIso) > Date.parse(effort.activityDate))) &&
    effort.scope === "personal" &&
    (effort.matchStatus === "exact" || effort.matchStatus === "confirmed") &&
    (effort.source === "fit-derived" || effort.source === "published-reviewed") &&
    effort.segmentVersionKey === segmentVersionKey(segment) &&
    isFiniteOrNull(effort.elapsedSeconds) &&
    isFiniteOrNull(effort.averagePowerW) &&
    isFiniteOrNull(effort.averageHeartRateBpm) &&
    isCoverage(effort.coverage) &&
    (effort.quality === undefined || effort.quality === null || ["complete", "partial", "insufficient"].includes(effort.quality))
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((entry) => entry.toString(16).padStart(2, "0")).join("")}`;
}

async function historyCatalog(data: AtlasData): Promise<HistorySegmentCatalog> {
  const templates = await Promise.all(data.segments.map(async (segment) => {
    const stravaSegmentId = canonicalStravaId(segment.stravaSegmentId);
    if (!segment.matched || !segment.geometry || !stravaSegmentId) return null;
    return {
      stravaSegmentId,
      boundaryVersion: BOUNDARY_VERSION,
      campLabel: segment.campLabel,
      templateHash: await sha256(JSON.stringify(segment.geometry)),
      geometry: segment.geometry,
      expectedDistanceM: segment.stats.distanceKm === null ? null : segment.stats.distanceKm * 1000,
      matchReady: true,
      note: "Reviewed rider trace on the exact public atlas segment identity.",
    };
  }));
  return { catalogVersion: CATALOG_VERSION, segments: templates.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
}

function node<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(name);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function readableReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function warningMessage(warning: HistoryImportWarning): string {
  if (warning === "non_cycling_session") return "Skipped a FIT activity explicitly marked as a non-cycling sport.";
  if (warning === "no_cycling_session_metadata") return "Cycling session metadata was missing; segment matching relied on the recorded GPS trace.";
  if (warning === "no_gps_records") return "A selected FIT file had no usable GPS records.";
  if (warning === "no_matching_segments") return "No catalog climb was found in one selected ride.";
  return "Some FIT records had no timestamp and were excluded.";
}

export function createLocalHistoryExperience(options: LocalHistoryExperienceOptions): LocalHistoryExperience {
  const segments = comparisonSegments(options.data);
  const references = publishedReferences(options.data, segments);
  const store = createHistoryStorage((effort): effort is ComparisonEffort => isStoredPersonalEffort(effort, segments));
  let meta = initialMetadata();
  const openedAt = performance.timeOrigin + performance.now();
  let initialized = false;
  let forgetEpoch = 0;
  let readMessage: string | undefined;
  const readUnavailable = "Browser storage is unavailable. You can still compare rides in this tab. Allow site storage to recover saved efforts.";
  let storageBusy = true;
  let storageMessage: string | undefined;
  let durable = emptyRows();
  let session = emptyRows();
  const geometryReview = new Map<string, { effort: ComparisonEffort; match: ImportedHistoryEffort }>();
  let activeImport: AbortController | null = null;
  let reviewDialog: HTMLDialogElement | null = null;
  let importState: ComparisonImportState = { status: "idle" };
  let controller: ComparisonController | null = null;
  let viewState: Partial<ComparisonViewState> = { selectedSegmentId: null, metric: "time", baseline: "previous" };

  const allRows = () => mergeRows(durable, session);
  const dataset = (): ComparisonDataset => {
    const { counted, questions } = resolveIdentities(allRows());
    const provisional = [...geometryReview.values()].map(({ effort }) => effort);
    const provisionalCount = provisional.length + questions.length;
    return {
      segments,
      efforts: [...counted, ...provisional, ...references],
      importState: {
        ...importState, rememberedOnDevice: meta.remembered, storageBusy, storageMessage: storageMessage ?? readMessage, provisionalCount,
        status: importState.status !== "parsing" && provisionalCount ? "review" : importState.status,
        sessionOnly: meta.remembered && (session.efforts.length > 0 || session.aliases.length > 0),
        exactCount: counted.filter((row) => row.matchStatus === "exact").length,
        confirmedCount: counted.filter((row) => row.matchStatus === "confirmed").length,
      },
    };
  };
  const refresh = () => {
    const next = dataset();
    controller?.setDataset(next);
    const summaries = summarizeComparisonDataset(next);
    options.onSummaryChange?.({
      personalEffortCount: summaries.reduce((sum, entry) => sum + entry.personalAttempts.length, 0),
      repeatedCount: summaries.filter((entry) => entry.personalAttempts.length >= 2).length,
    });
  };
  const closeReview = () => {
    reviewDialog?.close();
    reviewDialog?.remove();
    reviewDialog = null;
  };
  const clearSession = () => {
    activeImport?.abort();
    activeImport = null;
    geometryReview.clear();
    session = emptyRows();
    durable = emptyRows();
    importState = { status: "idle" };
    closeReview();
  };
  type EraseWatermark = Pick<HistoryMetadata, "generation" | "lastForget" | "lastForgetAt">;
  const signalKey = "mallorca-history-change";
  const parseNotice = (value: string | null): EraseWatermark | null => {
    if (!value) return null;
    try {
      const mark = JSON.parse(value);
      return mark && Number.isSafeInteger(mark.generation) && mark.generation >= 0 &&
        Number.isSafeInteger(mark.lastForget) && mark.lastForget >= 0 && mark.lastForget <= mark.generation &&
        (mark.lastForgetAt === undefined || Number.isFinite(mark.lastForgetAt)) ? mark : null;
    } catch { return null; }
  };
  // This contains only erase metadata. It supplies a baseline even if the
  // database is temporarily inaccessible when this tab opens.
  try {
    const baseline = parseNotice(window.localStorage.getItem(signalKey));
    if (baseline) meta = { ...meta, generation: baseline.generation, lastForget: baseline.lastForget, lastForgetAt: baseline.lastForgetAt };
  } catch { /* A subsequent read can date the previous Forget. */ }
  const advance = (mark: EraseWatermark) => {
    if (mark.generation <= meta.generation) return;
    if (mark.lastForget > meta.lastForget &&
        (initialized || (mark.lastForgetAt !== undefined && mark.lastForgetAt >= openedAt))) {
      forgetEpoch++;
      clearSession();
    } else {
      session = mergeRows(durable, session);
      durable = emptyRows();
    }
    meta = { ...meta, generation: mark.generation, lastForget: mark.lastForget,
      lastForgetAt: mark.lastForgetAt, remembered: false };
  };
  const absorb = (state: StoredHistory) => {
    // A committed erase notification can arrive while an older read is in flight.
    if (state.meta.generation < meta.generation) return;
    advance(state.meta);
    meta = state.meta;
    durable = { efforts: state.efforts, aliases: state.aliases };
    const saved = new Set(durable.efforts.map((row) => row.effortId));
    const decisions = new Set(durable.aliases.map((row) => row.key));
    session = {
      efforts: session.efforts.filter((row) => !saved.has(row.effortId)),
      aliases: session.aliases.filter((row) => !decisions.has(row.key)),
    };
    for (const key of saved) geometryReview.delete(key);
    if (state.warning) storageMessage = state.warning;
  };

  // Serialize local state changes. The database gives the same consistency
  // between tabs, including if an erase notification has not arrived yet.
  let queue: Promise<void> = Promise.resolve();
  function run(action: () => Promise<void>): Promise<void> {
    const work = queue.then(action);
    queue = work.catch(() => {});
    return work;
  }
  let channel: BroadcastChannel | undefined;
  const notify = () => {
    const notice = JSON.stringify({ generation: meta.generation, lastForget: meta.lastForget,
      lastForgetAt: meta.lastForgetAt, nonce: crypto.randomUUID() });
    try { channel?.postMessage(notice); } catch { /* Fall through to the storage event. */ }
    try { window.localStorage.setItem(signalKey, notice); } catch { /* Visibility also refreshes. */ }
  };
  const transact = async (change: HistoryChange) => {
    const snapshot = await store.transact(change, !initialized);
    absorb(snapshot);
    initialized = true;
    readMessage = undefined;
  };
  const sync = () => run(async () => {
    try { await transact({ kind: "read" }); }
    catch (error) {
      readMessage = error instanceof Error && error.message.startsWith("Saved history settings")
        ? error.message : readUnavailable;
    }
    storageBusy = false;
    refresh();
  });
  const receive = (value: string | null) => {
    const notice = parseNotice(value);
    if (notice && notice.generation > meta.generation) {
      advance(notice);
      refresh();
    }
    void sync();
  };
  try {
    channel = new BroadcastChannel(signalKey);
    channel.onmessage = (event) => receive(event.data);
  } catch { /* Storage events provide another notification channel. */ }
  window.addEventListener("storage", (event) => {
    if (event.key === signalKey || event.key === null) receive(event.newValue);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) void sync(); });
  void sync();

  type Intent = { generation: number; remember: boolean; forgetEpoch: number };
  const intent = (): Intent => ({ generation: meta.generation, remember: meta.remembered, forgetEpoch });

  // The caller captures its generation before reading the file or opening the
  // review. An intervening opt-out allows session results; Forget rejects them.
  const accept = async (rows: HistoryRows, began: Intent, signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted || forgetEpoch !== began.forgetEpoch) return false;
    try {
      await transact(began.remember ? { kind: "add", generation: began.generation, rows } : { kind: "read" });
    } catch {
      if (began.remember) {
        storageMessage = "The browser could not save this change. It is available only in this tab. Allow site storage and retry Remember on this device.";
      } else readMessage = readUnavailable;
    }
    if (signal?.aborted || forgetEpoch !== began.forgetEpoch) {
      refresh();
      return false;
    }
    const saved = new Set(durable.efforts.map((row) => row.effortId));
    const decisions = new Set(durable.aliases.map((row) => row.key));
    session = mergeRows(session, {
      efforts: rows.efforts.filter((row) => !saved.has(row.effortId)),
      aliases: rows.aliases.filter((row) => !decisions.has(row.key)),
    });
    if (began.remember && meta.remembered && meta.generation === began.generation && (rows.efforts.length || rows.aliases.length)) notify();
    return true;
  };

  const openReviewDialog = () => {
    closeReview();
    const { questions } = resolveIdentities(allRows());
    if (!questions.length && !geometryReview.size) return;
    const began = intent();
    const dialog = node("dialog", "comparison-review-dialog");
    reviewDialog = dialog;
    const heading = node("h2", "", "Review your efforts");
    const list = node("ol", "comparison-review-list");
    const feedback = node("p", "comparison-dialog-copy");
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    let deciding = false;
    const setDeciding = (value: boolean) => {
      deciding = value;
      dialog.querySelectorAll("button").forEach((button) => { button.disabled = value; });
    };
    const reviewButton = (label: string, action: () => Promise<void>) => {
      const button = node("button", "comparison-secondary-button", label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (deciding) return;
        setDeciding(true);
        feedback.textContent = "Applying your decision…";
        feedback.hidden = false;
        void run(async () => {
          try {
            await action();
          } catch {
            feedback.textContent = "Could not apply this decision. Please try again.";
            setDeciding(false);
            return;
          }
          if (reviewDialog === dialog) closeReview();
          refresh();
        });
      });
      return button;
    };
    for (const { key, older, fit } of questions) {
      const item = node("li");
      const label = segments.find((s) => s.segmentId === fit.segmentId)?.campLabel ?? "Climb";
      const source = older.source === "published-reviewed" ? "Published camp effort" : "Previously saved effort";
      const stamp = new Intl.DateTimeFormat("en", { timeZone: "Europe/Madrid", dateStyle: "medium", timeStyle: "medium" }).format(new Date(fit.activityDate));
      const duration = (row: ComparisonEffort) => row.elapsedSeconds === null ? "time unavailable" : `${row.elapsedSeconds} seconds`;
      item.append(node("strong", "", label), node("span", "", `${source} · ${older.activityDate.slice(0, 10)} · ${duration(older)}`),
        node("span", "", `FIT recording · ${stamp} (Mallorca) · ${duration(fit)}`),
        node("small", "", "Did these record the same ascent?"));
      const decide = async (same: boolean) => {
        const rows = { efforts: [], aliases: [{ key, olderId: older.effortId, fitId: fit.effortId, same }] };
        await accept(rows, began);
      };
      const actions = node("div", "comparison-review-actions");
      actions.append(reviewButton("Same ascent", () => decide(true)), reviewButton("Separate ascents", () => decide(false)));
      item.append(actions);
      list.append(item);
    }
    for (const [key, { effort, match }] of geometryReview) {
      const item = node("li");
      item.append(node("strong", "", effort.label ?? "Likely climb"), node("span", "", effort.activityDate),
        node("small", "", `${Math.round(match.matchScore * 100)}% geometry score · ${match.matchReasons.map(readableReason).join(", ") || "boundary needs confirmation"}`));
      const actions = node("div", "comparison-review-actions");
      actions.append(reviewButton("Confirm match", async () => {
        await accept({ efforts: [{ ...effort, matchStatus: "confirmed" }], aliases: [] }, began);
        geometryReview.delete(key);
      }), reviewButton("Exclude", async () => { geometryReview.delete(key); }));
      item.append(actions);
      list.append(item);
    }
    const done = node("button", "comparison-link-button", "Review later");
    done.type = "button";
    done.addEventListener("click", closeReview);
    dialog.append(heading, list, feedback, done);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!deciding) closeReview();
    });
    document.body.append(dialog);
    dialog.showModal();
  };

  const onFilesSelected = async (files: File[]) => {
    await queue;
    if (activeImport) return;
    const fitFiles = files.filter((file) => file.name.toLowerCase().endsWith(".fit"));
    if (!fitFiles.length) {
      importState = { status: "error", errorMessages: ["Choose one or more Garmin .fit activity files."] };
      refresh();
      return;
    }
    const began = intent();
    const pending = new AbortController();
    activeImport = pending;
    importState = { status: "parsing", filesProcessed: 0 };
    refresh();
    try {
      const catalog = await historyCatalog(options.data);
      const result = await importHistoryFitFiles(fitFiles.map((blob) => ({ blob })), catalog, {
        signal: pending.signal,
        onProgress: ({ fileIndex, phase }) => {
          if (pending.signal.aborted) return;
          importState = { ...importState, filesProcessed: fileIndex + (phase === "finalizing" ? 1 : 0) };
          refresh();
        },
      });
      await run(async () => {
        if (pending.signal.aborted) return;
        const imported = result.results.flatMap((entry) => entry.efforts).flatMap((match) => {
          const segment = segments.find((s) => segmentVersionKey(s) === match.segmentKey);
          if (!segment) return [];
          const effort = comparisonEffortFromImportedHistory(match, segment.segmentId);
          effort.label = match.campLabel;
          effort.addedAt = Date.now();
          return [{ effort, match }];
        });
        const confirmed = imported.filter(({ effort }) => effort.matchStatus === "confirmed").map(({ effort }) => effort);
        if (!await accept({ efforts: confirmed, aliases: [] }, began, pending.signal)) return;
        const known = new Set(allRows().efforts.map((row) => row.effortId));
        for (const row of imported) {
          if (row.effort.matchStatus === "provisional" && !known.has(row.effort.effortId)) geometryReview.set(row.effort.effortId, row);
          else geometryReview.delete(row.effort.effortId);
        }
        const warnings = result.results.flatMap((entry) => entry.warnings.filter((w) => w !== "no_matching_segments").map(warningMessage));
        importState = {
          status: result.failures.length && !imported.length ? "error" : "ready",
          filesProcessed: fitFiles.length, unmatchedCount: result.results.filter((entry) => !entry.efforts.length).length,
          lastImportedAt: new Date().toISOString(),
          errorMessages: [...result.failures.map((failure) => failure.message), ...new Set(warnings)],
        };
        refresh();
        const selected = controller?.getState().selectedSegmentId ?? viewState.selectedSegmentId;
        if (imported.length && !allRows().efforts.some((row) => row.segmentId === selected)) controller?.selectSegment(imported[0].effort.segmentId, true);
        options.announce(`${imported.length} segment ${imported.length === 1 ? "effort" : "efforts"} found in the selected files.`);
      });
    } catch (error) {
      if (!pending.signal.aborted) {
        importState = { status: "error", errorMessages: [error instanceof Error ? error.message : "The local FIT import failed."] };
        refresh();
      }
    } finally {
      if (activeImport === pending) activeImport = null;
    }
  };

  const changePersistence = (kind: "enable" | "disable" | "forget") => {
    const began = intent();
    if (kind === "forget") {
      activeImport?.abort();
      activeImport = null;
      geometryReview.clear();
      session = emptyRows();
      importState = { status: "idle" };
      closeReview();
    }
    storageBusy = true;
    refresh();
    return run(async () => {
      storageMessage = undefined;
      try {
        await transact(kind === "enable" ? { kind, generation: began.generation, rows: allRows() } : { kind });
        notify();
        if (kind === "enable" && meta.generation !== began.generation) {
          storageMessage = "History was cleared in another tab. Review the current list before choosing Remember on this device again.";
        }
        options.announce(storageMessage ?? (kind === "forget" ? "Imported history forgotten." :
          kind === "enable" ? "Derived summaries saved on this device." : "Saved history erased. This tab keeps its session copy."));
      } catch {
        storageMessage = kind === "enable"
          ? "The browser could not save your history. Allow site storage and retry Remember on this device."
          : "The browser could not erase saved history. Allow site storage and retry Forget imported history.";
        options.announce(storageMessage);
      }
      storageBusy = false;
      refresh();
    });
  };

  const createController = (root: HTMLElement) => createComparisonController({
    root, dataset: dataset(), initialState: viewState,
    onStateChange: (state) => { viewState = { ...state }; },
    onSegmentSelect: options.onSegmentSelect, onFilesSelected, onReviewMatches: openReviewDialog,
    onForgetHistory: () => changePersistence("forget"),
    onPersistenceChange: (remember) => changePersistence(remember ? "enable" : "disable"),
    onAdoptPublishedReference: (effortId) => {
      const reference = references.find((row) => row.effortId === effortId);
      if (!reference || !window.confirm("Add this effort to your personal history? Confirm only if you rode the published 2026 camp week.")) return;
      const began = intent();
      const adopted: ComparisonEffort = {
        ...reference, effortId: `personal-owner:${reference.segmentId}:2026`, scope: "personal",
        label: "My published 2026 effort", addedAt: Date.now(),
      };
      return run(async () => {
        if (await accept({ efforts: [adopted], aliases: [] }, began)) {
          importState = { ...importState, status: "ready" };
          refresh();
          options.announce("Published effort included in your history. Review any possible duplicate ascent.");
        }
      });
    },
  });

  return {
    mount: (root, selectedSegmentId) => {
      if (selectedSegmentId !== undefined) viewState.selectedSegmentId = selectedSegmentId;
      controller = createController(root);
    },
    unmount: () => {
      if (controller) viewState = { ...controller.getState() };
      controller?.destroy();
      controller = null;
    },
    repeatedCount: () => summarizeComparisonDataset(dataset()).filter((entry) => entry.personalAttempts.length >= 2).length,
    personalEffortCount: () => resolveIdentities(allRows()).counted.length,
  };
}
