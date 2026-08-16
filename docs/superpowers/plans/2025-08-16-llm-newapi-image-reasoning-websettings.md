# dsh-llm-newapi: Image Input, 5-Level Reasoning, and Web Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI/Anthropic vision support, exactly five reasoning-depth levels (default `medium`), and a same-origin Web settings panel to the New API LLM adapter, all built by a working two-phase `lib` build.

**Architecture:** The Host adapter serializes image blocks through the durable attachment store into `image_url` (OpenAI) or `image` (Anthropic) wire parts. Reasoning levels are a fixed 5-tuple whose wire value equals the level name, with `medium` as the default when a request names none. Web configuration is served by `src/web.ts` (two same-origin Node routes over the existing `settings` seam, plus a `/v1/models` interrogation) and consumed by a self-contained React client bundle registered into the `settings.section` slot.

**Tech Stack:** TypeScript (tsc), tsdown (single-file `//#region` merge), vitest, React (browser runtime shared ledger), schemastery, Cordis.

**Spec:** All user requests in Chinese during this session:
1. 新增 API 支持图片输入与图片理解。
2. 插件支持 Web setting（WebUI 配置 Provider Base URL / API Key 名称 / 模型）。
3. 模型 ID 与显示名走 v1/models；模型默认全选，加勾选框支持取消全选。
4. 新增思考深度调节，默认支持 low/medium/high/xhigh/max 5 档。
   (TDD-following detail confirmed: wire 值 = 档位名本身；"完全改成正好 5 档"；默认 medium。)

## Global Constraints

- Reasoning wire value for each level **equals the level name**: `low→low`, `medium→medium`, `high→high`, `xhigh→xhigh`, `max→max`. There is **no** `off` or `minimal` level.
- Default reasoning level is `medium` whenever a reasoning-capable model's request names no effort and the route offers it.
- The model list shown in the Web panel comes from the gateway's `GET /v1/models` (id + display name); every fetched candidate defaults to **selected**, with a select-all/select-none toggle.
- `src/client` is excluded from the Host build (built separately by `tsconfig.client.json`); Host and client are distinct `tsconfig` projects.
- `tests/loader-composition.spec.ts` cannot run in this environment (missing dev-only deps `@deepseek-ai/cordis-plugin-loader` etc.) — it is pre-existing and out of scope; verification excludes it.
- Image bytes are read through the durable attachment service (`attachments.readImage`); without a store, an image is refused with `UNSUPPORTED_CONTENT` rather than silently dropped.

---

## File Structure

- `src/serialize.ts` — vision serialization (OpenAI `image_url` parts, Anthropic `image` blocks).
- `src/adapter.ts` — stream wiring (`await serialize…`, pass `attachments`), default-medium reasoning resolution.
- `src/types.ts` — wire types for vision parts/blocks.
- `src/catalog.ts` — 5-level `THINKING_LEVELS` + `defaultThinkingLevels()`.
- `src/config.ts` — schema for the 5-level efforts dict.
- `src/web.ts` — Host web routes (`/_dsh/llm-newapi/settings`, `/_dsh/llm-newapi/models`).
- `src/index.ts` — wiring: web routes + model discovery.
- `src/client/index.ts` — self-contained React settings panel (React.createElement, no JSX).
- `scripts/build-client.mjs` — wraps compiled client CJS into `lib/client.js` (`__ModuleLoader__` frame).
- `tests/web.spec.ts` — NEW: locks the `web.ts` route contract (the TDD red→green tasks below).
- `tests/serialize.spec.ts`, `tests/catalog.spec.ts` — already updated for image + 5-levels (existing).

## Execution status note

Tasks 1–4 (serialize/adapter/catalog/config/client) were implemented earlier this session and are already green. Tasks 5–6 below are the **TDD red→green** additions that lock two behaviors that currently have no test: the `web.ts` route contract and the adapter default-**medium** resolution. They follow the Red-Green-Refactor cycle (failing test first, then minimal implementation).

---

### Task 1: Vision serialization (OpenAI + Anthropic)

**Files:**
- Modify: `src/serialize.ts`, `src/types.ts`
- Test: `tests/serialize.spec.ts`

**Interfaces:**
- Produces: `serializeChatRequest(options, model, reasoningEffort?, attachments?): Promise<WireRequest>`; `serializeAnthropicRequest(options, model, effort?, attachments?): Promise<AnthropicRequest>` — both now `async` and accepting an optional `AttachmentStore`.
- Status: **already implemented and green** (37 serialize tests pass). No red→green steps here.

---

### Task 2: Five reasoning levels with default `medium`

**Files:**
- Modify: `src/catalog.ts`, `src/config.ts`, `src/adapter.ts`
- Test: `tests/catalog.spec.ts`

**Interfaces:**
- Produces: `THINKING_LEVELS = ['low','medium','high','xhigh','max']`.
- Status: **already implemented and green** (catalog 40 tests pass).

#### Task 2b: lock the default-`medium` resolution (TDD red→green)

**Files:**
- Modify: `src/adapter.ts` (export `resolveReasoningEffort` if not already exported)
- Test: `tests/adapter-reasoning.spec.ts` (NEW) — or extend an existing adapter test

- [ ] **Step 1: Write the failing test** — a reasoning-capable model offering all five levels, with route `reasoning` listing `{low:'low', medium:'medium'}`, and a request naming no effort, must resolve to wire `'medium'`.

```typescript
// tests/adapter-reasoning.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveReasoningEffort } from '../src/adapter.ts'

const model = { provider: 'p', id: 'm', reasoning: true, thinkingLevelMap: {
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
} } as any
const profile = { reasoning: { low: 'low', medium: 'medium' } } as any

describe('resolveReasoningEffort default-medium', () => {
  it('defaults to medium when the request names no effort and medium is offered', () => {
    expect(resolveReasoningEffort(model, profile, undefined)).toEqual({ wire: 'medium', offered: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run tests/adapter-reasoning.spec.ts` → FAIL (feature missing / export missing).

- [ ] **Step 3: Implement minimal** — export `resolveReasoningEffort` and, in its unnamed-effort branch, prefer `'medium'` when present in the route's offered levels before falling back to the first.

- [ ] **Step 4: Run it to verify it passes** — `npx vitest run tests/adapter-reasoning.spec.ts` → PASS; then full suite.

- [ ] **Step 5: Commit.**

---

### Task 3: `/v1/models` discovery wiring

**Files:**
- Modify: `src/index.ts`, `src/discovery.ts`
- Test: `tests/discovery.spec.ts`

**Interfaces:**
- Consumes: `discoverModels(request, storedApiKey?): Promise<readonly NewApiDiscoveredModel[]>` returning `{id, name?}`.
- Status: **already implemented and green** (discovery 12 tests pass).

---

### Task 4: Host Web routes (settings + models)

**Files:**
- Create: `src/web.ts`
- Modify: `src/index.ts`
- Test: `tests/web.spec.ts` (NEW)

**Interfaces:**
- Produces: `SETTINGS_ROUTE = '/_dsh/llm-newapi/settings'`, `MODELS_ROUTE = '/_dsh/llm-newapi/models'`, `installLlmNewapiWeb(ctx, deps)` where `deps.discover(baseURL, apiKey, provider): Promise<readonly NewApiDiscoveredModel[]>` and `deps.storedApiKey?(provider): Promise<string | undefined>`.
- Status: **implemented; NOT yet locked by tests** — Task 5 is its TDD red→green.

---

### Task 5: Lock the Web route contract (TDD red→green)

**Files:**
- Modify: `src/web.ts` (only what the test requires, e.g. export helpers if needed)
- Test: `tests/web.spec.ts` (NEW)

**Interfaces:**
- Consumes: `NS = 'llm-newapi'`, `NS_SCHEMA`, `SETTINGS_ROUTE`, `MODELS_ROUTE`, `installLlmNewapiWeb(ctx, deps)`.
- Produces: none new — this task proves the served contract.

- [ ] **Step 1: Write the failing tests** — via `installLlmNewapiWeb` with a stub `ctx` whose `webServer.register` records handlers and whose `settings` provides `describe()`/`mutate()`/`writable`, assert:

```typescript
// tests/web.spec.ts
import { describe, expect, it } from 'vitest'
import { installLlmNewapiWeb, SETTINGS_ROUTE, MODELS_ROUTE } from '../src/web.ts'

function stubCtx(settings: any, deps: any) {
  const registrations: any[] = []
  const ctx = {
    inject: (_svc: string[], cb: (seam: any) => void) => cb(ctx),
    effect: (fn: () => (() => void) | undefined) => { const d = fn(); return d ? () => d() : () => {} },
    get: (name: string) => (name === 'settings' ? settings : undefined),
    logger: { warn: () => {} },
    settings,
    webServer: { register: (r: any) => { registrations.push(r); return () => {} } },
  }
  installLlmNewapiWeb(ctx as any, deps)
  return registrations
}

describe('web routes', () => {
  it('registers the settings and models exact routes', () => {
    const regs = stubCtx({ describe: () => [], writable: true, mutate: async () => {} }, { discover: async () => [] })
    expect(regs.map(r => r.path)).toContain(SETTINGS_ROUTE)
    expect(regs.map(r => r.path)).toContain(MODELS_ROUTE)
  })
  it('serves GET settings with the snapshot fields', async () => {
    const settings = { describe: () => [{ ns: 'llm-newapi', value: { providers: {} }, revision: 3 }], writable: true, mutate: async () => {} }
    const regs = stubCtx(settings, { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler({ method: 'GET', headers: {} }, res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).revision).toBe(3)
  })
  it('POSTs a set op through settings.mutate, returning 409 on revision conflict', async () => {
    let mutated: any
    const settings = {
      describe: () => [{ ns: 'llm-newapi', value: {}, revision: 1 }],
      writable: true,
      mutate: async (ns: string, ops: any) => { throw new Error('settings namespace changed since it was read (expected revision 1, now 2)') },
    }
    const regs = stubCtx(settings, { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, [Symbol.asyncIterator]: asyncBody('{"ops":[{"op":"set","path":["providers","g"],"value":{}}],"expectedRevision":1}') }, res)
    expect(res.status).toBe(409)
  })
})
```

Where `captureRes()` and `asyncBody()` are small test helpers defined in the same file (record `status`/`body`, and yield a single buffer from a wrapper object) — the exact helper bodies are in the "no-placeholder" appendix below.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/web.spec.ts`. Expected: FAIL for the snapshot/mutate assertions if `web.ts` does not yet satisfy them (e.g. status wrong), and PASS for the register assertions if they already hold. **Verification note:** because `web.ts` is already implemented, the untrue assertions will pass; the honest TDD proof is the conflict→409 and snapshot tests, which exercise the real `settings.mutate` conflict path.

- [ ] **Step 3: Implement minimal** — adjust `src/web.ts` only if a test shows a real gap (e.g. non-409 on conflict). Prefer proving existing behavior over churn.

- [ ] **Step 4: Run to verify green** — `npx vitest run tests/web.spec.ts` and full suite must pass.

- [ ] **Step 5: Commit.**

#### Appendix: test helpers for Task 5 (no placeholders)

```typescript
function captureRes(): any {
  const out: any = { status: 0, body: '', setHeader: (_k: string, _v: string) => {}, writeHead: (s: number) => { out.status = s } }
  out.setHeader = (k: string, v: string) => { out.headers = out.headers || {}; out.headers[k] = v }
  out.end = (b: string | Uint8Array) => { out.body = Buffer.from(b).toString('utf8') }
  // sync writes: writeHead before end sets status
  return new Proxy(out, {})
}
function asyncBody(text: string) {
  const buf = Buffer.from(text)
  let done = false
  return {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    [Symbol.asyncIterator]() { return this },
    next() { if (done) return Promise.resolve({ done: true, value: undefined }); done = true; return Promise.resolve({ done: false, value: buf }) },
  }
}
```

---

### Task 6: Self-contained React client settings panel

**Files:**
- Create: `src/client/index.ts`, `scripts/build-client.mjs`, `tsconfig.client.json`
- Modify: `package.json` (`./client` export, `files`, `dsh.client`, `build:client`), `tsconfig.json` (`exclude: ["src/client"]`)
- Verify: `npm run build:client`

**Interfaces:**
- Produces: `inject = ['slots','locale']`, `apply(ctx)` registering `settings.section` id `llm-newapi`; reads `/_dsh/llm-newapi/settings`, writes via POST ops, fetches models from `/_dsh/llm-newapi/models`.
- Status: **already implemented and built** (`lib/client.js`, 18.6 kB, `require("react")` only external). Browser-component behavior is not covered by a Node test (out of scope for this environment); the served contract is what Task 5 locks.

---

## Self-Review

- **Spec coverage:** R1 → Task 1; R4 → Task 2 + 2b; R3 (v1/models) → Task 3 + web models route; R2 → Tasks 4+6; select-all toggle → client panel (Task 6). All four requirements have at least one task.
- **Placeholder scan:** Task 5 includes actual test/helper code; no "TBD"/"implement later" patterns. The one red-run note is an explicit honesty call, not a placeholder.
- **Type consistency:** `deps.discover(baseURL, apiKey, provider)` and `deps.storedApiKey?(provider)` are named identically in Task 4 and Task 5. `NS`/`NS_SCHEMA`/route constants match `src/web.ts`.
- **Gap found:** Tasks 1–4 feature code predates their tests (already green). This is flagged in the "Execution status note" rather than hidden; Task 5/2b are the true TDD red→green additions.

---

## Decision & TDD completion record

**Decision (option 2, per user):** Reasoning levels default to the static five
(`low`…`max`, `medium` default), but the upstream's authoritative optional list —
including `off` — is passed through rather than promoted to a fixed enum. This
follows the official LLM-adapter guidance ("preserve the authoritative optional
list, including `off`, don't promote to a core enum").

Implemented and verified:
- `catalog.ts`: `NewApiReasoningEfforts` widened to `Partial<Record<core>> & Record<string,string|null>`; `resolveModelReasoning` iterates **all** declared keys so `off`/extra spellings pass through; undeclared core levels stay pinned unsupported; a valueless `off` is valid ("supported, send nothing").
- `config.ts`: `reasoningEfforts` dict keys widened from `THINKING_LEVELS` to `z.string()` so `off` passes schema.
- `adapter.ts`: `resolveReasoningEffort` (now exported) treats `off` as "send nothing" (`{wire:undefined, offered:true}`) instead of throwing; default level is `medium` when medium is offered.
- **TDD red→green:** `tests/catalog.spec.ts` (two `off` pass-through tests) and `tests/adapter-reasoning.spec.ts` (4 tests) were written first, watched fail, then made green. Full suite: **183 tests pass**.

**Task 5 red→green (web routes):** `tests/web.spec.ts` exercised real
red→green — first RED (test-harness bug: stub `get('webServer')` returned
undefined; and real finding: route handlers were fire-and-forget so `await
handler()` resolved before completion), then GREEN after making the handlers
`async`/`await` (returning the promise the webServer dispatcher waits on, matching
the reference implementation). 10/10 web tests pass.
