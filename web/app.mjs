// Drives web/index.html, a six-step walkthrough: how a program normally gets
// its memory, how an imported one differs, the program running in this page's
// memory, its results read in place, the page growing that memory up to the
// program's limit, and an experiment with other memories.
//
// The URL fragment names the step to open (`#normal`, `#imported`,
// `#running`, `#results`, `#growing`, `#try`). For screenshots, `#running-12`
// and `#growing-12` open that replay paused at frame 12, and `#try-3-4` or
// `#try-1-none` starts the program in that memory.

import {
  DEFAULT_MEMORY, ZOOM_START, makeReadings, expectedReport, runDemo, dataSegment, memoryImport, judgeMemory, tryMemory,
} from "../host/demo-core.mjs"; // @bundle-strip

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");
const amount = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const STEPS = ["normal", "imported", "running", "results", "growing", "try"];
const BANDS = ["under 10", "10–19", "20–29", "30 and up"];
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

/** `count` little-endian i32s starting at `address`, read from a snapshot of the page's end. */
function ints(bytes, address, count) {
  return Array.from({ length: count }, (_, k) => {
    const o = address - ZOOM_START + 4 * k;
    return bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
  });
}

/** The program's three regions, with their addresses in the page's memory. */
function regionsOf(run, constants) {
  const report = run.events.find((e) => e.kind === "report");
  return { counters: report.histogramAddress, results: report.statsAddress, limits: constants.offset };
}

/** The band counters as a cell of plain numbers, read from a snapshot. */
function countersCellHTML(frame, regions, hot = -1) {
  const inUse = frame.sp <= regions.counters;
  const values = inUse ? ints(frame.bytes, regions.counters, 4) : null;
  return `<div class="cell counters"><div class="head">Band counters, still in page 1<span class="addr">byte ${fmt(regions.counters)}</span></div>` +
    `<div class="nums">${BANDS.map((k, i) =>
      `<span class="num${i === hot ? " hot" : ""}"><span class="v">${values ? fmt(values[i]) : "–"}</span><span class="k">${k}</span></span>`).join("")}</div>` +
    `<div class="sub">${inUse ? "the program keeps counting, whatever the page does with the memory" : "not in use until the program starts counting"}</div></div>`;
}

/** Page 1 drawn as one bar, then the program's three regions enlarged, with the numbers they hold. */
function stripHTML(frame, regions, { focus = [], hot = -1 } = {}) {
  const inUse = frame.sp <= regions.counters;
  const counters = inUse ? ints(frame.bytes, regions.counters, 4) : null;
  const results = frame.kind === "report" ? frame.stats : null;
  const limits = ints(frame.bytes, regions.limits, 3);
  const nums = (values, keys, hotIndex = -1) => `<div class="nums">${keys.map((k, i) =>
    `<span class="num${i === hotIndex ? " hot" : ""}"><span class="v">${values ? fmt(values[i]) : "–"}</span><span class="k">${k}</span></span>`,
  ).join("")}</div>`;
  const cell = (key, title, address, body, sub) =>
    `<div class="cell ${key}${focus.includes(key) ? " focus" : ""}"><div class="head">${title}<span class="addr">byte ${fmt(address)}</span></div>${body}<div class="sub">${sub}</div></div>`;
  return `<div class="bar">Page 1 of this page's memory: 65,536 bytes, nearly all of it empty room the program keeps for its stack</div>` +
    `<p class="zoomnote">its last 48 bytes, enlarged</p><div class="cells">` +
    cell("counters", "Band counters", regions.counters, nums(counters, BANDS, hot),
      inUse ? "the program adds 1 to a band after each reading" : "not in use until the program starts counting") +
    cell("results", "Results", regions.results, nums(results, ["readings", "lowest", "highest", "total"]),
      results ? "written once, at the end" : "empty until the end") +
    cell("limits", "Band limits", regions.limits, nums(limits, ["", "", ""]), "copied in when the program started") +
    `</div>`;
}

/** The same three regions as raw bytes, for the details toggle. */
function rawHTML(frame, regions) {
  const rows = [["counters", regions.counters, "band counters"], ["results", regions.results, "results"],
    ["limits", regions.limits, "band limits (last 4 bytes unused)"]];
  return `<table>${rows.map(([key, base, what]) => {
    const offset = base - ZOOM_START;
    const cells = [...frame.bytes.slice(offset, offset + 16)].map((byte, i) =>
      `<td class="${key}${i > 0 && i % 4 === 0 ? " gap" : ""}">${byte.toString(16).padStart(2, "0")}</td>`).join("");
    return `<tr><th>${fmt(base)}</th>${cells}<td class="what">${what}</td></tr>`;
  }).join("")}</table>` +
    `<p class="note">Each number takes four bytes, smallest first, in hexadecimal: <code>0a 00 00 00</code> is 10.</p>`;
}

async function main() {
  const wasm = await loadWasm();
  const readings = makeReadings();
  const limits = memoryImport(wasm) ?? { minimum: 1, maximum: 4 };
  const constants = dataSegment(wasm);
  const expected = expectedReport(readings);
  const [hashStep, ...hashArgs] = location.hash.slice(1).split("-");
  let recorded = null;

  let run;
  try {
    run = await runDemo(wasm, readings, DEFAULT_MEMORY);
  } catch (error) {
    if (!globalThis.DEMO_RECORDED) throw error;
    recorded = globalThis.DEMO_RECORDED;
    run = recordedRun(recorded);
    $("banner").hidden = false;
    $("banner").textContent = "This viewer does not run WebAssembly, so the steps replay a run recorded from the same " +
      "program, and the last step's experiment is switched off. The demo repository's page runs it live.";
  }
  const regions = regionsOf(run, constants);
  const frames = [{ kind: "start", bytes: run.afterInstantiation, sp: run.initialStackPointer }, ...run.events];
  const report = frames[frames.length - 1];

  // Step 3: the program running, one host call per frame.
  const player = { index: 0, timer: null };
  const drawRunning = () => {
    const frame = frames[player.index];
    const seen = frame.kind === "sample" ? frame.index : frame.kind === "report" ? readings.length : 0;
    const counted = frame.kind === "sample" && frame.index > 0 ? bandOf(readings[frame.index - 1]) : frame.kind === "report"
      ? bandOf(readings[readings.length - 1]) : -1;
    $("ticker").innerHTML =
      frame.kind === "start" ? "Ready. <small>Press Play to hand the program its 24 readings.</small>"
      : frame.kind === "count" ? `The program asks how many readings there are: ${frame.value}. <small>It sets up its counters, all zero.</small>`
      : frame.kind === "sample" ? `Reading ${frame.index + 1} of ${readings.length}: ${frame.value} °C` +
        (frame.index > 0 ? ` <small>The previous one (${readings[frame.index - 1]} °C) went into ${BANDS[counted]}.</small>` : "")
      : `All ${readings.length} readings counted. <small>Next: how the results come back.</small>`;
    [...$("readings").children].forEach((bar, i) => {
      const handed = frame.kind === "sample" ? i <= frame.index : frame.kind === "report";
      bar.style.height = handed ? `${6 + (readings[i] / 40) * 32}px` : "3px";
      bar.className = frame.kind === "sample" && i === frame.index ? "cur" : handed ? "on" : "";
    });
    $("strip-running").innerHTML = stripHTML(frame, regions, { focus: ["counters"], hot: counted });
    $("raw-running").innerHTML = rawHTML(frame, regions);
    $("play").textContent = player.timer ? "Pause" : player.index === frames.length - 1 ? "Play again" : "Play";
  };
  const pause = () => { clearInterval(player.timer); player.timer = null; drawRunning(); };
  const play = () => {
    if (player.index === frames.length - 1) player.index = 0;
    clearInterval(player.timer);
    player.timer = setInterval(() => {
      if (player.index >= frames.length - 1) return pause();
      player.index += 1;
      drawRunning();
    }, 650);
    drawRunning();
  };
  $("readings").innerHTML = readings.map(() => "<span></span>").join("");
  $("play").onclick = () => (player.timer ? pause() : play());
  $("restart").onclick = () => { player.index = 0; play(); };

  // Step 4: the results, read where the program put them.
  $("callout").innerHTML = `The program calls <code>report(${fmt(report.statsAddress)}, ${fmt(report.histogramAddress)})</code>` +
    `<span>"my results start at byte ${fmt(report.statsAddress)}, my counters at byte ${fmt(report.histogramAddress)}"</span>`;
  $("strip-results").innerHTML = stripHTML(report, regions, { focus: ["results", "counters"] });
  $("raw-results").innerHTML = rawHTML(report, regions);
  const agrees = JSON.stringify(report.stats) === JSON.stringify(expected.stats) &&
    JSON.stringify(report.histogram) === JSON.stringify(expected.histogram);
  $("check").innerHTML = agrees
    ? `<span class="ok">These match this page's own arithmetic over the same ${readings.length} readings.</span>`
    : `<span class="bad">These do not match this page's own arithmetic.</span>`;

  // Step 5: the page grows the memory while the program runs.
  const growAt = Array.from({ length: limits.maximum - limits.minimum }, (_, k) =>
    Math.round(((k + 1) * readings.length) / (limits.maximum - limits.minimum + 1)));
  const grown = recorded?.growing
    ? recordedRun(recorded.growing)
    : recorded ? null : await runDemo(wasm, readings, { initial: limits.minimum, maximum: limits.maximum }, { growAt, tryPastLimit: true });
  $("grow-lede").innerHTML = "The program never grows its memory itself: Inference has no heap. But it was built to allow up to " +
    `${amount(limits.maximum, "page")} (<code>max-pages = ${limits.maximum}</code>), and the memory belongs to the page, so the ` +
    `page can add pages whenever it needs more room for its own data. Here it starts with ${amount(limits.minimum, "page")} and ` +
    `adds one every ${growAt[0]} readings, while the program keeps counting.`;
  const growFrames = grown
    ? [{ kind: "start", bytes: grown.afterInstantiation, sp: grown.initialStackPointer, pages: grown.startPages },
      ...grown.events, { kind: "limit", bytes: grown.events.at(-1).bytes, sp: grown.events.at(-1).sp, pages: grown.pages }]
    : null;
  const grower = { index: 0, timer: null };
  const drawGrowing = () => {
    if (!growFrames) return;
    const frame = growFrames[grower.index];
    const counted = frame.kind === "sample" && frame.index > 0 ? bandOf(readings[frame.index - 1])
      : frame.kind === "report" ? bandOf(readings[readings.length - 1]) : -1;
    $("grow-ticker").innerHTML =
      frame.kind === "start" ? `Ready. <small>The memory starts with ${amount(frame.pages, "page")}; the program allows up to ${limits.maximum}.</small>`
      : frame.kind === "count" ? `The program asks how many readings there are: ${frame.value}. <small>Memory: ${amount(frame.pages, "page")}.</small>`
      : frame.kind === "sample" && frame.grew ? `Reading ${frame.index + 1}: the page grows the memory to ${amount(frame.grew, "page")}. ` +
        `<small>It writes its own data into page ${frame.grew}; the program doesn't notice.</small>`
      : frame.kind === "sample" ? `Reading ${frame.index + 1} of ${readings.length}: ${frame.value} °C <small>Memory: ${amount(frame.pages, "page")}.</small>`
      : frame.kind === "report" ? `All ${readings.length} readings counted, in ${amount(frame.pages, "page")} of memory. ` +
        "<small>Now the page asks for one more page…</small>"
      : `The page asks for page ${limits.maximum + 1}, and the browser refuses.`;
    const blocks = [];
    for (let page = 1; page <= limits.maximum + 1; page += 1) {
      if (page === 1) blocks.push(`<div class="pg program"><b>page 1</b>the program's</div>`);
      else if (page > limits.maximum) {
        const tried = frame.kind === "limit";
        blocks.push(`<div class="pg past${tried ? " tried" : ""}"><b>page ${page}</b>${tried ? "refused" : "past the limit"}</div>`);
      } else if (page <= frame.pages) {
        blocks.push(`<div class="pg hosts${frame.grew === page ? " new" : ""}"><b>page ${page}</b>added by this page</div>`);
      } else blocks.push(`<div class="pg room"><b>page ${page}</b>room to grow</div>`);
    }
    $("grow-pages").innerHTML = blocks.join("");
    $("grow-counters").innerHTML = countersCellHTML(frame, regions, counted);
    const limitShown = frame.kind === "limit";
    $("grow-limit").hidden = !limitShown;
    if (limitShown && grown.pastLimit) {
      $("grow-limit").innerHTML = `<b>Refused: the memory can't grow past ${amount(limits.maximum, "page")}.</b>` +
        "That is the maximum the program declared, and the browser enforces it whoever asks. " +
        (grown.host ? `Pages 2–${grown.pages} still hold exactly what this page wrote; the program never touched them.` : "") +
        `<span class="says">The browser says: ${grown.pastLimit.message}</span>`;
    }
    $("grow-play").textContent = grower.timer ? "Pause" : grower.index === growFrames.length - 1 ? "Play again" : "Play";
  };
  const growPause = () => { clearInterval(grower.timer); grower.timer = null; drawGrowing(); };
  const growPlay = () => {
    if (!growFrames) return;
    if (grower.index === growFrames.length - 1) grower.index = 0;
    clearInterval(grower.timer);
    grower.timer = setInterval(() => {
      if (grower.index >= growFrames.length - 1) return growPause();
      grower.index += 1;
      drawGrowing();
    }, 650);
    drawGrowing();
  };
  $("grow-play").onclick = () => (grower.timer ? growPause() : growPlay());
  $("grow-restart").onclick = () => { grower.index = 0; growPlay(); };
  if (!growFrames) {
    $("grow-ticker").textContent = "This viewer can't run WebAssembly, so this step needs the demo repository's page.";
    $("grow-play").disabled = true;
    $("grow-restart").disabled = true;
  }

  // Step 6: the experiment.
  $("rules").innerHTML = `The program was built to need at least ${amount(limits.minimum, "page")} of 64 KiB, and to never ` +
    `grow past ${amount(limits.maximum, "page")} (<code>max-pages = ${limits.maximum}</code>). Hand it a memory and see what it does.`;
  $("pages").innerHTML = Array.from({ length: 7 }, (_, n) => `<option value="${n}">${amount(n, "page")}</option>`).join("");
  $("limit").innerHTML = `<option value="none">no limit</option>` +
    Array.from({ length: 6 }, (_, n) => `<option value="${n + 1}">${amount(n + 1, "page")}</option>`).join("");
  const chosen = () => ({ initial: Number($("pages").value),
    ...($("limit").value === "none" ? {} : { maximum: Number($("limit").value) }) });
  const choose = (d) => { $("pages").value = String(d.initial); $("limit").value = d.maximum === undefined ? "none" : String(d.maximum); };
  const drawPages = (d, untouched) => {
    const total = Math.max(d.initial, d.maximum ?? d.initial);
    $("pagesbar").innerHTML = Array.from({ length: total }, (_, k) => {
      const page = k + 1;
      if (page === 1) return `<div class="pg program"><b>page 1</b>the program's</div>`;
      if (page <= d.initial) return `<div class="pg hosts"><b>page ${page}</b>this page's own${untouched ? ", untouched" : ""}</div>`;
      return `<div class="pg room"><b>page ${page}</b>room to grow</div>`;
    }).join("");
  };
  const start = async () => {
    const d = chosen();
    const verdict = judgeMemory(d, limits);
    const engine = await tryMemory(wasm, d);
    if (!engine.accepted) {
      $("outcome").className = "outcome bad";
      $("outcome").innerHTML = `<b>Refused. The program never started.</b>` +
        (verdict.accepted ? "This page expected it to be accepted." : verdict.reason) +
        `<span class="says">The browser says: ${engine.message.replace(/^(LinkError|RangeError|TypeError): (WebAssembly\.\w+\(\): )?/, "")}</span>`;
      $("pagesbar").innerHTML = "";
      return;
    }
    const tried = await runDemo(wasm, readings, d);
    const [count, min, max] = tried.events.find((e) => e.kind === "report").stats;
    const stayed = tried.host
      ? ` It stayed inside page 1: ${tried.pages > 2 ? `pages 2–${tried.pages} are` : "page 2 is"} ${tried.host.untouched ? "exactly as this page left them" : "CHANGED"}.`
      : "";
    $("outcome").className = "outcome good";
    $("outcome").innerHTML = `<b>Accepted. The program ran in this memory.</b>` +
      `It counted all ${count} readings (lowest ${min} °C, highest ${max} °C).${stayed}` +
      `<span class="says">${describe(d)}</span>`;
    drawPages(d, tried.host?.untouched);
  };
  const preview = () => {
    const verdict = judgeMemory(chosen(), limits);
    $("outcome").className = "outcome";
    $("outcome").innerHTML = `<b>${verdict.accepted ? "This memory should be accepted." : "This memory should be refused."}</b>` +
      `${verdict.reason}<span class="says">${describe(chosen())}</span>`;
    $("pagesbar").innerHTML = "";
  };
  $("pages").onchange = preview;
  $("limit").onchange = preview;
  $("start").onclick = start;
  $("presets").innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.label}</button>`).join("");
  $("presets").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    choose(PRESETS[Number(button.dataset.i)].descriptor);
    start();
  });
  choose(DEFAULT_MEMORY);
  preview();
  if (recorded) {
    for (const id of ["pages", "limit", "start"]) $(id).disabled = true;
    $("presets").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    $("outcome").innerHTML = "<b>Switched off in this viewer.</b>It needs to run the program, and this viewer blocks WebAssembly.";
  }

  // Navigation.
  const sections = STEPS.map((id) => $(id));
  $("progress").innerHTML = sections.map((section, i) =>
    `<li><button data-i="${i}"><b>Step ${i + 1}</b><span>${section.dataset.name}</span></button></li>`).join("");
  let current = 0;
  const go = (i, { autoplay = true } = {}) => {
    current = Math.max(0, Math.min(STEPS.length - 1, i));
    sections.forEach((section, k) => { section.hidden = k !== current; });
    $("progress").querySelectorAll("button").forEach((button, k) => {
      button.classList.toggle("done", k < current);
      if (k === current) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    $("where").textContent = `Step ${current + 1} of ${STEPS.length}: ${sections[current].dataset.name}`;
    $("back").disabled = current === 0;
    $("next").disabled = current === STEPS.length - 1;
    if (STEPS[current] === "running") {
      if (autoplay && player.index === 0 && !player.timer) play();
      else drawRunning();
    } else if (player.timer) {
      pause();
    }
    if (STEPS[current] === "growing") {
      if (autoplay && grower.index === 0 && !grower.timer) growPlay();
      else drawGrowing();
    } else if (grower.timer) {
      growPause();
    }
    try { history.replaceState(null, "", `#${STEPS[current]}`); } catch { /* not allowed in every viewer */ }
  };
  $("progress").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (button) go(Number(button.dataset.i));
  });
  $("back").onclick = () => go(current - 1);
  $("next").onclick = () => go(current + 1);
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("select, input, textarea")) return;
    if (e.key === "ArrowRight") go(current + 1);
    if (e.key === "ArrowLeft") go(current - 1);
  });

  const opening = Math.max(0, STEPS.indexOf(hashStep));
  if (hashStep === "running" && hashArgs.length) {
    document.body.classList.add("static");
    player.index = Math.min(frames.length - 1, Number(hashArgs[0]));
    go(opening, { autoplay: false });
  } else if (hashStep === "growing" && hashArgs.length && growFrames) {
    document.body.classList.add("static");
    grower.index = Math.min(growFrames.length - 1, Number(hashArgs[0]));
    go(opening, { autoplay: false });
  } else {
    go(opening);
  }
  if (hashStep === "try" && hashArgs.length === 2 && !recorded) {
    choose({ initial: Number(hashArgs[0]), ...(hashArgs[1] === "none" ? {} : { maximum: Number(hashArgs[1]) }) });
    await start();
  }
}

main().catch((error) => {
  const stage = document.querySelector(".stage");
  stage.innerHTML = `<h2>Could not run the demo</h2><p class="lede">${String(error)}</p>`;
});
