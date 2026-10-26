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

/**
 * Creates `descriptor`'s memory, writes the host's marker into page 2 if
 * there is one, instantiates the module against it, runs `main`, and returns
 * the result and a trace with one event per host call. Each event carries
 * the module's stack pointer at that moment and a copy of the top 256 bytes
 * of the first page.
 */
export async function runDemo(wasmBytes, readings, descriptor = DEFAULT_MEMORY) {
  const memory = new WebAssembly.Memory(descriptor);
  const pages = memory.buffer.byteLength / PAGE_BYTES;
  const hostArea = () => new Uint8Array(memory.buffer.slice(PAGE_BYTES));
  if (pages > 1) new Uint8Array(memory.buffer).set(new TextEncoder().encode(HOST_MARKER), PAGE_BYTES);
  const hostBefore = hostArea();
  const events = [];
  let instance;

  const snapshot = () => new Uint8Array(memory.buffer.slice(ZOOM_START, PAGE_BYTES));
  const stackPointer = () => instance.exports.__stack_pointer.value;
  const ints = (address, count) => Array.from(new Int32Array(memory.buffer, address, count));

  const imports = {
    env: { memory },
    sensor: {
      sample_count: () => {
        events.push({ kind: "count", value: readings.length, sp: stackPointer(), bytes: snapshot() });
        return readings.length;
      },
      sample: (i) => {
        const value = readings[i];
        events.push({ kind: "sample", index: i, value, sp: stackPointer(), bytes: snapshot() });
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
          bytes: snapshot(),
        });
      },
    },
  };

  ({ instance } = await WebAssembly.instantiate(wasmBytes, imports));
  const initialStackPointer = instance.exports.__stack_pointer.value;
  const afterInstantiation = snapshot();
  const result = instance.exports.main();
  const hostAfter = hostArea();
  return {
    memory,
    descriptor: { ...descriptor },
    pages,
    result,
    events,
    initialStackPointer,
    afterInstantiation,
    sameMemoryExported: instance.exports.memory === memory,
    host: pages > 1
      ? {
        bytes: hostAfter.slice(0, 16),
        untouched: hostBefore.length === hostAfter.length && hostBefore.every((byte, i) => byte === hostAfter[i]),
        size: hostAfter.length,
      }
      : null,
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
