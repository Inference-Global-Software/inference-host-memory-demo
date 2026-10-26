// Drives web/index.html: runs the module in a memory this page creates, then
// replays every host call as an animation over that memory. The chooser at
// the top hands the module a different memory and replays the run in it.
//
// URL fragment (for screenshots): `step=N` opens paused at step N, `all`
// shows all 256 bytes, and `pages=P&limit=L` (or `limit=none`) starts the
// program with that memory instead of the default.

import {
  DEFAULT_MEMORY, PAGE_BYTES, ZOOM_START, makeReadings, expectedReport, runDemo, dataSegment,
  memoryImport, judgeMemory, tryMemory,
} from "../host/demo-core.mjs"; // @bundle-strip

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");
const amount = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const BAND_NAMES = ["under 10", "10–19", "20–29", "30 and up"];
const BAND_SHORT = ["<10", "10–19", "20–29", "≥30"];
const BAND_COLORS = ["var(--b0)", "var(--b1)", "var(--b2)", "var(--b3)"];
const bandOf = (v) => (v >= 30 ? 3 : v >= 20 ? 2 : v >= 10 ? 1 : 0);
const describe = (d) =>
  `new WebAssembly.Memory({ initial: ${d.initial}${d.maximum === undefined ? "" : `, maximum: ${d.maximum}`} })`;
const PRESETS = [
  { label: "Exactly what it asks for", descriptor: { initial: 1, maximum: 1 } },
  { label: "Room to grow", descriptor: { initial: 1, maximum: 4 } },
  { label: "Extra pages for this page", descriptor: { initial: 3, maximum: 4 } },
  { label: "No limit", descriptor: { initial: 1 } },
  { label: "A limit of 5", descriptor: { initial: 1, maximum: 5 } },
  { label: "No pages", descriptor: { initial: 0, maximum: 4 } },
];

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
    host: recorded.host ? { ...recorded.host, bytes: bytes(recorded.host.bytes) } : null,
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
  const { initial, maximum } = run.descriptor;
  const grows = maximum > initial ? `, allowed to grow to ${maximum}` : "";
  const hostPages = run.pages > 1
    ? ` Page${run.pages > 2 ? `s 2–${run.pages} are` : " 2 is"} this page's own: it wrote a marker at the start of page 2 before the program started.`
    : "";
  const frames = [{
    kind: "instantiated",
    bytes: run.afterInstantiation,
    sp: run.initialStackPointer,
    now: `The page creates ${amount(run.pages, "page")} of memory${grows}, and starts the program`,
    call: describe(run.descriptor),
    explain: "The program brings no memory of its own. As it starts, it copies its built-in band limits, " +
      `10, 20 and 30, into the top of page 1 (yellow).${hostPages}`,
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
      const stayed = run.host
        ? (run.host.untouched ? " Page 2's marker is untouched: the program stayed inside page 1." : " Page 2 was changed.")
        : "";
      frames.push({
        ...event, seen,
        now: "The program hands back its results",
        call: `report(stats @ ${fmt(event.statsAddress)}, histogram @ ${fmt(event.histogramAddress)})`,
        explain: `It counted the last reading (${readings[n - 1]} °C) in ${counted(readings[n - 1])}, ` +
          "then told the page where its two arrays are. Nothing is copied: the page reads them where they are. " +
          `${count} readings, lowest ${min} °C, highest ${max} °C, total ${fmt(sum)}.${stayed}`,
      });
    }
  }
  return frames;
}

function setupStatic(readings) {
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

/** One block per page handed over, then the room the memory may still grow into. */
function renderPages(run) {
  const total = Math.max(run.pages, run.descriptor.maximum ?? run.pages);
  const blocks = [];
  const labels = [];
  for (let page = 1; page <= total; page += 1) {
    if (page === 1) {
      blocks.push(`<span class="pg program"></span>`);
      labels.push(`<span><b>page 1</b>the program's</span>`);
    } else if (page <= run.pages) {
      blocks.push(`<span class="pg host"></span>`);
      labels.push(`<span><b>page ${page}</b>this page's own</span>`);
    } else {
      blocks.push(`<span class="pg room"></span>`);
      labels.push(`<span><b>page ${page}</b>room to grow</span>`);
    }
  }
  $("pagesbar").innerHTML = blocks.join("");
  $("pagelabels").innerHTML = labels.join("");
}

/** The start of page 2, which this page wrote and the program never touches. */
function renderHost(run, frame) {
  const panel = $("hostpage");
  if (!run.host) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const cells = [...run.host.bytes].map((byte) => `<span class="b">${byte.toString(16).padStart(2, "0")}</span>`).join("");
  const text = new TextDecoder().decode(run.host.bytes);
  const status = frame.kind !== "report"
    ? "This page wrote these bytes before it started the program."
    : run.host.untouched
      ? `<span class="ok">Unchanged after the run. All ${fmt(run.host.size)} bytes above page 1 are exactly as this page left them.</span>`
      : `<span class="bad">Changed during the run.</span>`;
  panel.innerHTML = `<h2>The start of page 2, this page's own</h2>` +
    `<div class="row">${cells}</div><p class="hint" style="margin:0">As text: <code>${text}</code></p>` +
    `<p class="status">${status}</p>`;
}

function render(state, index, showAll) {
  const { run, frames, readings, expected, rows } = state;
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
  renderHost(run, frame);

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

async function main() {
  const wasm = await loadWasm();
  const readings = makeReadings();
  const limits = memoryImport(wasm) ?? { minimum: 1, maximum: 4 };
  const constants = dataSegment(wasm);
  const expected = expectedReport(readings);
  const params = new URLSearchParams(location.hash.slice(1));
  const ui = { index: 0, timer: null, state: null, showAll: false, recorded: null };

  const show = (i) => {
    ui.index = Math.max(0, Math.min(ui.state.frames.length - 1, i));
    render(ui.state, ui.index, ui.showAll);
  };
  const stop = () => { clearInterval(ui.timer); ui.timer = null; $("play").textContent = "Play"; };
  const play = () => {
    if (ui.index >= ui.state.frames.length - 1) show(0);
    clearInterval(ui.timer);
    $("play").textContent = "Pause";
    ui.timer = setInterval(() => (ui.index >= ui.state.frames.length - 1 ? stop() : show(ui.index + 1)),
      Number($("speed").value));
  };

  /** Runs the program in `descriptor`'s memory (or replays the recording) and shows that run. */
  const load = async (descriptor) => {
    const run = ui.recorded ? recordedRun(ui.recorded) : await runDemo(wasm, readings, descriptor);
    const report = run.events.find((e) => e.kind === "report");
    ui.state = { run, frames: buildFrames(run, readings, report), readings, expected, rows: namedRows(report, constants) };
    renderPages(run);
    $("footer").innerHTML =
      `<code>instance.exports.memory === memory</code> is <b>${run.sameMemoryExported}</b>: the program's memory is this page's own object. ` +
      `The program finished and returned <b>${run.result}</b>.`;
  };

  // The chooser.
  $("asks").innerHTML = `The program asks for at least ${amount(limits.minimum, "page")}, allowed to grow to at most ` +
    `${amount(limits.maximum, "page")}: its import is <code>(memory ${limits.minimum} ${limits.maximum})</code>. ` +
    "Pick a memory and start the program in it.";
  $("pages").innerHTML = Array.from({ length: 7 }, (_, n) => `<option value="${n}">${amount(n, "page")}</option>`).join("");
  $("limit").innerHTML = `<option value="none">no limit</option>` +
    Array.from({ length: 6 }, (_, n) => `<option value="${n + 1}">${amount(n + 1, "page")}</option>`).join("");
  const chosen = () => {
    const limit = $("limit").value;
    return { initial: Number($("pages").value), ...(limit === "none" ? {} : { maximum: Number(limit) }) };
  };
  const choose = (descriptor) => {
    $("pages").value = String(descriptor.initial);
    $("limit").value = descriptor.maximum === undefined ? "none" : String(descriptor.maximum);
  };
  const preview = () => {
    const verdict = judgeMemory(chosen(), limits);
    $("outcome").className = "outcome";
    $("outcome").innerHTML = `<b>${verdict.accepted ? "The program should accept this memory." : "The program should refuse this memory."}</b>` +
      `${verdict.reason}<span class="says">${describe(chosen())}</span>`;
  };
  const start = async () => {
    const descriptor = chosen();
    const verdict = judgeMemory(descriptor, limits);
    const engine = await tryMemory(wasm, descriptor);
    if (engine.accepted) {
      await load(descriptor);
      $("outcome").className = "outcome good";
      $("outcome").innerHTML = `<b>Started. The replay below now runs in this memory.</b>${verdict.reason}` +
        `<span class="says">${describe(descriptor)}</span>`;
      show(0);
      if (!params.has("step")) play();
    } else {
      $("outcome").className = "outcome bad";
      $("outcome").innerHTML = `<b>Refused. The replay below still shows the last memory that was accepted.</b>` +
        `${verdict.accepted ? "This page expected the program to accept it." : verdict.reason}` +
        `<span class="says">The browser says: ${engine.message.replace(/^(LinkError|RangeError|TypeError): (WebAssembly\.\w+\(\): )?/, "")}</span>`;
    }
  };
  $("pages").onchange = preview;
  $("limit").onchange = preview;
  $("start").onclick = start;
  $("presets").innerHTML = `<span class="lead">Try:</span>` +
    PRESETS.map((p, i) => `<button data-i="${i}">${p.label}</button>`).join("");
  $("presets").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    choose(PRESETS[Number(button.dataset.i)].descriptor);
    start();
  });

  setupStatic(readings);
  const initial = params.has("pages")
    ? { initial: Number(params.get("pages")), ...(params.get("limit") === "none" ? {} : { maximum: Number(params.get("limit") ?? params.get("pages")) }) }
    : DEFAULT_MEMORY;
  try {
    choose(DEFAULT_MEMORY);
    await load(DEFAULT_MEMORY);
  } catch (error) {
    if (!globalThis.DEMO_RECORDED) throw error;
    ui.recorded = globalThis.DEMO_RECORDED;
    await load(null);
    $("banner").hidden = false;
    $("banner").textContent =
      "This viewer does not run WebAssembly, so the page is replaying a run recorded from the same program in " +
      `${amount(ui.recorded.pages, "page")} of memory, and choosing a different memory is switched off. ` +
      "The demo repository's page runs it live.";
    for (const id of ["pages", "limit", "start"]) $(id).disabled = true;
    $("presets").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  }
  if (!ui.recorded) {
    $("outcome").className = "outcome good";
    $("outcome").innerHTML = `<b>Running in the default memory.</b>${judgeMemory(DEFAULT_MEMORY, limits).reason}` +
      `<span class="says">${describe(DEFAULT_MEMORY)}</span>`;
  }

  $("play").onclick = () => (ui.timer ? stop() : play());
  $("stepfwd").onclick = () => { stop(); show(ui.index + 1); };
  $("stepback").onclick = () => { stop(); show(ui.index - 1); };
  $("restart").onclick = () => { show(0); play(); };
  $("speed").onchange = () => { if (ui.timer) play(); };
  $("toggle").onclick = () => {
    ui.showAll = !ui.showAll;
    $("toggle").textContent = ui.showAll ? "Show only the rows that matter" : "Show all 256 bytes";
    $("toggle").setAttribute("aria-pressed", String(ui.showAll));
    render(ui.state, ui.index, ui.showAll);
  };

  show(0);
  if (params.has("all")) $("toggle").onclick();
  if (params.has("pages") && !ui.recorded) {
    choose(initial);
    await start();
  }
  if (params.has("step")) {
    document.body.classList.add("static");
    stop();
    show(Number(params.get("step")));
  } else if (!ui.timer) {
    play();
  }
}

main().catch((error) => {
  $("now").textContent = "Could not run the demo";
  $("explain").textContent = String(error);
});
