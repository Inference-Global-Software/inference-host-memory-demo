// Drives web/index.html: runs the module in a memory this page creates, then
// replays every host call as an animation over that memory.
//
// URL fragment: `#step=N` opens paused at step N, `all` shows all 256 bytes,
// and `offers` tries every memory in the contract panel (for screenshots).

import {
  MEMORY, PAGE_BYTES, ZOOM_START, WRONG_MEMORIES, makeReadings, expectedReport, runDemo, dataSegment,
} from "../host/demo-core.mjs"; // @bundle-strip

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");
const BAND_NAMES = ["under 10", "10–19", "20–29", "30 and up"];
const BAND_SHORT = ["<10", "10–19", "20–29", "≥30"];
const BAND_COLORS = ["var(--b0)", "var(--b1)", "var(--b2)", "var(--b3)"];
const bandOf = (v) => (v >= 30 ? 3 : v >= 20 ? 2 : v >= 10 ? 1 : 0);

async function loadWasm() {
  if (globalThis.DEMO_WASM_BASE64) {
    return Uint8Array.from(atob(globalThis.DEMO_WASM_BASE64), (c) => c.charCodeAt(0));
  }
  const response = await fetch(new URL("../out/main.wasm", import.meta.url));
  if (!response.ok) throw new Error("out/main.wasm not found: run `infs build` first");
  return new Uint8Array(await response.arrayBuffer());
}

/** A run recorded from the same module, for a viewer that cannot run it. */
function recordedRun(recorded) {
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return {
    ...recorded,
    afterInstantiation: bytes(recorded.afterInstantiation),
    events: recorded.events.map((event) => ({ ...event, bytes: bytes(event.bytes) })),
  };
}

/** The little-endian i32 at `address` in a snapshot of the zoomed window. */
function int32At(bytes, address) {
  const o = address - ZOOM_START;
  return bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
}

/** One frame per step, each with a plain caption: start-up, then one per host call. */
function buildFrames(run, readings, report) {
  const n = readings.length;
  const frames = [{
    kind: "instantiated",
    bytes: run.afterInstantiation,
    sp: run.initialStackPointer,
    now: "The page creates the memory and starts the program",
    call: "new WebAssembly.Memory({ initial: 1, maximum: 1 })",
    explain: "The program brings no memory of its own. As it starts, it copies its built-in band limits, " +
      "10, 20 and 30, into the top of this page's memory (yellow).",
  }];
  let seen = 0;
  for (const event of run.events) {
    const counted = (reading) => {
      const band = bandOf(reading);
      const count = int32At(event.bytes, report.histogramAddress + 4 * band);
      return `the ${BAND_NAMES[band]} band, so that counter is now ${count}`;
    };
    if (event.kind === "count") {
      frames.push({
        ...event, seen,
        now: `The program asks how many readings there are: ${event.value}`,
        call: `sample_count() → ${event.value}`,
        explain: `To do its work it sets aside ${run.initialStackPointer - event.sp} bytes just below the band ` +
          "limits, under the dashed line: four band counters (blue) and four result slots (green), all starting at zero.",
      });
    } else if (event.kind === "sample") {
      seen += 1;
      const previous = event.index > 0 ? readings[event.index - 1] : null;
      frames.push({
        ...event, seen,
        now: `The program asks for reading ${event.index + 1} of ${n} and gets ${event.value} °C`,
        call: `sample(${event.index}) → ${event.value}`,
        explain: previous === null
          ? "Nothing is counted yet. The counters live in this page's memory, so every count the program makes shows up here."
          : `It has just counted reading ${event.index} (${previous} °C) in ${counted(previous)}. ` +
            "The pink bytes are that counter changing.",
      });
    } else {
      const [count, min, max, sum] = event.stats;
      frames.push({
        ...event, seen,
        now: "The program hands back its results",
        call: `report(stats @ ${fmt(event.statsAddress)}, histogram @ ${fmt(event.histogramAddress)})`,
        explain: `It counted the last reading (${readings[n - 1]} °C) in ${counted(readings[n - 1])}, ` +
          "then told the page where its two arrays are. Nothing is copied: the page reads them where they are. " +
          `${count} readings, lowest ${min} °C, highest ${max} °C, total ${fmt(sum)}.`,
      });
    }
  }
  return frames;
}

function setupStatic(readings) {
  $("page").innerHTML = Array.from({ length: 64 }, (_, i) => `<span class="${i === 63 ? "top" : ""}"></span>`).join("");
  $("chart").innerHTML = readings.map(() => "<span></span>").join("");
  $("bars").innerHTML = BAND_SHORT.map((name, b) =>
    `<span class="lab">${name}</span><span class="track"><span class="fill" style="background:${BAND_COLORS[b]}"></span></span><span class="n">0</span>`,
  ).join("");
  $("stats").innerHTML = ["readings", "lowest", "highest", "total"].map((k) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">—</div></div>`).join("");
}

/** The three rows worth reading, and what their four numbers are. */
function namedRows(report, constants) {
  return [
    { key: "histogram", base: report.histogramAddress, title: "Band counters", sub: "readings per band",
      fields: BAND_SHORT, idle: "not in use yet" },
    { key: "results", base: report.statsAddress, title: "Results", sub: "written at the end",
      fields: ["readings", "lowest", "highest", "total"], idle: "not in use yet", empty: "empty until the end" },
    { key: "bands", base: constants.offset, title: "Band limits", sub: "built into the program",
      fields: ["", "", "", null], idle: "" },
  ];
}

function render(state, index) {
  const { frames, readings, expected, rows, showAll } = state;
  const frame = frames[index];
  const previous = index > 0 ? frames[index - 1].bytes : null;
  $("step").textContent = `step ${index} of ${frames.length - 1}`;
  $("now").textContent = frame.now;
  $("call").textContent = frame.call;
  $("explain").textContent = frame.explain;

  const live = (address) => address >= frame.sp;
  const rowOf = (base) => rows.find((row) => row.base === base);
  const changed = (offset) => previous && previous[offset] !== frame.bytes[offset];
  const html = [];
  const visible = showAll
    ? Array.from({ length: 16 }, (_, r) => r)
    : rows.map((row) => (row.base - ZOOM_START) / 16).sort((a, b) => a - b);
  if (!showAll) {
    const hidden = Array.from({ length: 16 }, (_, r) => r).filter((r) => !visible.includes(r));
    const used = hidden.reduce((sum, r) => sum + frame.bytes.slice(r * 16, r * 16 + 16).filter(Boolean).length, 0);
    html.push(`<span class="addr"></span><span class="skipped">${hidden.length} rows above (${fmt(ZOOM_START)}–${fmt(ZOOM_START + hidden.length * 16 - 1)}) hidden: ` +
      `${used ? `${used} bytes in use` : "all zero, never touched"}</span>`);
  }
  for (const r of visible) {
    const base = ZOOM_START + r * 16;
    if (base === frame.sp && frame.sp !== PAGE_BYTES) {
      html.push(`<div class="sp" data-label="the program's working area starts here (stack pointer ${fmt(frame.sp)})"></div>`);
    }
    const row = rowOf(base);
    const inUse = row && (row.key === "bands" || live(base));
    if (row) html.push(`<span class="addr"></span><span class="rowhead ${row.key}"><b>${row.title}</b>${row.sub}</span>`);
    html.push(`<span class="addr">${fmt(base)}</span>`);
    for (let col = 0; col < 16; col += 1) {
      const offset = r * 16 + col;
      const byte = frame.bytes[offset];
      const classes = ["b", row ? row.key : "", byte ? "nz" : "", row && !inUse ? "dimmed" : "",
        col > 0 && col % 4 === 0 ? "gap" : "", changed(offset) ? "flash" : ""];
      html.push(`<span class="${classes.join(" ")}">${byte.toString(16).padStart(2, "0")}</span>`);
    }
    if (!row) continue;
    // The decoded line: each group of four bytes as the number it holds, or
    // one note across the row while it holds nothing yet.
    html.push(`<span class="addr"></span>`);
    const allZero = frame.bytes.slice(r * 16, r * 16 + 16).every((byte) => byte === 0);
    const note = !inUse ? row.idle : row.empty && allZero ? row.empty : null;
    if (note !== null) {
      html.push(`<span class="decoded wide off">${note}</span>`);
      continue;
    }
    for (let g = 0; g < 4; g += 1) {
      const gap = g > 0 ? " gap" : "";
      const hot = [0, 1, 2, 3].some((k) => changed(r * 16 + g * 4 + k)) ? " hot" : "";
      let text;
      if (row.fields[g] === null) text = `<span class="k">unused</span>`;
      else {
        const value = fmt(int32At(frame.bytes, base + 4 * g));
        text = row.fields[g] ? `<span class="k">${row.fields[g]}</span> ${value}` : value;
      }
      const off = row.fields[g] === null ? " off" : "";
      html.push(`<span class="decoded${gap}${hot}${off}">${text}</span>`);
    }
  }
  $("bytes").innerHTML = html.join("");

  // What the program asked for, so far.
  const log = frames.slice(1, index + 1).map((f, i) => {
    const plain = f.kind === "count" ? "how many?" : f.kind === "sample" ? `reading ${f.index + 1}` : "results";
    return `<li class="${i === index - 1 ? "cur" : ""}">${f.call}<span>${plain}</span></li>`;
  });
  $("log").innerHTML = log.join("") || `<li>nothing yet</li>`;
  $("log").scrollTop = $("log").scrollHeight;

  // Readings handed over so far.
  const seen = frame.seen ?? 0;
  [...$("chart").children].forEach((bar, i) => {
    const on = i < seen;
    bar.style.height = on ? `${8 + (readings[i] / 40) * 80}px` : "2px";
    bar.style.background = on ? BAND_COLORS[bandOf(readings[i])] : "";
    bar.title = on ? `reading ${i + 1}: ${readings[i]} °C` : "";
    bar.classList.toggle("cur", frame.kind === "sample" && i === frame.index);
  });

  // Band counters, decoded from the blue bytes.
  const histogram = rows[0];
  const counts = [0, 1, 2, 3].map((b) => (live(histogram.base) ? int32At(frame.bytes, histogram.base + 4 * b) : 0));
  const fills = $("bars").querySelectorAll(".fill");
  const ns = $("bars").querySelectorAll(".n");
  counts.forEach((count, b) => {
    fills[b].style.width = `${Math.min(100, (count / readings.length) * 220)}%`;
    ns[b].textContent = count;
  });

  // Results, decoded from the green bytes once they are written.
  const values = frame.kind === "report" ? frame.stats : null;
  $("stats").querySelectorAll(".stat").forEach((cell, i) => {
    cell.classList.toggle("on", Boolean(values));
    cell.querySelector(".v").textContent = values ? fmt(values[i]) : "—";
  });
  if (frame.kind === "report") {
    const agrees = JSON.stringify(frame.stats) === JSON.stringify(expected.stats) &&
      JSON.stringify(frame.histogram) === JSON.stringify(expected.histogram);
    $("check").innerHTML = agrees
      ? `<span class="ok">Checked: this page's own arithmetic over the same readings gives the same answer.</span>`
      : `<span class="bad">These disagree with this page's own arithmetic.</span>`;
  } else {
    $("check").textContent = "";
  }
}

function setupOffers(wasm, recordedOffers) {
  const noop = () => 0;
  const offers = [
    { title: "Hand it exactly what it asks for", descriptor: MEMORY },
    ...WRONG_MEMORIES.map((wrong, i) => ({
      ...wrong,
      title: ["Hand it memory with no size limit", "Hand it memory allowed to grow to two pages",
        "Hand it memory with no pages", "Hand it a function instead"][i],
    })),
  ];
  $("offers").innerHTML = offers.map((offer, i) => {
    const what = offer.descriptor
      ? `{ ${Object.entries(offer.descriptor).map(([k, v]) => `${k}: ${v}`).join(", ")} }`
      : "a function";
    return `<div class="offer"><button data-i="${i}">${offer.title}<span class="what">${what}</span></button>` +
      `<div class="verdict" id="v${i}">not tried yet</div></div>`;
  }).join("");
  const plain = (message) => message.replace(/^(LinkError: )?WebAssembly\.instantiate\(\): /, "");
  const attempt = async (i) => {
    const offer = offers[i];
    const verdict = $(`v${i}`);
    if (recordedOffers) {
      const outcome = recordedOffers[i];
      verdict.className = outcome.refused ? "verdict refused" : "verdict";
      verdict.innerHTML = outcome.refused
        ? `Refused (recorded): ${plain(outcome.message)}`
        : `<span class="ok">Started</span> (recorded)`;
      return;
    }
    try {
      const memory = offer.descriptor ? new WebAssembly.Memory(offer.descriptor) : noop;
      await WebAssembly.instantiate(wasm, { env: { memory }, sensor: { sample_count: noop, sample: noop, report: noop } });
      verdict.className = "verdict";
      verdict.innerHTML = `<span class="ok">Started</span>`;
    } catch (error) {
      verdict.className = "verdict refused";
      verdict.textContent = `Refused: ${plain(error.message)}`;
    }
  };
  $("offers").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (button) attempt(Number(button.dataset.i));
  });
  return () => Promise.all(offers.map((_, i) => attempt(i)));
}

async function main() {
  const wasm = await loadWasm();
  const readings = makeReadings();
  let run;
  let recordedOffers = null;
  try {
    run = await runDemo(wasm, readings);
  } catch (error) {
    const recorded = globalThis.DEMO_RECORDED;
    if (!recorded) throw error;
    run = recordedRun(recorded);
    recordedOffers = recorded.offers;
    $("banner").hidden = false;
    $("banner").textContent =
      "This viewer does not run WebAssembly, so the page is replaying a run recorded from the same program, " +
      "and the contract panel shows the recorded refusals. The demo repository's page runs it live.";
  }
  const report = run.events.find((e) => e.kind === "report");
  const state = {
    frames: buildFrames(run, readings, report),
    readings,
    expected: expectedReport(readings),
    rows: namedRows(report, dataSegment(wasm)),
    showAll: false,
  };
  setupStatic(readings);
  const tryAllOffers = setupOffers(wasm, recordedOffers);
  $("footer").innerHTML =
    `<code>instance.exports.memory === memory</code> is <b>${run.sameMemoryExported}</b>: the program's memory is this page's own object. ` +
    `The program finished and returned <b>${run.result}</b>.`;

  const params = new URLSearchParams(location.hash.slice(1));
  const { frames } = state;
  let index = 0;
  let timer = null;
  const show = (i) => { index = Math.max(0, Math.min(frames.length - 1, i)); render(state, index); };
  const stop = () => { clearInterval(timer); timer = null; $("play").textContent = "Play"; };
  const play = () => {
    if (index >= frames.length - 1) show(0);
    clearInterval(timer);
    $("play").textContent = "Pause";
    timer = setInterval(() => (index >= frames.length - 1 ? stop() : show(index + 1)), Number($("speed").value));
  };
  const setShowAll = (on) => {
    state.showAll = on;
    $("toggle").textContent = on ? "Show only the rows that matter" : "Show all 256 bytes";
    $("toggle").setAttribute("aria-pressed", String(on));
    render(state, index);
  };
  $("play").onclick = () => (timer ? stop() : play());
  $("stepfwd").onclick = () => { stop(); show(index + 1); };
  $("stepback").onclick = () => { stop(); show(index - 1); };
  $("restart").onclick = () => { show(0); play(); };
  $("speed").onchange = () => { if (timer) play(); };
  $("toggle").onclick = () => setShowAll(!state.showAll);

  if (params.has("all")) setShowAll(true);
  if (params.has("step")) {
    document.body.classList.add("static");
    show(Number(params.get("step")));
    stop();
  } else {
    show(0);
    play();
  }
  if (params.has("offers")) await tryAllOffers();
}

main().catch((error) => {
  $("now").textContent = "Could not run the demo";
  $("explain").textContent = String(error);
});
