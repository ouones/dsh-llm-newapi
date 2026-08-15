import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverModels, MAX_RESPONSE_BYTES } from '../src/discovery.ts'

/** The requests the current `fetch` stub received, for header assertions. */
const requests: { url: string; init?: RequestInit }[] = []

/** The url of one recorded request, as the string the gateway sees. */
function urlOf(raw: string | URL | Request): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof URL) return raw.href
  return raw.url
}

/** A `fetch` stub answering one scripted JSON reply, recording requests. */
function stubFetch(behavior: {
  status?: number
  body?: string
  throw?: unknown
  signalAbort?: boolean
} = {}): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(init === undefined ? { url: urlOf(url) } : { url: urlOf(url), init })
    // What `fetch` itself does with an already-aborted signal: reject before
    // the request goes out, carrying the caller's abort reason.
    if (behavior.signalAbort) throw new DOMException('The operation was aborted.', 'AbortError')
    if (behavior.throw !== undefined) throw behavior.throw
    const body = behavior.body ?? '{}'
    return new Response(body, {
      status: behavior.status ?? 200,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    })
  })
}

afterEach(() => {
  requests.length = 0
  vi.unstubAllGlobals()
})

/** One entry of the scripted reply's `data` array, plus its dupe. */
const listing = (): string => JSON.stringify({
  data: [
    {
      id: 'acme-large',
      display_name: 'Acme Large',
      supported_endpoint_types: ['openai'],
      input_modalities: ['text', 'image'],
      context_window: 65_536,
      max_output_tokens: 4096,
    },
    { id: 'acme-small' },
  ],
})

describe('model discovery against a New API gateway', () => {
  it('reads the gateway listing and keeps the fields it discloses', async () => {
    stubFetch({ body: listing() })

    const models = await discoverModels({ baseURL: 'https://gateway.example/', apiKey: 'probe-key' })

    expect(models).toEqual([
      {
        id: 'acme-large',
        name: 'Acme Large',
        endpoints: ['openai'],
        input: ['text', 'image'],
        contextWindow: 65_536,
        maxTokens: 4096,
      },
      { id: 'acme-small' },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://gateway.example/v1/models')
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer probe-key')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('user-agent')).not.toBeNull()
  })

  it('keeps a deployment path instead of resolving it away', async () => {
    stubFetch({ body: JSON.stringify({ data: [{ id: 'm' }] }) })

    await discoverModels({ baseURL: 'https://gateway.example/openai/' })

    expect(requests[0]?.url).toBe('https://gateway.example/openai/v1/models')
  })

  it('offers no credential when the draft names none and nothing is stored', async () => {
    stubFetch({ body: JSON.stringify({ data: [{ id: 'm' }] }) })

    await discoverModels({ baseURL: 'https://gateway.example' })

    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.has('authorization')).toBe(false)
  })

  it('prefers the typed key and falls back to the stored one only when absent', async () => {
    stubFetch({ body: JSON.stringify({ data: [{ id: 'm' }] }) })
    const stored = vi.fn(async (_provider: string | undefined) => 'stored-key')

    await discoverModels({ baseURL: 'https://gateway.example', provider: 'acme', apiKey: 'typed' }, stored)
    await discoverModels({ baseURL: 'https://gateway.example', provider: 'acme' }, stored)

    const authorizations = requests.map(({ init }) => new Headers(init?.headers).get('authorization'))
    expect(authorizations).toEqual(['Bearer typed', 'Bearer stored-key'])
    expect(stored).toHaveBeenCalledTimes(1)
    expect(stored).toHaveBeenCalledWith('acme')
  })

  it('drops unusable rows and duplicate ids rather than failing the listing', async () => {
    stubFetch({
      body: JSON.stringify({
        data: [
          { id: 'good' },
          { id: '' },
          { name: 'no id at all' },
          null,
          { id: 'good' },
          { id: 'again' },
          { id: 'again', display_name: 'shadowed' },
          { id: 'zero-capacity', context_length: 0, max_tokens: -1 },
          { id: 'bad-types', supported_endpoint_types: ['openai', 7], input_modalities: ['text', 'nonsense'] },
        ],
      }),
    })

    const models = await discoverModels({ baseURL: 'https://gateway.example' })

    expect(models).toEqual([
      { id: 'good' },
      { id: 'again' },
      { id: 'zero-capacity' },
      { id: 'bad-types', endpoints: ['openai'] },
    ])
  })

  it('requires a baseURL, saying where a gateway\'s models can come from', async () => {
    await expect(discoverModels({})).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    await expect(discoverModels({ baseURL: '' })).rejects.toThrow(/set a baseURL/)
  })

  it('reports a reply that is not a model listing', async () => {
    stubFetch({ body: '{"models":[]}' })
    await expect(discoverModels({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(/no "data" array; enter this gateway's models by hand/)

    stubFetch({ body: 'not json at all' })
    await expect(discoverModels({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(/did not answer with JSON/)
  })

  it('points at the credential for a rejected one, and only then', async () => {
    for (const status of [401, 403]) {
      stubFetch({ status, body: '{"error":"nope"}' })
      await expect(discoverModels({ baseURL: 'https://gateway.example', apiKey: 'wrong' }))
        .rejects.toThrow(new RegExp(`answered ${status}; check the API key`))
    }

    stubFetch({ status: 500, body: '{"error":"boom"}' })
    await expect(discoverModels({ baseURL: 'https://gateway.example', apiKey: 'fine' }))
      .rejects.toThrow(/answered 500$/)
  })

  it('reports an unreachable endpoint instead of an empty catalog', async () => {
    stubFetch({ throw: new TypeError('fetch failed') })
    await expect(discoverModels({ baseURL: 'https://gateway.example' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('reports caller cancellation as an abort, not a raw reason', async () => {
    stubFetch({ signalAbort: true })
    await expect(discoverModels({
      baseURL: 'https://gateway.example',
      signal: AbortSignal.abort('test cancellation'),
    })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('reports an illegal probe key as a credential fault, not an unreachable endpoint', async () => {
    await expect(discoverModels({ baseURL: 'https://gateway.example', apiKey: 'sk-\u{1F600}' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    // A supplied blank key is a supplied key: judged, not probed unauthenticated.
    await expect(discoverModels({ baseURL: 'https://gateway.example', apiKey: ' ' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('refuses an oversized reply, whether its length is declared or streamed', async () => {
    const oversized = `{"data":[{"id":"m","pad":"${'x'.repeat(MAX_RESPONSE_BYTES)}"}]}`
    stubFetch({ body: oversized })
    await expect(discoverModels({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(new RegExp(`answered with more than ${MAX_RESPONSE_BYTES} bytes`))

    const chunks: string[] = ['{"data":[{"id":"m","pad":"', 'x'.repeat(MAX_RESPONSE_BYTES), '"}]}']
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(init === undefined ? { url: urlOf(url) } : { url: urlOf(url), init })
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk === undefined) { controller.close(); return }
          controller.enqueue(new TextEncoder().encode(chunk))
        },
      }))
    })
    await expect(discoverModels({ baseURL: 'https://gateway.example' }))
      .rejects.toThrow(new RegExp(`answered with more than ${MAX_RESPONSE_BYTES} bytes`))
  })
})
