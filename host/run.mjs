#!/usr/bin/env node
// Runs the Inference module in a memory this host creates, then replays what
// happened in that memory as a terminal animation.
//
//   node host/run.mjs           animated replay (in a terminal)
//   node host/run.mjs --fast    the same, quicker
//   node host/run.mjs --plain   a plain log, for CI or a pipe
//
// Exits 1 if the program's report disagrees with the host's own arithmetic.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MEMORY, PAGE_BYTES, ZOOM_START, makeReadings, expectedReport, runDemo,
  tryWrongMemories, dataSegment,
} from "./demo-core.mjs";

const args = new Set(process.argv.slice(2));
const plain = args.has("--plain") || !process.stdout.isTTY;
const delay = args.has("--fast") ? 70 : 260;
const wasmPath = fileURLToPath(new URL("../out/main.wasm", import.meta.url));

const color = (code) => (text) => (plain ? text : `\x1b[${code}m${text}\x1b[0m`);
const dim = color("2");
const bold = color("1");
const yellow = color("33");
const cyan = color("36");
const green = color("32");
const red = color("31");
const flash = color("1;30;45");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n) => n.toLocaleString("en-US");
const SPARKS = "▁▂▃▄▅▆▇█";
const spark = (values) => values.map((v) => SPARKS[Math.min(7, Math.floor(v / 5))]).join("");

let wasm;
try {
  wasm = readFileSync(wasmPath);
} catch {
  console.error("out/main.wasm is missing: run `infs build` in the project first.");
  process.exit(2);
}

const readings = makeReadings();
const run = await runDemo(wasm, readings);
const report = run.events.find((event) => event.kind === "report");
const expected = expectedReport(readings);
const constants = dataSegment(wasm);
const matches =
  JSON.stringify(report.stats) === JSON.stringify(expected.stats) &&
  JSON.stringify(report.histogram) === JSON.stringify(expected.histogram);

// Which named region a byte of the page belongs to, for colouring.
const regionOf = (address) => {
  if (address >= constants.offset && address < constants.offset + constants.length) return "bands";
  if (address >= report.histogramAddress && address < report.histogramAddress + 16) return "histogram";
  if (address >= report.statsAddress && address < report.statsAddress + 16) return "stats";
  return "other";
};
const paint = { bands: yellow, histogram: cyan, stats: green, other: dim };

// The zoomed window: the top 256 bytes, 16 to a row, changed bytes flashing.
function hexView(bytes, previous) {
  const rows = [];
  for (let row = 0; row < 16; row += 1) {
    const base = ZOOM_START + row * 16;
    const cells = [];
    for (let col = 0; col < 16; col += 1) {
      const offset = row * 16 + col;
      const byte = bytes[offset];
      const text = byte.toString(16).padStart(2, "0");
      const changed = previous && previous[offset] !== byte;
      const region = regionOf(base + col);
      cells.push(changed ? flash(text) : byte === 0 && region === "other" ? dim(text) : paint[region](text));
    }
    const label =
      base === report.histogramAddress ? cyan("◀ histogram: [i32; 4]  (main's frame)")
      : base === report.statsAddress ? green("◀ stats: [i32; 4]  (main's frame)")
      : base === constants.offset ? yellow("◀ BANDS = [10, 20, 30]  (static data)")
      : "";
    rows.push(`  ${dim(String(base).padStart(5))}  ${cells.join(" ")}  ${label}`);
  }
  return rows.join("\n");
}

// The whole page as 64 cells of 1 KiB: almost all of it shadow stack.
function pageBar(sp) {
  const cells = Array.from({ length: 64 }, (_, i) => {
    const end = (i + 1) * 1024;
    if (end > constants.offset) return yellow("█");
    if (end > sp) return cyan("▓");
    return dim("░");
  });
  return [
    `  ┌${"─".repeat(64)}┐`,
    `  │${cells.join("")}│`,
    `  └${"─".repeat(64)}┘`,
    `   ${dim("0")}${" ".repeat(18)}${dim("shadow stack, grows down from " + fmt(run.initialStackPointer))}${" ".repeat(3)}${cyan("▓")}${dim(" frame")} ${yellow("█")}${dim(" data")}`,
  ].join("\n");
}

function histogramBars(histogram) {
  const names = ["  <10", "10-19", "20-29", "  ≥30"];
  return histogram
    .map((count, band) => `   ${names[band]} ${cyan("█".repeat(count))}${" ".repeat(12 - count)} ${count}`)
    .join("\n");
}

function frame(step, total, title, body) {
  const heading = `${bold(" Inference · a module running in a memory the host owns")}`;
  const counter = dim(`step ${step}/${total}`);
  return [
    `${heading}   ${counter}`,
    dim(" " + "─".repeat(78)),
    ` ${bold("env.memory")}  created by the host · ${MEMORY.initial} page · ${fmt(PAGE_BYTES)} bytes · maximum ${MEMORY.maximum}`,
    "",
    body,
    "",
    ` ${title}`,
  ].join("\n");
}

const clear = () => process.stdout.write("\x1b[2J\x1b[H");
const show = async (text) => {
  if (plain) {
    console.log(text + "\n");
  } else {
    clear();
    process.stdout.write(text + "\n");
    await sleep(delay);
  }
};

// Read the histogram the module keeps in its frame, as the host sees it.
const histogramIn = (bytes) => {
  const offset = report.histogramAddress - ZOOM_START;
  return Array.from(new Int32Array(bytes.buffer.slice(offset, offset + 16)));
};

const total = run.events.length;
if (!plain) process.stdout.write("\x1b[?25l"); // hide the cursor
try {
  await show(frame(0, total, "Instantiated: the data segment has written BANDS into the host's memory.", [
    pageBar(run.initialStackPointer),
    "",
    ` ${bold("top 256 bytes of the host's memory")} ${dim(`(${fmt(ZOOM_START)}–${fmt(PAGE_BYTES - 1)})`)}`,
    hexView(run.afterInstantiation, new Uint8Array(256)),
  ].join("\n")));
  if (!plain) await sleep(delay * 3);

  let previous = run.afterInstantiation;
  const seen = [];
  for (const [index, event] of run.events.entries()) {
    let title;
    if (event.kind === "count") {
      title = `host call  ${bold("sample_count()")} → ${event.value}`;
    } else if (event.kind === "sample") {
      seen.push(event.value);
      title = `host call  ${bold(`sample(${event.index})`)} → ${event.value}`;
    } else {
      title = `host call  ${bold("report")}(stats @ ${fmt(event.statsAddress)}, histogram @ ${fmt(event.histogramAddress)})  — read in place`;
    }
    const lines = [
      pageBar(event.sp),
      "",
      ` ${bold("top 256 bytes of the host's memory")} ${dim(`(${fmt(ZOOM_START)}–${fmt(PAGE_BYTES - 1)})`)}`,
      hexView(event.bytes, previous),
      "",
      `  __stack_pointer ${bold(fmt(event.sp))}  ${dim(`(main's frame: ${run.initialStackPointer - event.sp} bytes)`)}`,
      `  readings so far  ${cyan(spark(seen))}`,
      `  histogram, read from the module's frame in host memory:`,
      histogramBars(histogramIn(event.bytes)),
    ];
    if (event.kind === "report") {
      lines.push(
        "",
        `  ${green("stats")}  count ${event.stats[0]} · min ${event.stats[1]} · max ${event.stats[2]} · sum ${event.stats[3]}`,
        `  host's own arithmetic: ${matches ? green("agrees ✓") : red("DISAGREES ✗")}`,
      );
    }
    await show(frame(index + 1, total, title, lines.join("\n")));
    previous = event.bytes;
  }
  if (!plain) await sleep(delay * 4);

  const refusals = await tryWrongMemories(wasm);
  const lines = refusals.map((outcome) => {
    const offered = outcome.descriptor ? JSON.stringify(outcome.descriptor) : "a function";
    const verdict = outcome.refused ? red("refused") : red("ACCEPTED (unexpected)");
    return `  offer ${bold(offered.padEnd(28))} ${verdict}\n    ${dim(outcome.message)}`;
  });
  if (!plain) clear();
  console.log([
    bold(" The import is a contract: the engine refuses any other memory."),
    dim(" " + "─".repeat(78)),
    ` The module imports ${bold("(memory 1 1)")}: at least 1 page, and a maximum of at most 1.`,
    " So a host can never hand it more memory than its stack and overflow traps",
    " were laid out for.",
    "",
    ...lines,
    "",
    ` program returned ${run.result} · report ${matches ? green("matches") : red("does not match")} the host's arithmetic · ` +
      `memory export ${run.sameMemoryExported ? "is" : "is NOT"} the host's own object`,
  ].join("\n"));
  if (!matches || run.result !== 0 || refusals.some((outcome) => !outcome.refused)) process.exitCode = 1;
} finally {
  if (!plain) process.stdout.write("\x1b[?25h"); // show the cursor again
}
