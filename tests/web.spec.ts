import { describe, expect, it } from 'vitest'
import { installLlmNewapiWeb, MODELS_ROUTE, NS, SETTINGS_ROUTE } from '../src/web.ts'
import type { NewApiDiscoveredModel } from '../src/catalog.ts'
import type { LlmNewapiWebDeps } from '../src/web.ts'

/** A minimal fake `Response` recorder for the route handlers. */
function captureRes() {
  const out: any = { status: 0, headers: {} as Record<string, string> }
  out.setHeader = (k: string, v: string) => { out.headers[k] = v }
  out.writeHead = (s: number) => { out.status = s }
  out.end = (b: string | Uint8Array) => { out.body = Buffer.from(b).toString('utf8') }
  return out
}

/** A minimal fake `IncomingMessage` that yields a single JSON body buffer. */
function jsonReq(body: unknown, method: 'GET' | 'POST' = 'POST', sameOrigin = true) {
  const buf = Buffer.from(JSON.stringify(body))
  let consumed = false
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...sameOrigin ? { 'sec-fetch-site': 'same-origin' } : { 'sec-fetch-site': 'cross-site' },
    },
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (consumed) return Promise.resolve({ done: true as const, value: undefined as unknown })
        consumed = true
        return Promise.resolve({ done: false as const, value: buf })
      },
    }),
  }
}

/** Register the web routes against a stub seam; return the captured handlers. */
function register(settings: any, deps: LlmNewapiWebDeps) {
  const registrations: Array<any> = []
  const ctx: any = {
    inject: (_svc: string[], cb: (seam: any) => void) => cb(ctx),
    effect: (fn: () => (() => void) | undefined) => { const d = fn(); return d ? () => d() : () => {} },
    get: (name: string) => (name === 'settings' ? settings : name === 'webServer' ? ctx.webServer : undefined),
    logger: { warn: () => {} },
    settings,
    webServer: { register: (r: any) => { registrations.push(r); return () => {} } },
  }
  installLlmNewapiWeb(ctx, deps)
  return registrations
}

/** A stub settings seam that never conflicts. */
function happySettings(value: unknown = { providers: {} }) {
  return {
    describe: () => [{ ns: NS, value, revision: 3 }],
    writable: true,
    mutate: async () => {},
  }
}

describe('installLlmNewapiWeb route registration', () => {
  it('registers the exact settings and models routes', () => {
    const regs = register(happySettings(), { discover: async () => [] })
    expect(regs.map(r => r.path)).toContain(SETTINGS_ROUTE)
    expect(regs.map(r => r.path)).toContain(MODELS_ROUTE)
    for (const reg of regs) expect(reg.kind).toBe('exact')
  })
})

describe('settings route', () => {
  it('serves a GET snapshot with the resolved value and revision', async () => {
    const regs = register(happySettings({ providers: { g: { baseURL: 'x' } } }), { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq(null, 'GET'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.revision).toBe(3)
    expect(body.writable).toBe(true)
    expect(body.value.providers.g.baseURL).toBe('x')
  })

  it('forbids a non-same-origin POST', async () => {
    const regs = register(happySettings(), { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ ops: [] }, 'POST', false), res)
    expect(res.status).toBe(403)
  })

  it('returns 409 on a live revision conflict', async () => {
    const settings = {
      describe: () => [{ ns: NS, value: {}, revision: 2 }],
      writable: true,
      mutate: async () => {
        throw new Error('settings namespace "llm-newapi" changed since it was read (expected revision 1, now 2)')
      },
    }
    const regs = register(settings, { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ ops: [{ op: 'set', path: ['providers', 'g'], value: { baseURL: 'x' } }], expectedRevision: 1 }), res)
    expect(res.status).toBe(409)
  })

  it('returns 400 when the seam is read-only', async () => {
    const settings = {
      describe: () => [{ ns: NS, value: {}, revision: 1 }],
      writable: false,
      mutate: async () => {},
    }
    const regs = register(settings, { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ ops: [{ op: 'set', path: ['providers', 'g'], value: { baseURL: 'x' } }] }), res)
    expect(res.status).toBe(400)
  })

  it('applies a set op through settings.mutate when writable', async () => {
    let applied: readonly any[] | undefined
    let appliedNs: unknown
    const settings = {
      describe: () => [{ ns: NS, value: { providers: { g: { baseURL: 'x' } } }, revision: 4 }],
      writable: true,
      mutate: async (ns: string, ops: readonly any[]) => { appliedNs = ns; applied = ops },
    }
    const regs = register(settings, { discover: async () => [] })
    const handler = regs.find(r => r.path === SETTINGS_ROUTE)!.handler
    const res = captureRes()
    const ops = [{ op: 'set', path: ['providers', 'g'], value: { baseURL: 'y' } }]
    await handler(jsonReq({ ops, expectedRevision: 4 }), res)
    expect(res.status).toBe(200)
    expect(applied).toEqual(ops)
    expect(appliedNs).toBe(NS)
  })
})

describe('models route', () => {
  it('interrogates the gateway and returns id/name in endpoint order', async () => {
    const discovered: NewApiDiscoveredModel[] = [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    ]
    let call: { baseURL: string; apiKey: string | undefined; provider: string | undefined } | undefined
    const deps: LlmNewapiWebDeps = {
      discover: async (baseURL, apiKey, provider) => { call = { baseURL, apiKey, provider }; return discovered },
    }
    const regs = register(happySettings(), deps)
    const handler = regs.find(r => r.path === MODELS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ baseURL: 'https://gateway.example', apiKey: 'sk-abc', provider: 'g' }), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).models).toEqual([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    ])
    expect(call).toEqual({ baseURL: 'https://gateway.example', apiKey: 'sk-abc', provider: 'g' })
  })

  it('falls back to the stored key when the draft names none', async () => {
    let seen: { baseURL: string; apiKey: string | undefined; provider: string | undefined } | undefined
    const deps: LlmNewapiWebDeps = {
      storedApiKey: async () => 'stored-key',
      discover: async (baseURL, apiKey, provider) => { seen = { baseURL, apiKey, provider }; return [] },
    }
    const regs = register(happySettings(), deps)
    const handler = regs.find(r => r.path === MODELS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ baseURL: 'https://gateway.example', provider: 'g' }), res)
    expect(res.status).toBe(200)
    // The panel sends the route key only; the Host resolves the stored secret
    // and hands the real value to the gateway probe (never a credential ref).
    expect(seen).toEqual({ baseURL: 'https://gateway.example', apiKey: 'stored-key', provider: 'g' })
  })

  it('derives a per-model api from the gateway\'s supported endpoint types', async () => {
    const discovered: NewApiDiscoveredModel[] = [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', endpoints: ['openai'] },
      { id: 'claude-sonnet', name: 'Claude Sonnet', endpoints: ['anthropic'] },
      // A listing that advertises no endpoint type carries no api: the panel
      // keeps such a model selectable but cannot route it on its own.
      { id: 'unspecified', name: 'Unspecified' },
    ]
    const deps: LlmNewapiWebDeps = { discover: async () => discovered }
    const regs = register(happySettings(), deps)
    const handler = regs.find(r => r.path === MODELS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ baseURL: 'https://gateway.example', provider: 'g' }), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).models).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek Chat', api: 'openai-completions' },
      { id: 'claude-sonnet', name: 'Claude Sonnet', api: 'anthropic-messages' },
      { id: 'unspecified', name: 'Unspecified' },
    ])
  })

  it('requires a base URL', async () => {
    const regs = register(happySettings(), { discover: async () => [] })
    const handler = regs.find(r => r.path === MODELS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ apiKey: 'sk-abc' }), res)
    expect(res.status).toBe(400)
  })

  it('forbids a non-same-origin models POST', async () => {
    const regs = register(happySettings(), { discover: async () => [] })
    const handler = regs.find(r => r.path === MODELS_ROUTE)!.handler
    const res = captureRes()
    await handler(jsonReq({ baseURL: 'https://gateway.example' }, 'POST', false), res)
    expect(res.status).toBe(403)
  })
})
