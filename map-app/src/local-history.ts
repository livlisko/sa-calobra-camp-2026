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

const STORAGE_KEY = "mallorca-camp-segment-history-v1";
const STORAGE_VERSION = 1;
const BOUNDARY_VERSION = "public-rider-trace-2026-v1";
const CATALOG_VERSION = "mallorca-public-segments-2026-v1";

interface StoredHistory {
  version: 1;
  efforts: ComparisonEffort[];
}

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
    typeof effort.effortId === "string" && effort.effortId.length <= 300 &&
    typeof effort.activityDate === "string" &&
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

function loadStoredEfforts(segments: ComparisonSegment[]): ComparisonEffort[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<StoredHistory>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.efforts)) return [];
    return parsed.efforts.filter((effort) => isStoredPersonalEffort(effort, segments));
  } catch {
    return [];
  }
}

function persistEfforts(efforts: ComparisonEffort[]): void {
  const payload: StoredHistory = { version: STORAGE_VERSION, efforts };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function effortFingerprint(effort: ComparisonEffort): string {
  return [effort.segmentVersionKey, effort.activityDate, effort.elapsedSeconds ?? "", effort.averagePowerW ?? ""].join("|");
}

function recordedAttemptKey(effort: ComparisonEffort): string {
  return [effort.segmentVersionKey, effort.activityDate.slice(0, 10), effort.elapsedSeconds ?? ""].join("|");
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
  let personalEfforts = loadStoredEfforts(segments);
  let rememberedOnDevice = window.localStorage.getItem(STORAGE_KEY) !== null;
  let importState: ComparisonImportState = { status: "idle", rememberedOnDevice };
  let controller: ComparisonController | null = null;
  let mountRoot: HTMLElement | null = null;
  let viewState: Partial<ComparisonViewState> = {
    selectedSegmentId: null,
    metric: "time",
    baseline: "previous",
  };
  const reviewMetadata = new Map<string, ImportedHistoryEffort>();

  const dataset = (): ComparisonDataset => ({
    segments,
    efforts: [...personalEfforts, ...references],
    importState: { ...importState, rememberedOnDevice },
  });

  const refresh = () => {
    if (rememberedOnDevice) {
      try { persistEfforts(personalEfforts.filter((effort) => effort.matchStatus !== "provisional")); } catch { /* Private mode may disable storage. */ }
    }
    const nextDataset = dataset();
    controller?.setDataset(nextDataset);
    const summaries = summarizeComparisonDataset(nextDataset);
    options.onSummaryChange?.({
      personalEffortCount: personalEfforts.filter((effort) => effort.matchStatus === "confirmed" || effort.matchStatus === "exact").length,
      repeatedCount: summaries.filter((summary) => summary.personalAttempts.length >= 2).length,
    });
  };

  const closeDialog = (dialog: HTMLDialogElement) => {
    dialog.close();
    dialog.remove();
  };

  const openReviewDialog = () => {
    const provisional = personalEfforts.filter((effort) => effort.matchStatus === "provisional");
    if (!provisional.length) {
      options.announce("There are no provisional segment matches to review.");
      return;
    }
    const dialog = node("dialog", "comparison-review-dialog");
    const header = node("header");
    header.append(node("p", "comparison-kicker", "Local match review"), node("h2", "", "Check likely segment matches"));
    const intro = node("p", "comparison-dialog-copy", "These FIT-derived efforts are excluded from comparisons until you confirm that the climb and date look right. No route or file is uploaded.");
    const list = node("ol", "comparison-review-list");
    for (const effort of provisional) {
      const meta = reviewMetadata.get(effort.effortId);
      const item = node("li");
      item.append(
        node("strong", "", effort.label ?? segments.find((segment) => segment.segmentId === effort.segmentId)?.campLabel ?? "Likely climb"),
        node("span", "", new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(effort.activityDate))),
        node("small", "", meta ? `${Math.round(meta.matchScore * 100)}% geometry score · ${meta.matchReasons.map(readableReason).join(", ") || "boundary needs confirmation"}` : "Boundary needs confirmation"),
      );
      const actions = node("div", "comparison-review-actions");
      const confirm = node("button", "comparison-primary-button", "Confirm match");
      confirm.type = "button";
      confirm.addEventListener("click", () => {
        personalEfforts = personalEfforts.map((candidate) => candidate.effortId === effort.effortId ? { ...candidate, matchStatus: "confirmed" } : candidate);
        reviewMetadata.delete(effort.effortId);
        item.remove();
        importState = { ...importState, status: personalEfforts.some((candidate) => candidate.matchStatus === "provisional") ? "review" : "ready", provisionalCount: Math.max(0, (importState.provisionalCount ?? 1) - 1) };
        refresh();
        options.announce(`${effort.label ?? "Segment"} match confirmed.`);
        if (!list.children.length) closeDialog(dialog);
      });
      const exclude = node("button", "comparison-link-button", "Exclude");
      exclude.type = "button";
      exclude.addEventListener("click", () => {
        personalEfforts = personalEfforts.filter((candidate) => candidate.effortId !== effort.effortId);
        reviewMetadata.delete(effort.effortId);
        item.remove();
        importState = { ...importState, status: personalEfforts.some((candidate) => candidate.matchStatus === "provisional") ? "review" : "ready", provisionalCount: Math.max(0, (importState.provisionalCount ?? 1) - 1) };
        refresh();
        options.announce("Likely match excluded.");
        if (!list.children.length) closeDialog(dialog);
      });
      actions.append(confirm, exclude);
      item.append(actions);
      list.append(item);
    }
    const done = node("button", "comparison-secondary-button", "Review later");
    done.type = "button";
    done.addEventListener("click", () => closeDialog(dialog));
    dialog.append(header, intro, list, done);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(dialog); });
    document.body.append(dialog);
    dialog.showModal();
  };

  const onFilesSelected = async (files: File[]) => {
    const fitFiles = files.filter((file) => file.name.toLowerCase().endsWith(".fit"));
    if (!fitFiles.length) {
      importState = { status: "error", rememberedOnDevice, errorMessages: ["Choose one or more Garmin .fit activity files."] };
      refresh();
      return;
    }
    importState = { status: "parsing", filesProcessed: 0, rememberedOnDevice };
    refresh();
    try {
      const catalog = await historyCatalog(options.data);
      const result = await importHistoryFitFiles(fitFiles.map((file) => ({ blob: file })), catalog, {
        onProgress: ({ fileIndex, phase }) => {
          importState = { ...importState, status: "parsing", filesProcessed: fileIndex + (phase === "finalizing" ? 1 : 0) };
          refresh();
        },
      });
      const segmentIdByKey = new Map(segments.map((segment) => [segmentVersionKey(segment), segment.segmentId]));
      const imported = result.results.flatMap((entry) => entry.efforts).flatMap((effort) => {
        const segmentId = segmentIdByKey.get(effort.segmentKey);
        if (!segmentId) return [];
        const comparisonEffort = comparisonEffortFromImportedHistory(effort, segmentId);
        comparisonEffort.label = effort.campLabel;
        if (comparisonEffort.matchStatus === "provisional") reviewMetadata.set(comparisonEffort.effortId, effort);
        return [comparisonEffort];
      });
      const existing = new Set(personalEfforts.map(effortFingerprint));
      for (const effort of imported) {
        const fingerprint = effortFingerprint(effort);
        if (!existing.has(fingerprint)) {
          personalEfforts.push(effort);
          existing.add(fingerprint);
        }
      }
      const provisionalCount = personalEfforts.filter((effort) => effort.matchStatus === "provisional").length;
      const exactCount = personalEfforts.filter((effort) => effort.matchStatus === "exact").length;
      const confirmedCount = personalEfforts.filter((effort) => effort.matchStatus === "confirmed").length;
      const unmatchedFiles = result.results.filter((entry) => entry.efforts.length === 0).length;
      // `unmatchedCount` has its own plain-language notice. Keep this list for
      // actionable parser/context warnings so visitors do not see the same
      // outcome twice (or a misleading no-match warning after a non-ride).
      const warningMessages = [...new Set(result.results.flatMap((entry) =>
        entry.warnings
          .filter((warning) => warning !== "no_matching_segments")
          .map(warningMessage),
      ))];
      importState = {
        status: provisionalCount ? "review" : result.failures.length && !imported.length ? "error" : "ready",
        filesProcessed: fitFiles.length,
        exactCount,
        confirmedCount,
        provisionalCount,
        unmatchedCount: unmatchedFiles,
        rememberedOnDevice,
        errorMessages: [...result.failures.map((failure) => failure.message), ...warningMessages],
        lastImportedAt: new Date().toISOString(),
      };
      refresh();
      const selectedSegmentId = controller?.getState().selectedSegmentId ?? viewState.selectedSegmentId;
      const selectedHasPersonalAttempt = personalEfforts.some((effort) =>
        effort.segmentId === selectedSegmentId && (effort.matchStatus === "confirmed" || effort.matchStatus === "exact"),
      );
      if (imported.length && !selectedHasPersonalAttempt) controller?.selectSegment(imported[0].segmentId, true);
      options.announce(`${imported.length} segment ${imported.length === 1 ? "effort" : "efforts"} found in ${fitFiles.length} local FIT ${fitFiles.length === 1 ? "file" : "files"}.`);
    } catch (error) {
      importState = {
        status: "error",
        rememberedOnDevice,
        errorMessages: [error instanceof Error ? error.message : "The local FIT import failed."],
      };
      refresh();
    }
  };

  const createController = (root: HTMLElement) => createComparisonController({
    root,
    dataset: dataset(),
    initialState: viewState,
    onStateChange: (state) => { viewState = { ...state }; },
    onSegmentSelect: (segmentId) => options.onSegmentSelect(segmentId),
    onFilesSelected,
    onReviewMatches: openReviewDialog,
    onForgetHistory: () => {
      personalEfforts = [];
      reviewMetadata.clear();
      rememberedOnDevice = false;
      window.localStorage.removeItem(STORAGE_KEY);
      importState = { status: "idle", rememberedOnDevice: false };
      refresh();
      options.announce("Imported comparison history forgotten. The published atlas was not changed.");
    },
    onPersistenceChange: (remembered) => {
      rememberedOnDevice = remembered;
      try {
        if (remembered) persistEfforts(personalEfforts.filter((effort) => effort.matchStatus !== "provisional"));
        else window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        rememberedOnDevice = false;
        importState = { ...importState, rememberedOnDevice: false };
        refresh();
        options.announce("This browser could not save local history. It will remain available only for this tab.");
        return;
      }
      importState = { ...importState, rememberedOnDevice };
      refresh();
      options.announce(remembered ? "Derived effort summaries will be remembered on this device." : "History will now last only for this tab.");
    },
    onAdoptPublishedReference: (effortId) => {
      const reference = references.find((effort) => effort.effortId === effortId);
      if (!reference) return;
      const confirmed = window.confirm("Only add this published 2026 effort to personal history if you are the rider whose camp week is shown in this atlas. Continue?");
      if (!confirmed) return;
      const adopted: ComparisonEffort = {
        ...reference,
        effortId: `personal-owner:${reference.segmentId}:2026`,
        scope: "personal",
        matchStatus: "exact",
        label: "My published 2026 effort",
      };
      if (personalEfforts.some((effort) => effort.effortId === adopted.effortId || recordedAttemptKey(effort) === recordedAttemptKey(adopted))) {
        options.announce("That 2026 effort is already in personal history.");
        return;
      }
      personalEfforts.push(adopted);
      refresh();
      options.announce(rememberedOnDevice
        ? "Published 2026 effort added to personal history on this device."
        : "Published 2026 effort added to personal history for this tab.");
    },
  });

  return {
    mount: (root, selectedSegmentId) => {
      mountRoot = root;
      if (selectedSegmentId !== undefined) viewState.selectedSegmentId = selectedSegmentId;
      controller = createController(root);
    },
    unmount: () => {
      if (controller) viewState = { ...controller.getState() };
      controller?.destroy();
      controller = null;
      mountRoot = null;
    },
    repeatedCount: () => summarizeComparisonDataset(dataset()).filter((summary) => summary.personalAttempts.length >= 2).length,
    personalEffortCount: () => personalEfforts.filter((effort) => effort.matchStatus === "confirmed" || effort.matchStatus === "exact").length,
  };
}
