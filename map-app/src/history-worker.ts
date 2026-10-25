import { MAX_HISTORY_FIT_BYTES, parseFitHistory } from "./history-fit";
import type {
  HistoryWorkerErrorCode,
  HistoryWorkerMessage,
  HistoryWorkerParseRequest,
  HistoryWorkerRequest,
} from "./history-types";

interface HistoryWorkerScope {
  onmessage: ((event: MessageEvent<HistoryWorkerRequest>) => void) | null;
  postMessage(message: HistoryWorkerMessage): void;
}

const scope = globalThis as unknown as HistoryWorkerScope;
const cancelledRequests = new Set<string>();

function failureCode(error: unknown, request: HistoryWorkerParseRequest): HistoryWorkerErrorCode {
  if (cancelledRequests.has(request.requestId)) return "cancelled";
  if (request.bytes.byteLength > MAX_HISTORY_FIT_BYTES) return "file_too_large";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("catalog") || message.includes("segment definition") || message.includes("template")) {
    return "invalid_catalog";
  }
  if (message.includes("unsupported")) return "unsupported_fit";
  return "invalid_fit";
}

function failureMessage(code: HistoryWorkerErrorCode): string {
  switch (code) {
    case "cancelled": return "Import cancelled.";
    case "file_too_large": return "This FIT file is too large to process safely in the browser.";
    case "invalid_catalog": return "The segment comparison catalog is invalid or incomplete.";
    case "unsupported_fit": return "This FIT activity uses a structure the local importer does not support.";
    case "invalid_fit": return "The file is not a complete, CRC-valid FIT activity.";
  }
}

async function handleParse(request: HistoryWorkerParseRequest): Promise<void> {
  try {
    const result = await parseFitHistory(request.bytes, request.sourceId, request.catalog, (phase) => {
      if (cancelledRequests.has(request.requestId)) return;
      scope.postMessage({ type: "progress", requestId: request.requestId, sourceId: request.sourceId, phase });
    });
    if (cancelledRequests.has(request.requestId)) {
      scope.postMessage({
        type: "failure",
        requestId: request.requestId,
        sourceId: request.sourceId,
        code: "cancelled",
        message: failureMessage("cancelled"),
      });
      return;
    }
    scope.postMessage({ type: "result", requestId: request.requestId, sourceId: request.sourceId, result });
  } catch (error) {
    const code = failureCode(error, request);
    scope.postMessage({
      type: "failure",
      requestId: request.requestId,
      sourceId: request.sourceId,
      code,
      message: failureMessage(code),
    });
  } finally {
    cancelledRequests.delete(request.requestId);
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelledRequests.add(request.requestId);
    return;
  }
  void handleParse(request);
};
