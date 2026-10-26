# Inference: a module running in a memory the host owns

A small showcase of `[memory] import = true`. The Inference program in
`src/main.inf` does not define its linear memory: it imports it as
`env.memory`, so the host creates the memory before the module exists, hands
it in at instantiation, and can watch everything the module keeps there.

![The browser view at the report step](docs/browser-report-step.png)

## What it shows

1. **The host creates the memory.** `new WebAssembly.Memory({ initial: 1, maximum: 1 })`
   exists before the module does. Instantiation writes the module's constant
   table (`BANDS = [10, 20, 30]`) into it, at the top of the page.
2. **The module computes in it.** `main` carves its stack frame out of the
   host's memory and keeps a histogram array there. The host feeds 24 readings
   through `sample(i)` and can see the histogram's bytes change in its own
   buffer after every call.
3. **Results are read in place.** `report(stats, histogram)` hands the host two
   addresses inside its memory. The host reads both arrays directly, with no
   copy and no lookup of the module's exports, and checks them against its own
   arithmetic.
4. **The import is a contract.** The module asks for `(memory 1 1)`. Offer it
   a memory with no maximum, a larger maximum, too few pages, or something that
   is not a memory, and the engine refuses to instantiate it. A host can never
   give the module more memory than its stack and overflow checks were laid
   out for.

## Run it

Needs an `infs` and `infc` with compiler ABI 1.11 or newer (the release that
ships `[memory] import`), and Node.js 18 or newer.

```bash
infs build                  # writes out/main.wasm
node host/run.mjs           # terminal animation of the run
node scripts/bundle.mjs     # writes dist/sensor-demo.html
```

Open `dist/sensor-demo.html` in a browser: it is self-contained and needs no
server. To work on the page itself, serve the project root
(`python3 -m http.server`) and open `/web/`, which loads `out/main.wasm`
directly.

`node host/run.mjs --plain` prints the same run as a plain log and exits 1 if
the program's report disagrees with the host's arithmetic, so it doubles as a
test. In the browser, each step is captioned in plain words, and the memory view
shows only the three rows the program uses, each decoded into the numbers it
holds; "Show all 256 bytes" expands it. `#step=N` opens the replay paused at
step N, `&all` starts with every byte shown, and `&offers` tries every memory in
the contract panel.

## What the build says

```text
memory: 1 page(s), maximum 1, 65536-byte stack, imported from env.memory
host-imports allowlist: sensor.report, sensor.sample, sensor.sample_count
```

The module's first import is `(import "env" "memory" (memory 1 1))`, it has no
memory section of its own, and its `memory` export is the host's object
(`instance.exports.memory === memory`).

The same project refuses the builds that cannot carry an imported memory:
`infs build -v` (no proof artifact for a module that imports its memory) and
`target = "stellar"` (a Soroban contract defines its own memory).

## The embedder contract

The module owns the first `pages` pages of the memory it is given: its shadow
stack sits at the bottom and its constants directly above it. A host may read
them, as this one does, but writes into them only through a `mut` argument
during a call to one of its own functions. See *Importing the memory* in the
Inference book for the full contract.

## Files

| Path | What it is |
|---|---|
| `src/main.inf` | The Inference program |
| `Inference.toml` | `[memory] import = true` and the host-import allowlist |
| `host/demo-core.mjs` | Creates the memory, runs the module, records every host call |
| `host/run.mjs` | Terminal host and animation |
| `web/index.html`, `web/app.mjs` | Browser view of the same run |
| `scripts/bundle.mjs` | Inlines the page into `dist/sensor-demo.html` |

The build line reports the requested 65536-byte stack, while the module's
actual stack is 65520 bytes, because its 12 bytes of constants sit at the top
of the one page. That is a known `infs` reporting issue (Inferara/inference#549).

## License

Apache-2.0; see [LICENSE](LICENSE).
