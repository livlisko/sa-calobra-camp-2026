import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { encodeSegmentFit } from "../fixtures/segment-fit.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../../map-app/public/data/mallorca-map.snapshot.json", import.meta.url)));
const segment = snapshot.segments.find((entry) => entry.segmentId === "segment-14");

test("the shipped worker compares two real FIT encodings and ignores a renamed copy", async ({ page }) => {
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.goto("/map/#tab=compare");
  const input = page.locator("input[type=file]");
  const earliest = Buffer.from(encodeSegmentFit(segment, new Date("2024-06-03T09:00:00Z")));
  const latest = Buffer.from(encodeSegmentFit(segment, new Date("2025-06-03T09:00:00Z")));
  await input.setInputFiles([
    { name: "first.fit", mimeType: "application/octet-stream", buffer: earliest },
    { name: "renamed.fit", mimeType: "application/octet-stream", buffer: earliest },
    { name: "second.fit", mimeType: "application/octet-stream", buffer: latest },
  ]);
  await expect(page.locator("#guide-count")).toHaveText("2 local");
  await expect(page.getByText("2 confirmed personal attempts.", { exact: false })).toBeVisible();
  await expect(page.getByRole("table", { name: /latest attempt compared/ })).toBeVisible();
  await expect(page.locator(".comparison-attempts-block")).toContainText("2 total");
});
