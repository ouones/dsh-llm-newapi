import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertServiceable,
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_INPUT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveProfiles,
} from '../src/config.ts'
import type { ResolvedNewApiProviderProfile } from '../src/config.ts'

/** A minimal valid provider entry: an api routes every listed model. */
const providerWith = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  api: 'openai-completions',
  baseURL: 'https://gateway.example',
  models: [{ id: 'm1' }],
  ...overrides,
})

/** Resolve one provider under the given overrides and return its profile. */
const resolveOne = (overrides: Record<string, unknown>): ResolvedNewApiProviderProfile => {
  const resolved = resolveProfiles({ acme: providerWith(overrides) as never })
  const profile = resolved.get('acme')
  expect(profile).toBeDefined()
  return profile!
}

describe('resolveProfiles: route-set validation', () => {
  it('resolves an empty or missing providers dict to an empty dormant map', () => {
    expect(resolveProfiles({})).toEqual(new Map())
    expect(resolveProfiles(undefined)).toEqual(new Map())
  })

  it('rejects an array of profiles, hinting the dict shape', () => {
    expect(() => resolveProfiles([] as never)).toThrow(/dict keyed by provider route/)
    expect(() => resolveProfiles([{ baseURL: 'https://gateway.example' }] as never)).toThrow(/dict/)
  })

  it('rejects an empty provider route key', () => {
    expect(() => resolveProfiles({ '': providerWith({}) as never })).toThrow(/provider names must be non-empty/)
  })

  it('rejects an empty baseURL', () => {
    expect(() => resolveProfiles({ acme: providerWith({ baseURL: '' }) as never }))
      .toThrow(/empty baseURL/)
  })

  it('rejects an empty displayName', () => {
    expect(() => resolveProfiles({ acme: providerWith({ displayName: '' }) as never }))
      .toThrow(/empty displayName/)
  })

  it('rejects a streamIdleTimeoutMs that is not a positive finite timer delay', () => {
    for (const streamIdleTimeoutMs of [0, -1, MAX_TIMER_DELAY_MS + 1, Number.POSITIVE_INFINITY]) {
      expect(() => resolveProfiles({ acme: providerWith({ streamIdleTimeoutMs }) as never }))
        .toThrow(/streamIdleTimeoutMs must be a positive finite number/)
    }
  })

  it('rejects an empty defaultInput array', () => {
    expect(() => resolveProfiles({ acme: providerWith({ defaultInput: [] }) as never }))
      .toThrow(/defaultInput must name at least one modality/)
  })

  it('rejects a provider whose models cannot be routed onto any api', () => {
    // No route api, no modelApiOverrides, and no discovery: the model has no
    // wire protocol, so resolveModels refuses the profile.
    const { api, ...unrouted } = providerWith({})
    void api
    expect(() => resolveProfiles({ acme: unrouted as never })).toThrow(/needs an api/)
  })
})

describe('resolveProfiles: full profile resolution', () => {
  it('resolves every field onto the profile, defaulting the adapter-owned values', () => {
    const profile = resolveOne({
      apiKeyEnv: 'NEWAPI_KEY',
      displayName: 'Acme Gateway',
      streamIdleTimeoutMs: 12_000,
      headers: { 'x-custom': 'yes' },
      thinkingBudgets: { low: 1000, high: 8000 },
      reasoning: { low: 'low-effort' },
      timeoutMs: 30_000,
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 100 } },
      modelApiOverrides: { 'm1$': 'anthropic-messages' },
      models: [{ id: 'm1', maxTokens: 4096 }],
    })

    expect(profile.provider).toBe('acme')
    expect(profile.displayName).toBe('Acme Gateway')
    expect(profile.baseURL).toBe('https://gateway.example')
    expect(profile.api).toBe('openai-completions')
    expect(profile.streamIdleTimeoutMs).toBe(12_000)
    expect(profile.apiKeyEnv).toBe('NEWAPI_KEY') // a branded CredentialRef
    expect(profile.retryPolicy).toMatchObject({ mode: 'always', initialDelayMs: 100 })
    expect(profile.timeoutMs).toBe(30_000)
    expect(profile.headers).toEqual({ 'x-custom': 'yes' })
    expect(profile.thinkingBudgets).toEqual({ low: 1000, high: 8000 })

    expect([...profile.modelApiOverrides]).toEqual([['m1$', 'anthropic-messages']])
    expect([...profile.configuredMaxTokens]).toEqual([['m1', 4096]])
    expect(profile.models).toHaveLength(1)
    const [model] = profile.models
    expect(model).toBeDefined()
    // The regex beats the route api: `m1$` matches m1, so the model is
    // materialized onto the override's protocol.
    expect(model!.api).toBe('anthropic-messages')
    expect(model!.maxTokens).toBe(4096)
    expect(model!.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(model!.input).toEqual(DEFAULT_INPUT)
  })

  it('defaults streamIdleTimeoutMs, retryPolicy, displayName, and the model caps', () => {
    const profile = resolveOne({})

    expect(profile.streamIdleTimeoutMs).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    expect(profile.displayName).toBe('acme') // displayName defaults to the route key
    expect(profile.apiKeyEnv).toBeUndefined()
    expect(profile.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 2 })
    expect(profile.reasoning).toBeUndefined()
    expect(profile.thinkingBudgets).toBeUndefined()
    expect(profile.timeoutMs).toBeUndefined()
    expect(profile.headers).toBeUndefined()
    expect([...profile.modelApiOverrides]).toEqual([])
    expect([...profile.configuredMaxTokens]).toEqual([])
    const [model] = profile.models
    expect(model).toBeDefined()
    expect(model!.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(model!.maxTokens).toBe(DEFAULT_MAX_TOKENS)
    expect(model!.input).toEqual(DEFAULT_INPUT)
  })

  it('passes api fields through to the resolved profile', () => {
    const profile = resolveOne({
      api: 'anthropic-messages',
      modelApiOverrides: { '^m1$': 'openai-completions' },
    })

    expect(profile.api).toBe('anthropic-messages')
    // The override regex wins over the route api for its matching model: the
    // route api is the fallback that answers models nothing else routes.
    expect(profile.models[0]!.api).toBe('openai-completions')
  })

  it('applies the configured defaults to a model neither entry nor discovery sizes', () => {
    const profile = resolveOne({
      defaultContextWindow: 65_536,
      defaultMaxTokens: 4096,
      defaultInput: ['text', 'image'],
      models: [{ id: 'm1' }],
    })

    expect(profile.models[0]!.contextWindow).toBe(65_536)
    expect(profile.models[0]!.maxTokens).toBe(4096)
    expect(profile.models[0]!.input).toEqual(['text', 'image'])
  })

  it('turns modelApiOverrides into a ReadonlyMap detached from the source dict', () => {
    const source = providerWith({ modelApiOverrides: { '^m': 'openai-responses' } }) as never
    const resolved = resolveProfiles({ acme: source })
    const overrides = resolved.get('acme')!.modelApiOverrides

    expect(overrides).toBeInstanceOf(Map)
    expect([...overrides]).toEqual([['^m', 'openai-responses']])
    // Resolution copies the dict, so mutating the source afterwards must not
    // leak into the resolved profile's map.
    const sourceOverrides = (source as { modelApiOverrides: Record<string, string> }).modelApiOverrides
    sourceOverrides.other = 'anthropic-messages'
    expect([...resolved.get('acme')!.modelApiOverrides]).toEqual([['^m', 'openai-responses']])
  })

  it('resolves the exact shape the web panel saves: models plus per-model modelApiOverrides', () => {
    // This is the regression for the reported save failure: the panel fetches
    // the gateway's supported_endpoint_types, keeps it per model as the api,
    // and writes it as modelApiOverrides. Without it the route has neither a
    // route api nor any override, so resolveModels refuses every model.
    const profile = resolveOne({
      modelApiOverrides: { 'deepseek-chat': 'openai-completions', 'claude-sonnet': 'anthropic-messages' },
      models: [
        { id: 'deepseek-chat' },
        { id: 'claude-sonnet' },
        { id: 'unspecified' },
      ],
    })

    expect([...profile.modelApiOverrides]).toEqual([
      ['deepseek-chat', 'openai-completions'],
      ['claude-sonnet', 'anthropic-messages'],
    ])
    // ModelApiOverrides wins over the route api per model.
    expect(profile.models.map(m => [m.id, m.api])).toEqual([
      ['deepseek-chat', 'openai-completions'],
      ['claude-sonnet', 'anthropic-messages'],
      // A model with no matching override falls back to the route api.
      ['unspecified', 'openai-completions'],
    ])
  })

  it('defaults a bare provider profile through the runtime schema to a resolvable shape', () => {
    // The Config schema fills displayName-adjacent defaults; resolution then
    // serves the schema's materialized values.
    const config = Config({ providers: { acme: providerWith({}) as never } })
    expect(() => resolveProfiles(config.providers)).not.toThrow()
    const profile = resolveProfiles(config.providers).get('acme')!
    expect(profile.displayName).toBe('acme')
  })
})

describe('assertServiceable', () => {
  it('rejects an unserviceable profile and passes a serviceable one', () => {
    const invalid = Config({ providers: { acme: providerWith({ baseURL: '' }) as never } })
    expect(() => { assertServiceable(invalid) }).toThrow(/empty baseURL/)

    const valid = Config({ providers: { acme: providerWith({}) as never } })
    expect(() => { assertServiceable(valid) }).not.toThrow()
  })
})
