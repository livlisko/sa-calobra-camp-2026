import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceDir = path.resolve(process.argv[2] ?? "");
const repoRoot = path.resolve(import.meta.dirname, "..");
const siteDir = path.join(repoRoot, "site");

if (!process.argv[2]) {
  throw new Error("Usage: node scripts/prepare-public-artifact.mjs <verified-data-app-dist>");
}

const sourceFiles = await readdir(sourceDir);
const snapshots = sourceFiles.filter((file) => /^snapshot\.[a-f0-9]{64}\.json$/.test(file));
if (snapshots.length !== 1) {
  throw new Error(`Expected one content-addressed snapshot, found ${snapshots.length}.`);
}

const snapshotName = snapshots[0];
const snapshotBytes = await readFile(path.join(sourceDir, snapshotName));
const snapshotHash = createHash("sha256").update(snapshotBytes).digest("hex");
if (snapshotName !== `snapshot.${snapshotHash}.json`) {
  throw new Error("Snapshot filename does not match its SHA-256 digest.");
}

let html = await readFile(path.join(sourceDir, "index.html"), "utf8");
html = html.replace(/\s*<meta name="data-app-local-thread" content="[^"]*">\s*/g, "\n");
html = `${html.split("\n").map((line) => line.trimEnd()).join("\n").trimEnd()}\n`;

const forbidden = [
  "/Users/",
  "data-app-local-thread",
  "data-app-sites-project",
  "appgprj_",
];
const publicText = `${html}\n${snapshotBytes.toString("utf8")}`;
for (const pattern of forbidden) {
  if (publicText.includes(pattern)) {
    throw new Error(`Public artifact contains forbidden pattern: ${pattern}`);
  }
}
for (const pattern of [/\b\d{11}_ACTIVITY(?: 2)?\.fit\b/, /strava\.com\/activities\/\d+/]) {
  if (pattern.test(publicText)) {
    throw new Error(`Public artifact contains a raw activity identifier matching ${pattern}.`);
  }
}
if (!html.includes(snapshotName)) {
  throw new Error("HTML does not reference the content-addressed snapshot.");
}

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
await writeFile(path.join(siteDir, "index.html"), html);
await writeFile(path.join(siteDir, snapshotName), snapshotBytes);
await writeFile(path.join(siteDir, ".nojekyll"), "");

console.log(JSON.stringify({ siteDir, snapshotName, snapshotHash }, null, 2));
