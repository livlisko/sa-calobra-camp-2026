import type { AtlasData, AtlasState, CameraState, GuideTab, TerrainMode } from "./types";

const GUIDE_TABS: GuideTab[] = ["island", "rides", "segments", "point"];

export function defaultState(): AtlasState {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    selectedRideId: null,
    selectedSegmentId: null,
    selectedPointId: null,
    previewRideId: null,
    terrain: reducedMotion ? "2d" : "3d",
    tab: "island",
    camera: null,
  };
}

function parseCamera(value: string | null): CameraState | null {
  if (!value) return null;
  const values = value.split(",").map(Number);
  if (values.length !== 5 || values.some((entry) => !Number.isFinite(entry))) return null;
  const [longitude, latitude, zoom, bearing, pitch] = values;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || zoom < 0 || zoom > 22) return null;
  return { longitude, latitude, zoom, bearing, pitch: Math.min(85, Math.max(0, pitch)) };
}

function formatCamera(camera: CameraState): string {
  return [camera.longitude.toFixed(5), camera.latitude.toFixed(5), camera.zoom.toFixed(2), camera.bearing.toFixed(1), camera.pitch.toFixed(1)].join(",");
}

export function stateFromHash(data: AtlasData, fallback: AtlasState): AtlasState {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const rideIds = new Set(data.rides.map((ride) => ride.rideId));
  const segmentIds = new Set(data.segments.map((segment) => segment.segmentId));
  const points = data.rides.flatMap((ride) => ride.telemetrySamples);
  const pointIds = new Set(points.map((point) => point.sampleId));
  const segment = data.segments.find((entry) => entry.segmentId === params.get("segment"));
  const point = points.find((entry) => entry.sampleId === params.get("point"));
  let selectedRideId = rideIds.has(params.get("ride") ?? "") ? params.get("ride") : null;
  const selectedSegmentId = segmentIds.has(params.get("segment") ?? "") ? params.get("segment") : null;
  const selectedPointId = pointIds.has(params.get("point") ?? "") ? params.get("point") : null;
  if (segment) selectedRideId = segment.rideId;
  if (point) selectedRideId = point.rideId;
  const terrainParam = params.get("terrain");
  const tabParam = params.get("tab") as GuideTab | null;
  return {
    selectedRideId,
    selectedSegmentId,
    selectedPointId,
    previewRideId: null,
    terrain: terrainParam === "2d" || terrainParam === "3d" ? terrainParam : fallback.terrain,
    tab: tabParam && GUIDE_TABS.includes(tabParam) ? tabParam : selectedPointId ? "point" : selectedSegmentId ? "segments" : fallback.tab,
    camera: parseCamera(params.get("map")),
  };
}

export function writeStateToHash(state: AtlasState, mode: "push" | "replace" = "push"): void {
  const params = new URLSearchParams();
  if (state.selectedRideId) params.set("ride", state.selectedRideId);
  if (state.selectedSegmentId) params.set("segment", state.selectedSegmentId);
  if (state.selectedPointId) params.set("point", state.selectedPointId);
  if (state.terrain !== "3d") params.set("terrain", state.terrain);
  if (state.tab !== "island") params.set("tab", state.tab);
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
