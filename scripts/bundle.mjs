#!/usr/bin/env node
// Writes dist/sensor-demo.html: web/index.html with the demo's scripts and the
// compiled module inlined, so it opens straight from disk with no server.
//
//   infs build && node scripts/bundle.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path) => readFileSync(root(path), "utf8");

const wasm = readFileSync(root("out/main.wasm")).toString("base64");
const core = read("host/demo-core.mjs").replace(/^export /gm, "");
const app = read("web/app.mjs")
  .replace(/^import \{[\s\S]*?\} from "\.\.\/host\/demo-core\.mjs"; \/\/ @bundle-strip\n/m, "");
if (app.includes("demo-core.mjs\"; // @bundle-strip")) throw new Error("import line not stripped");

const tag = '<script type="module" src="./app.mjs"></script>';
const html = read("web/index.html");
if (!html.includes(tag)) throw new Error("script tag not found in web/index.html");
const inlined = html.replace(tag, () => [
  `<script>globalThis.DEMO_WASM_BASE64 = "${wasm}";</script>`,
  `<script type="module">\n${core}\n${app}\n</script>`,
].join("\n"));

mkdirSync(root("dist"), { recursive: true });
writeFileSync(root("dist/sensor-demo.html"), inlined);
console.log(`dist/sensor-demo.html (${inlined.length.toLocaleString("en-US")} bytes, module inlined)`);
