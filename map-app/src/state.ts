import type { AtlasData, AtlasState, CameraState, GuideTab, TerrainMode } from "./types";
import { MALLORCA_SUMMITS } from "./mountains";

const GUIDE_TABS: GuideTab[] = ["island", "rides", "segments", "point", "compare"];

export function defaultState(): AtlasState {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    selectedRideId: null,
    selectedSegmentId: null,
    selectedPointId: null,
    selectedSummitId: null,
    previewRideId: null,
    terrain: reducedMotion ? "2d" : "3d",
    tab: "island",
    camera: null,
  };
}

function parseCamera(value: string | null): CameraState | null {
  if (!value) return null;
  const fields = value.split(",");
  if (fields.length !== 5 || fields.some(entry => !entry.trim())) return null;
  const values = fields.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [longitude, latitude, zoom, bearing, pitch] = values;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || zoom < 0 || zoom > 22) return null;
  return { longitude, latitude, zoom, bearing, pitch: Math.min(85, Math.max(0, pitch)) };
}

function formatCamera(camera: CameraState): string {
  return [camera.longitude.toFixed(5), camera.latitude.toFixed(5), camera.zoom.toFixed(2), camera.bearing.toFixed(1), camera.pitch.toFixed(1)].join(",");
}

type Selection = Pick<AtlasState, "selectedRideId" | "selectedSegmentId" | "selectedPointId" | "selectedSummitId">;

export function normalizeSelection(data: AtlasData, requested: Partial<Selection>): Selection {
  const point = requested.selectedPointId
    ? data.rides.flatMap(ride => ride.telemetrySamples).find(sample => sample.sampleId === requested.selectedPointId)
    : undefined;
  const segmentId = point ? point.segmentId : requested.selectedSegmentId;
  const segment = data.segments.find(entry =>
    entry.matched && entry.segmentId === segmentId && (!point || entry.rideId === point.rideId)
  );
  const ride = data.rides.find(entry => entry.rideId === (point?.rideId ?? segment?.rideId ?? requested.selectedRideId));
  const summit = ride ? undefined : MALLORCA_SUMMITS.find(entry => entry.id === requested.selectedSummitId);
  return {
    selectedRideId: ride?.rideId ?? null,
    selectedSegmentId: segment?.segmentId ?? null,
    selectedPointId: point?.sampleId ?? null,
    selectedSummitId: summit?.id ?? null,
  };
}

export function stateFromHash(data: AtlasData, fallback: AtlasState): AtlasState {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const selection = normalizeSelection(data, {
    selectedRideId: params.get("ride"),
    selectedSegmentId: params.get("segment"),
    selectedPointId: params.get("point"),
    selectedSummitId: params.get("summit"),
  });
  const terrain = params.get("terrain");
  const tab = params.get("tab") as GuideTab | null;
  const impliedTab = selection.selectedPointId ? "point" : selection.selectedSegmentId ? "segments" : selection.selectedRideId ? "rides" : "island";
  return {
    ...selection,
    previewRideId: null,
    terrain: terrain === "2d" || terrain === "3d" ? terrain : fallback.terrain,
    tab: tab && GUIDE_TABS.includes(tab) ? tab : impliedTab,
    camera: parseCamera(params.get("map")),
  };
}

export function writeStateToHash(state: AtlasState, mode: "push" | "replace" = "push"): void {
  const params = new URLSearchParams();
  if (state.selectedRideId) params.set("ride", state.selectedRideId);
  if (state.selectedSegmentId) params.set("segment", state.selectedSegmentId);
  if (state.selectedPointId) params.set("point", state.selectedPointId);
  if (state.selectedSummitId) params.set("summit", state.selectedSummitId);
  params.set("terrain", state.terrain);
  if (state.tab !== "island" || state.selectedRideId) params.set("tab", state.tab);
  if (state.camera) params.set("map", formatCamera(state.camera));
  const url = `${window.location.pathname}${window.location.search}${params.size ? `#${params}` : ""}`;
  const historyState = { mallorcaAtlas: true };
  if (mode === "replace") window.history.replaceState(historyState, "", url);
  else window.history.pushState(historyState, "", url);
}

export function cameraFromMap(map: {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
}): CameraState {
  const center = map.getCenter();
  return {
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
}

export function terrainLabel(mode: TerrainMode): string {
  return mode === "3d" ? "3D relief" : "2D relief";
}
