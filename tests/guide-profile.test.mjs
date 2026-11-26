import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transformWithOxc } from "vite";

const source = new URL("../map-app/src/data.ts", import.meta.url);
const { code } = await transformWithOxc(await readFile(source, "utf8"), source.pathname, { sourcemap: false });
const { sampledSegmentExtents } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("sampled profile extents keep single observations and break at missing or untagged samples", () => {
  const ride = {
    telemetrySamples: [
      [0, 1, null], [30, 1.3, "a"], [60, 1.5, null], [90, 1.7, "a"],
      [121, 2, "a"], [181, 2.4, "a"], [210, 2.5, "a"], [240, 3, "b"],
    ].map(([movingSeconds, distanceKm, segmentId]) => ({ movingSeconds, distanceKm, segmentId })),
  };
  assert.deepEqual(sampledSegmentExtents(ride, "a"), [[1.3, 1.3], [1.7, 2], [2.4, 2.5]]);
  assert.deepEqual(sampledSegmentExtents(ride, "b"), [[3, 3]]);
  assert.deepEqual(sampledSegmentExtents(ride, "unrecorded"), []);
});
