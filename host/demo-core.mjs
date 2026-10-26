// The host side of the demo, shared by the terminal host (host/run.mjs) and
// the browser page (web/index.html). It creates the memory, instantiates the
// Inference module against it, and records what happens on every host call so
// either front end can replay it.

/** The memory the module's import asks for: one fixed 64 KiB page. */
export const MEMORY = Object.freeze({ initial: 1, maximum: 1 });

/** Bytes in one WebAssembly page. */
export const PAGE_BYTES = 65536;

/** The window of the page the zoomed views show: its top 256 bytes. */
export const ZOOM_START = PAGE_BYTES - 256;

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

/**
 * Creates the memory, instantiates the module against it, runs `main`, and
 * returns the memory, the result, and a trace with one event per host call.
 * Each event carries the module's stack pointer at that moment and a copy of
 * the zoomed window of the host's memory.
 */
export async function runDemo(wasmBytes, readings) {
  const memory = new WebAssembly.Memory(MEMORY);
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
  return {
    memory,
    result,
    events,
    initialStackPointer,
    afterInstantiation,
    sameMemoryExported: instance.exports.memory === memory,
  };
}

/**
 * Memories the import does not admit, each paired with why. Instantiating
 * against any of them is refused by the engine before the module runs.
 */
export const WRONG_MEMORIES = Object.freeze([
  { label: "no maximum", descriptor: { initial: 1 } },
  { label: "a larger maximum", descriptor: { initial: 1, maximum: 2 } },
  { label: "too few pages", descriptor: { initial: 0, maximum: 1 } },
  { label: "a function instead of a memory", descriptor: null },
]);

/** Tries each wrong memory and returns the engine's refusal for each. */
export async function tryWrongMemories(wasmBytes) {
  const noop = () => 0;
  const outcomes = [];
  for (const { label, descriptor } of WRONG_MEMORIES) {
    const memory = descriptor ? new WebAssembly.Memory(descriptor) : noop;
    try {
      await WebAssembly.instantiate(wasmBytes, {
        env: { memory },
        sensor: { sample_count: noop, sample: noop, report: noop },
      });
      outcomes.push({ label, descriptor, refused: false, message: "instantiated" });
    } catch (error) {
      outcomes.push({ label, descriptor, refused: true, message: `${error.name}: ${error.message}` });
    }
  }
  return outcomes;
}

/** The address of the module's constant table, read off its data segment. */
export function dataSegment(wasmBytes) {
  const b = wasmBytes;
  const leb = (i, signed = false) => {
    let result = 0, shift = 0, byte;
    do {
      byte = b[i++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    if (signed && shift < 32 && (byte & 0x40)) result |= -1 << shift;
    return [result, i];
  };
  let i = 8;
  while (i < b.length) {
    const id = b[i++];
    let size;
    [size, i] = leb(i);
    if (id === 11) {
      let j = i, count, flags, offset, length;
      [count, j] = leb(j);
      [flags, j] = leb(j);
      j += 1; // i32.const
      [offset, j] = leb(j, true);
      j += 1; // end
      [length, j] = leb(j);
      return { offset, length };
    }
    i += size;
  }
  return null;
}
