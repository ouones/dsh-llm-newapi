#!/usr/bin/env node
/**
 * Bundle the compiled client CommonJS modules into the single `lib/client.js`
 * the DSH Web shell loads through `window.__ModuleLoader__.load`.
 *
 * The compiled modules (from `tsc -p tsconfig.client.json`, written to
 * `lib/types/client/`) are assembled into a `__modules` table exactly as the
 * shipped @deepseek-ai client bundles do: relative imports resolve within the
 * table; every other `require(id)` defers to the factory's own `require`, which
 * the shared module ledger resolves against the already-loaded client packages
 * (react, @deepseek-ai/dsh-client-ui-primitives, …). So nothing is bundled; the
 * table just carries this package's own source.
 *
 * @module dsh-llm-newapi/build-client
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const compiledDir = join(root, 'lib', 'types', 'client')
const outFile = join(root, 'lib', 'client.js')

// Modules this package ships, keyed by the common base name they are compiled
// from. Single-entry packages put everything in ./index.js; anything else keeps
// its own module key. Rebuild source-to-key consistently with `tsc` outputs.
const entries = ['index.js']

function buildTable() {
  const moduleLines = []
  for (const name of entries) {
    const file = join(compiledDir, name)
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`missing compiled client module ${file}; run tsc -p tsconfig.client.json first: ${error.message}`)
    }
    moduleLines.push(`__modules["./${name}"] = function(module, exports, require, __load_) {\n${source}\n};`)
  }
  return moduleLines.join('\n')
}

const table = buildTable()
const bundle = `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-llm-newapi", factory: (require) => {
var __modules = Object.create(null); var __cache = Object.create(null);
${table}
function __resolve(from, request) {
  if (!request.startsWith(".")) return request;
  var parts = from.slice(2).split("/"); parts.pop();
  for (var part of request.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return "./" + parts.join("/");
}
function __load(id) {
  if (__modules[id] === undefined) return require(id);
  if (__cache[id] !== undefined) return __cache[id].exports;
  var module = __cache[id] = { exports: {} };
  __modules[id](module, module.exports, require, function(request) {
    var resolved = __resolve(id, request);
    return __modules[resolved] === undefined ? require(request) : __load(resolved);
  });
  return module.exports;
}
return __load("./index.js"); } });
`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, bundle)
console.log(`wrote ${outFile} (${bundle.length} bytes)`)
