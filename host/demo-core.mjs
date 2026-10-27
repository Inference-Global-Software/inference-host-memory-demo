// The host side of the demo, shared by the terminal host (host/run.mjs) and
// the browser page (web/index.html). It creates the memory, instantiates the
// Inference module against it, and records what happens on every host call so
// either front end can replay it.

/** Bytes in one WebAssembly page. */
export const PAGE_BYTES = 65536;

/** The window the zoomed views show: the top 256 bytes of the first page. */
export const ZOOM_START = PAGE_BYTES - 256;

/** The memory handed over unless told otherwise: two pages, room to grow to four. */
export const DEFAULT_MEMORY = Object.freeze({ initial: 2, maximum: 4 });

/**
 * What the host writes at the start of its own page, page 2, before the run.
 * The program never writes above its first page, so it is still there after.
 */
export const HOST_MARKER = "HOST-OWNED PAGE!";

/**
 * Deterministic "temperature" readings in 0..40 °C: a slow warm-up with some
 * noise, so the run is the same every time and covers every band.
 */
export function makeReadings(count = 24, seed = 7) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, (_, i) => {
    const trend = 6 + (i / (count - 1)) * 28;
    return Math.max(0, Math.min(40, Math.round(trend + (next() - 0.5) * 12)));
  });
}

/** What the program should report, computed independently of it. */
export function expectedReport(readings) {
  const bands = [0, 0, 0, 0];
  for (const v of readings) bands[v >= 30 ? 3 : v >= 20 ? 2 : v >= 10 ? 1 : 0] += 1;
  return {
    stats: [readings.length, Math.min(...readings), Math.max(...readings),
      readings.reduce((a, b) => a + b, 0)],
    histogram: bands,
  };
}

/** Reads unsigned LEB128 (or signed, for an `i32.const`) at `i`: `[value, next]`. */
function leb(bytes, i, signed = false) {
  let result = 0, shift = 0, byte;
  do {
    byte = bytes[i++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  if (signed && shift < 32 && (byte & 0x40)) result |= -1 << shift;
  return [result, i];
}

/** The payload of section `id`, or null. */
function section(bytes, id) {
  let i = 8;
  while (i < bytes.length) {
    const sectionId = bytes[i++];
    let size;
    [size, i] = leb(bytes, i);
    if (sectionId === id) return [i, i + size];
    i += size;
  }
  return null;
}

/**
 * The limits the module's `env.memory` import declares, read off its bytes:
 * the fewest pages a host may hand over, and the largest limit it may set.
 */
export function memoryImport(wasmBytes) {
  const b = wasmBytes;
  const found = section(b, 2);
  if (!found) return null;
  let [i] = found;
  let count;
  [count, i] = leb(b, i);
  const name = () => {
    let length;
    [length, i] = leb(b, i);
    const text = new TextDecoder().decode(b.subarray(i, i + length));
    i += length;
    return text;
  };
  for (let n = 0; n < count; n += 1) {
    const module = name();
    const field = name();
    const kind = b[i++];
    if (kind === 2) {
      const flags = b[i++];
      let minimum, maximum = null;
      [minimum, i] = leb(b, i);
      if (flags & 1) [maximum, i] = leb(b, i);
      if (module === "env" && field === "memory") return { minimum, maximum };
    } else {
      let ignored;
      [ignored, i] = leb(b, i); // a function import's type index
    }
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Whether the module would accept `descriptor` (a `WebAssembly.Memory`
 * descriptor, or null for "a function instead"), and why, in plain words.
 * `limits` is what `memoryImport` read off the module.
 */
export function judgeMemory(descriptor, limits) {
  const { minimum, maximum } = limits;
  if (!descriptor) {
    return { accepted: false, reason: "That is a function, not a memory. The program needs memory to keep its stack and constants in." };
  }
  const { initial, maximum: limit } = descriptor;
  if (limit !== undefined && initial > limit) {
    return { accepted: false, browserOnly: true,
      reason: `A memory can't start bigger than its own limit: ${plural(initial, "page")} with a limit of ${limit}. The browser won't even create it.` };
  }
  if (limit === undefined) {
    return { accepted: false,
      reason: "With no limit, this memory could keep growing until it fills the 4 GiB address space, and the program's " +
        "stack-overflow trap depends on that space ending first. So the program insists on a limit, and refuses a memory without one." };
  }
  if (limit > maximum) {
    return { accepted: false,
      reason: `This memory could grow to ${plural(limit, "page")}, past the ${maximum} the program was built to allow ` +
        `(max-pages = ${maximum}). Its safety checks were measured against that ceiling, so a memory that could outgrow it is refused.` };
  }
  if (initial < minimum) {
    return { accepted: false,
      reason: `${plural(initial, "page")} is less than the ${plural(minimum, "page")} the program asks for. Its stack and ` +
        "constants live in that first page, so it can't start without it." };
  }
  const extra = initial > 2 ? ` Pages 2–${initial} are this page's own: the program never touches them.`
    : initial === 2 ? " Page 2 is this page's own: the program never touches it." : "";
  const growth = limit > initial ? ` It may grow to ${plural(limit, "page")} later.` : "";
  return { accepted: true, reason: `Accepted: at least ${plural(minimum, "page")}, with a limit of at most ${maximum}.${extra}${growth}` };
}

/** The marker the host writes at the start of each of its pages: page 2 gets `HOST_MARKER`. */
export function hostMarker(page) {
  return page === 2 ? HOST_MARKER : `HOST PAGE ${page}`.padEnd(16, ".");
}

/**
 * Creates `descriptor`'s memory, writes the host's marker into each page above
 * the first, instantiates the module against it, runs `main`, and returns the
 * result and a trace with one event per host call. Each event carries the
 * module's stack pointer at that moment, the memory's size in pages, and a copy
 * of the top 256 bytes of the first page.
 *
 * `growAt` lists the `sample(i)` calls during which the host grows the memory
 * by one page (and marks the new page), as a host needing more room for its
 * own data would; the program itself never grows memory. With `tryPastLimit`
 * the host asks for one page more once the run is over, and the engine's
 * answer is returned as `pastLimit`.
 */
export async function runDemo(wasmBytes, readings, descriptor = DEFAULT_MEMORY, { growAt = [], tryPastLimit = false } = {}) {
  const memory = new WebAssembly.Memory(descriptor);
  const pagesNow = () => memory.buffer.byteLength / PAGE_BYTES;
  const startPages = pagesNow();
  // What the host has written above page 1, to compare against after the run.
  const writes = [];
  const mark = (page) => {
    const bytes = new TextEncoder().encode(hostMarker(page));
    new Uint8Array(memory.buffer).set(bytes, (page - 1) * PAGE_BYTES);
    writes.push({ offset: (page - 2) * PAGE_BYTES, bytes });
  };
  for (let page = 2; page <= startPages; page += 1) mark(page);
  const events = [];
  let instance;

  // `memory.buffer` is read afresh every time: growing the memory detaches the
  // old buffer, and a view kept from before would read as empty.
  const snapshot = () => new Uint8Array(memory.buffer.slice(ZOOM_START, PAGE_BYTES));
  const stackPointer = () => instance.exports.__stack_pointer.value;
  const ints = (address, count) => Array.from(new Int32Array(memory.buffer, address, count));

  const imports = {
    env: { memory },
    sensor: {
      sample_count: () => {
        events.push({ kind: "count", value: readings.length, sp: stackPointer(), pages: pagesNow(), bytes: snapshot() });
        return readings.length;
      },
      sample: (i) => {
        let grew = null;
        if (growAt.includes(i)) {
          memory.grow(1);
          grew = pagesNow();
          mark(grew);
        }
        const value = readings[i];
        events.push({ kind: "sample", index: i, value, grew, sp: stackPointer(), pages: pagesNow(), bytes: snapshot() });
        return value;
      },
      // Both arrays arrive as addresses inside the host's own memory, and the
      // host reads them in place.
      report: (statsAddress, histogramAddress) => {
        events.push({
          kind: "report",
          statsAddress,
          histogramAddress,
          stats: ints(statsAddress, 4),
          histogram: ints(histogramAddress, 4),
          sp: stackPointer(),
          pages: pagesNow(),
          bytes: snapshot(),
        });
      },
    },
  };

  ({ instance } = await WebAssembly.instantiate(wasmBytes, imports));
  const initialStackPointer = instance.exports.__stack_pointer.value;
  const afterInstantiation = snapshot();
  const result = instance.exports.main();
  const pages = pagesNow();
  const hostAfter = new Uint8Array(memory.buffer.slice(PAGE_BYTES));
  const expected = new Uint8Array(hostAfter.length);
  for (const { offset, bytes } of writes) expected.set(bytes, offset);
  let pastLimit = null;
  if (tryPastLimit) {
    try {
      memory.grow(1);
      pastLimit = { refused: false, message: `grew to ${pagesNow()} pages` };
    } catch (error) {
      pastLimit = { refused: true, message: `${error.name}: ${error.message}` };
    }
  }
  return {
    memory,
    descriptor: { ...descriptor },
    startPages,
    pages,
    result,
    events,
    initialStackPointer,
    afterInstantiation,
    sameMemoryExported: instance.exports.memory === memory,
    host: pages > 1
      ? {
        bytes: hostAfter.slice(0, 16),
        untouched: expected.every((byte, i) => byte === hostAfter[i]),
        size: hostAfter.length,
      }
      : null,
    pastLimit,
  };
}

/** Tries to instantiate the module against `descriptor` (null: a function). */
export async function tryMemory(wasmBytes, descriptor) {
  const noop = () => 0;
  try {
    const memory = descriptor ? new WebAssembly.Memory(descriptor) : noop;
    await WebAssembly.instantiate(wasmBytes, {
      env: { memory },
      sensor: { sample_count: noop, sample: noop, report: noop },
    });
    return { accepted: true, message: "instantiated" };
  } catch (error) {
    return { accepted: false, message: `${error.name}: ${error.message}` };
  }
}

/**
 * Memories the module's `(memory 1 4)` import does not admit, each paired
 * with why. Instantiating against any of them is refused before it runs.
 */
export const WRONG_MEMORIES = Object.freeze([
  { label: "no limit", descriptor: { initial: 1 } },
  { label: "a limit past four pages", descriptor: { initial: 1, maximum: 5 } },
  { label: "no pages", descriptor: { initial: 0, maximum: 4 } },
  { label: "a function instead of a memory", descriptor: null },
]);

/** Tries each wrong memory and returns the engine's refusal for each. */
export async function tryWrongMemories(wasmBytes) {
  const outcomes = [];
  for (const { label, descriptor } of WRONG_MEMORIES) {
    const { accepted, message } = await tryMemory(wasmBytes, descriptor);
    outcomes.push({ label, descriptor, refused: !accepted, message });
  }
  return outcomes;
}

/** The address and length of the module's constant table, off its data segment. */
export function dataSegment(wasmBytes) {
  const found = section(wasmBytes, 11);
  if (!found) return null;
  let [j] = found;
  let count, flags, offset, length;
  [count, j] = leb(wasmBytes, j);
  [flags, j] = leb(wasmBytes, j);
  j += 1; // i32.const
  [offset, j] = leb(wasmBytes, j, true);
  j += 1; // end
  [length, j] = leb(wasmBytes, j);
  return { offset, length };
}

/** Where the firmware (host/firmware.wat) keeps its data, all in page 2. */
export const FIRMWARE = Object.freeze({
  count: 65536, readings: 65540, results: 66048, counters: 66064, answered: 66080, addresses: 66084,
});

/**
 * Runs the Inference module embedded in the firmware's memory: one memory,
 * the firmware instantiated in it first, then the module with the firmware's
 * own exports as its `sensor` imports, so every call between the two goes
 * straight from one program to the other. This function only creates the
 * memory, loads both programs and calls `main`; it reads the outcome back
 * afterwards.
 */
export async function runEmbedded(inferenceBytes, firmwareBytes, descriptor = { initial: 2, maximum: 4 }) {
  const memory = new WebAssembly.Memory(descriptor);
  const { instance: firmware } = await WebAssembly.instantiate(firmwareBytes, { env: { memory } });
  const { instance: program } = await WebAssembly.instantiate(inferenceBytes, {
    env: { memory },
    sensor: firmware.exports,
  });
  const result = program.exports.main();
  const view = (address, count) => Array.from(new Int32Array(memory.buffer, address, count));
  const count = view(FIRMWARE.count, 1)[0];
  const [statsAddress, histogramAddress] = view(FIRMWARE.addresses, 2);
  return {
    descriptor: { ...descriptor },
    pages: memory.buffer.byteLength / PAGE_BYTES,
    result,
    firmware: {
      readings: view(FIRMWARE.readings, count),
      answered: view(FIRMWARE.answered, 1)[0],
      statsAddress,
      histogramAddress,
      copiedStats: view(FIRMWARE.results, 4),
      copiedHistogram: view(FIRMWARE.counters, 4),
    },
    program: { stats: view(statsAddress, 4), histogram: view(histogramAddress, 4) },
    pageOneTop: new Uint8Array(memory.buffer.slice(ZOOM_START, PAGE_BYTES)),
  };
}
