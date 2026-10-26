// Drives web/index.html: runs the module in a memory this page creates, then
// replays every host call as an animation over that memory.
//
// URL fragment: `#step=N` opens paused at step N; `offers` also tries every
// memory in the contract panel (both used for screenshots).

import {
  MEMORY, PAGE_BYTES, ZOOM_START, WRONG_MEMORIES, makeReadings, expectedReport, runDemo, dataSegment,
} from "../host/demo-core.mjs"; // @bundle-strip

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");
const BAND_NAMES = ["<10", "10–19", "20–29", "≥30"];
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

function int32At(bytes, address) {
  const o = address - ZOOM_START;
  return bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
}

/** One frame per step: the instantiated memory, then one per host call. */
function buildFrames(run, readings) {
  const report = run.events.find((e) => e.kind === "report");
  const frames = [{
    kind: "instantiated",
    bytes: run.afterInstantiation,
    sp: run.initialStackPointer,
    now: "Instantiated",
    explain: "The module's data segment has written BANDS = [10, 20, 30] into the host's memory at 65,520, " +
      "and its stack pointer starts right below it. The module defines no memory of its own.",
  }];
  let seen = 0;
  for (const event of run.events) {
    if (event.kind === "count") {
      frames.push({
        ...event, now: `sample_count() → ${event.value}`,
        explain: `main has carved its ${run.initialStackPointer - event.sp}-byte frame out of the host's memory: ` +
          `__stack_pointer moved from ${fmt(run.initialStackPointer)} to ${fmt(event.sp)}, and the frame is zeroed.`,
      });
    } else if (event.kind === "sample") {
      seen += 1;
      const previous = event.index > 0 ? readings[event.index - 1] : null;
      frames.push({
        ...event, seen, now: `sample(${event.index}) → ${event.value}`,
        explain: previous === null
          ? "The host hands over the first reading. The histogram lives in main's frame, so its counts are bytes in this memory."
          : `The flashing bytes are main's histogram, counting the previous reading (${previous}) in band ${BAND_NAMES[bandOf(previous)]}. ` +
            "The host watches them change in its own memory.",
      });
    } else {
      frames.push({
        ...event, seen, now: `report(stats @ ${fmt(event.statsAddress)}, histogram @ ${fmt(event.histogramAddress)})`,
        explain: "main passed two addresses inside this memory. The host reads both arrays in place: " +
          "no copy, and no lookup of the module's exports.",
      });
    }
  }
  return { frames, report };
}

function setupStatic(readings) {
  $("page").innerHTML = Array.from({ length: 64 }, (_, i) => `<span class="${i === 63 ? "top" : ""}"></span>`).join("");
  $("chart").innerHTML = readings.map(() => "<span></span>").join("");
  $("bars").innerHTML = BAND_NAMES.map((name, b) =>
    `<span class="lab">${name}</span><span class="track"><span class="fill" style="background:${BAND_COLORS[b]}"></span></span><span class="n">0</span>`,
  ).join("");
  $("stats").innerHTML = ["count", "min", "max", "sum"].map((k) =>
    `<div class="stat"><div class="k">${k}</div><div class="v">—</div></div>`).join("");
}

function render(state, index) {
  const { frames, report, readings, constants, expected } = state;
  const frame = frames[index];
  const previous = index > 0 ? frames[index - 1].bytes : null;
  $("step").textContent = `${index}/${frames.length - 1}`;
  $("now").innerHTML = `<b>${frame.now}</b>`;
  $("explain").textContent = frame.explain;

  // Byte grid, with the stack pointer drawn above the row it points into.
  const region = (address) => {
    if (address >= constants.offset && address < constants.offset + constants.length) return "bands";
    if (address >= report.histogramAddress && address < report.histogramAddress + 16) return "histogram";
    if (address >= report.statsAddress && address < report.statsAddress + 16) return "stats";
    return "";
  };
  const live = (address) => address >= frame.sp;
  const rowLabel = (base) =>
    base === report.histogramAddress ? ["histogram", "histogram"]
    : base === report.statsAddress ? ["stats", "stats"]
    : base === constants.offset ? ["bands", "BANDS"]
    : ["", ""];
  const html = [];
  for (let row = 0; row < 16; row += 1) {
    const base = ZOOM_START + row * 16;
    if (base === frame.sp && frame.sp !== PAGE_BYTES) {
      html.push(`<div class="sp" data-label="__stack_pointer = ${fmt(frame.sp)}"></div>`);
    }
    html.push(`<span class="addr">${fmt(base)}</span>`);
    for (let col = 0; col < 16; col += 1) {
      const offset = row * 16 + col;
      const byte = frame.bytes[offset];
      const r = region(base + col);
      const classes = ["b", r, byte ? "nz" : "", r && r !== "bands" && !live(base + col) ? "dimmed" : "",
        previous && previous[offset] !== byte ? "flash" : ""];
      html.push(`<span class="${classes.join(" ")}">${byte.toString(16).padStart(2, "0")}</span>`);
    }
    const [cls, text] = rowLabel(base);
    html.push(`<span class="rowlabel ${cls}">${text}</span>`);
  }
  $("bytes").innerHTML = html.join("");

  // Host-call log.
  const log = frames.slice(1, index + 1).map((f, i) =>
    `<li class="${i === index - 1 ? "cur" : ""}">${f.now}</li>`);
  $("log").innerHTML = log.join("") || `<li>no calls yet</li>`;
  $("log").scrollTop = $("log").scrollHeight;

  // Readings chart: what sample() has handed over so far.
  const seen = frame.seen ?? 0;
  [...$("chart").children].forEach((bar, i) => {
    const on = i < seen;
    bar.style.height = on ? `${8 + (readings[i] / 40) * 84}px` : "2px";
    bar.style.background = on ? BAND_COLORS[bandOf(readings[i])] : "";
    bar.classList.toggle("cur", frame.kind === "sample" && i === frame.index);
  });

  // Histogram, decoded from the module's frame in this memory.
  const counts = [0, 1, 2, 3].map((b) => (live(report.histogramAddress) ? int32At(frame.bytes, report.histogramAddress + 4 * b) : 0));
  const fills = $("bars").querySelectorAll(".fill");
  const ns = $("bars").querySelectorAll(".n");
  counts.forEach((count, b) => {
    fills[b].style.width = `${(count / readings.length) * 100 * 2.2}%`;
    ns[b].textContent = count;
  });

  // Report, once it has happened.
  const values = frame.kind === "report" ? frame.stats : null;
  $("stats").querySelectorAll(".stat").forEach((cell, i) => {
    cell.classList.toggle("on", Boolean(values));
    cell.querySelector(".v").textContent = values ? fmt(values[i]) : "—";
  });
  if (frame.kind === "report") {
    const agrees = JSON.stringify(frame.stats) === JSON.stringify(expected.stats) &&
      JSON.stringify(frame.histogram) === JSON.stringify(expected.histogram);
    $("check").innerHTML = agrees
      ? `<span class="ok">Matches the host's own arithmetic over the same readings.</span>`
      : `<span class="bad">Disagrees with the host's own arithmetic.</span>`;
  } else {
    $("check").textContent = "";
  }
}

function setupOffers(wasm) {
  const noop = () => 0;
  const offers = [{ label: "the memory it asks for", descriptor: MEMORY }, ...WRONG_MEMORIES];
  $("offers").innerHTML = offers.map((offer, i) => {
    const text = offer.descriptor
      ? `{ ${Object.entries(offer.descriptor).map(([k, v]) => `${k}: ${v}`).join(", ")} }`
      : "a function";
    return `<div class="offer"><button data-i="${i}">Offer ${text}</button><div class="verdict" id="v${i}">${offer.label}</div></div>`;
  }).join("");
  const attempt = async (i) => {
    const offer = offers[i];
    const verdict = $(`v${i}`);
    try {
      const memory = offer.descriptor ? new WebAssembly.Memory(offer.descriptor) : noop;
      await WebAssembly.instantiate(wasm, { env: { memory }, sensor: { sample_count: noop, sample: noop, report: noop } });
      verdict.className = "verdict";
      verdict.innerHTML = `<span class="ok">Instantiated</span>: ${offer.label}`;
    } catch (error) {
      verdict.className = "verdict refused";
      verdict.textContent = `refused: ${error.message.replace(/^WebAssembly\.instantiate\(\): /, "")}`;
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
  const run = await runDemo(wasm, readings);
  const { frames, report } = buildFrames(run, readings);
  const state = { frames, report, readings, constants: dataSegment(wasm), expected: expectedReport(readings) };
  setupStatic(readings);
  const tryAllOffers = setupOffers(wasm);
  $("footer").innerHTML =
    `<code>instance.exports.memory === memory</code> → <b>${run.sameMemoryExported}</b>: the module's <code>memory</code> export is the host's own object. ` +
    `main returned <b>${run.result}</b>.`;

  const params = new URLSearchParams(location.hash.slice(1));
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
  $("play").onclick = () => (timer ? stop() : play());
  $("stepfwd").onclick = () => { stop(); show(index + 1); };
  $("stepback").onclick = () => { stop(); show(index - 1); };
  $("restart").onclick = () => { show(0); play(); };
  $("speed").onchange = () => { if (timer) play(); };

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
