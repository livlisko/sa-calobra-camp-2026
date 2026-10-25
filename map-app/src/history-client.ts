import { validateHistoryCatalog } from "./history-match";
import type {
  HistoryImportResult,
  HistorySegmentCatalog,
  HistoryWorkerErrorCode,
  HistoryWorkerMessage,
  HistoryWorkerParseRequest,
} from "./history-types";

const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface HistoryImportInput {
  blob: Blob;
  /** Session-local opaque id. Filenames should remain in caller-owned UI state. */
  sourceId?: string;
}
export interface HistoryImportProgress {
  sourceId: string;
  fileIndex: number;
  fileCount: number;
  phase: "reading" | "decoding" | "matching" | "finalizing";
}

export interface HistoryImportFailure {
  sourceId: string;
  code: HistoryWorkerErrorCode;
  message: string;
}

export interface HistoryImportBatchResult {
  results: HistoryImportResult[];
  failures: HistoryImportFailure[];
}

export interface HistoryImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: HistoryImportProgress) => void;
  /** Test seam; production callers should use the same-origin emitted worker. */
  workerFactory?: () => Worker;
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  return `${prefix}-${[...values].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function abortError(): DOMException {
  return new DOMException("History import cancelled.", "AbortError");
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./history-worker.ts", import.meta.url), {
    type: "module",
    name: "mallorca-history-import",
  });
}

function parseInWorker(
  worker: Worker,
  request: HistoryWorkerParseRequest,
  transfer: ArrayBuffer,
  fileIndex: number,
  fileCount: number,
  options: HistoryImportOptions,
): Promise<HistoryImportResult | HistoryImportFailure> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onWorkerError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onWorkerError = () => {
      cleanup();
      reject(new Error("The local FIT import worker stopped unexpectedly."));
    };
    const onMessage = (event: MessageEvent<HistoryWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== request.requestId) return;
      if (message.type === "progress") {
        options.onProgress?.({ sourceId: request.sourceId, fileIndex, fileCount, phase: message.phase });
        return;
      }
      cleanup();
      if (message.type === "result") resolve(message.result);
      else resolve({ sourceId: message.sourceId, code: message.code, message: message.message });
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onWorkerError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage(request, [transfer]);
  });
}

/**
 * Import FIT files sequentially in a lazily-created worker. This function has
 * no fetch, logging, storage, or URL side effects. It retains only the reduced
 * result returned by the worker and always terminates the worker after a batch.
 */
export async function importHistoryFitFiles(
  inputs: readonly HistoryImportInput[],
  catalog: HistorySegmentCatalog,
  options: HistoryImportOptions = {},
): Promise<HistoryImportBatchResult> {
  validateHistoryCatalog(catalog);
  if (inputs.length > MAX_FILES_PER_BATCH) {
    throw new Error(`Import at most ${MAX_FILES_PER_BATCH} FIT files at a time.`);
  }
  if (!inputs.length) return { results: [], failures: [] };
  if (options.signal?.aborted) throw abortError();

  const sources = inputs.map((input) => ({ ...input, sourceId: input.sourceId?.trim() || randomId("fit") }));
  if (new Set(sources.map((input) => input.sourceId)).size !== sources.length) {
    throw new Error("Every imported FIT file must have a unique session-local sourceId.");
  }

  const worker = (options.workerFactory ?? defaultWorkerFactory)();
  const results: HistoryImportResult[] = [];
  const failures: HistoryImportFailure[] = [];
  const terminateOnAbort = () => worker.terminate();
  options.signal?.addEventListener("abort", terminateOnAbort, { once: true });
  try {
    for (const [index, input] of sources.entries()) {
      if (options.signal?.aborted) throw abortError();
      if (input.blob.size > MAX_FILE_BYTES) {
        failures.push({
          sourceId: input.sourceId,
          code: "file_too_large",
          message: "This FIT file is too large to process safely in the browser.",
        });
        continue;
      }
      options.onProgress?.({
        sourceId: input.sourceId,
        fileIndex: index,
        fileCount: sources.length,
        phase: "reading",
      });
      const bytes = await input.blob.arrayBuffer();
      if (options.signal?.aborted) throw abortError();
      const response = await parseInWorker(
        worker,
        {
          type: "parse",
          requestId: randomId("request"),
          sourceId: input.sourceId,
          bytes,
          catalog,
        },
        bytes,
        index,
        sources.length,
        options,
      );
      if ("parser" in response) results.push(response);
      else failures.push(response);
    }
    return { results, failures };
  } finally {
    options.signal?.removeEventListener("abort", terminateOnAbort);
    worker.terminate();
  }
}
