#!/usr/bin/env node
// Runs the Inference module embedded in the firmware's memory (host/firmware.wat)
// and checks the outcome. No JavaScript runs between the two programs: the
// module's `sensor` imports are the firmware's own exports.
//
//   node host/embedded.mjs
//
// Exits 1 if any check fails.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeReadings, expectedReport, runDemo, runEmbedded, FIRMWARE } from "./demo-core.mjs";

const file = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)));
const inference = file("../out/main.wasm");
const firmware = file("./firmware.wasm");
const fmt = (n) => n.toLocaleString("en-US");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const run = await runEmbedded(inference, firmware);
const readings = makeReadings();
const expected = expectedReport(readings);
const alone = await runDemo(inference, readings, { initial: 1, maximum: 4 });
const aloneTop = alone.events.at(-1).bytes;

const checks = [
  ["the firmware's log holds the demo's readings", same(run.firmware.readings, readings)],
  [`it answered ${run.firmware.answered} calls: sample_count, ${readings.length} x sample, report`,
    run.firmware.answered === readings.length + 2],
  [`it read the results at byte ${fmt(run.firmware.statsAddress)} and copied them to ${fmt(FIRMWARE.results)}`,
    same(run.firmware.copiedStats, run.program.stats) && same(run.firmware.copiedHistogram, run.program.histogram)],
  ["the results match this host's own arithmetic", same(run.program.stats, expected.stats) && same(run.program.histogram, expected.histogram)],
  ["page 1 ends exactly as it does with no firmware at all", run.pageOneTop.every((byte, i) => byte === aloneTop[i])],
  ["the program returned 0", run.result === 0],
];

console.log(`One memory, ${run.pages} pages: page 1 is the Inference module's, pages 2-${run.descriptor.maximum} the firmware's.`);
console.log(`results ${run.program.stats.join(", ")} · band counters ${run.program.histogram.join(", ")}`);
for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
