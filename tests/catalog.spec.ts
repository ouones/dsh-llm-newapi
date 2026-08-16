/**
 * Unit coverage of the route catalog materialization — the plugin's core
 * selling point: the compat block forced on every model (the fix for the
 * `role: "developer"` 400), reasoning-effort resolution, wire-protocol
 * routing, and the discovery/configuration merge. Behavior-only assertions;
 * what the adapter does with the materialized models lives in the adapter
 * suites.
 */
import { describe, expect, it } from 'vitest'
import {
  MODALITIES,
  SUPPORTED_PROTOCOLS,
  SUPPORTED_THINKING_FORMATS,
  THINKING_LEVELS,
  modelInfo,
  resolveModels,
  routeModelApi,
} from '../src/catalog.ts'
import type {
  NewApiDiscoveredModel,
  NewApiModel,
  NewApiModelOverride,
  NewApiModelProfile,
  NewApiProtocol,
  NewApiReasoningEfforts,
  RouteCatalogRequest,
} from '../src/catalog.ts'

/** A complete route-level request with safe fallback capacities. */
function request(partial: Partial<RouteCatalogRequest> = {}): RouteCatalogRequest {
  return {
    provider: 'acme-gateway',
    baseURL: 'https://gateway.test',
    defaultContextWindow: 4096,
    defaultMaxTokens: 1024,
    defaultInput: ['text'],
    ...partial,
  }
}

/** The single model of one materialization, or throw. */
function modelOf(
  partial: Partial<RouteCatalogRequest> = {},
  discoveredModels: readonly NewApiDiscoveredModel[] = [],
): NewApiModel {
  const [model] = resolveModels(request(partial), discoveredModels).models
  if (model === undefined) throw new Error('the route resolved no models')
  return model
}

/** A discovered catalog entry the gateway might disclose about itself. */
function discovered(partial: Partial<NewApiDiscoveredModel> = {}): NewApiDiscoveredModel {
  return {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    endpoints: ['openai'],
    input: ['text'],
    contextWindow: 64_000,
    maxTokens: 8192,
    reasoning: true,
    ...partial,
  }
}

describe('compat enforcement', () => {
  it('forces the safe defaults on a model discovery disclosed', () => {
    const model = modelOf({}, [discovered()])
    expect(model.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    })
    // The forced compat rides on the model the adapter actually sends.
    expect(model).toMatchObject({
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      api: 'openai-completions',
      provider: 'acme-gateway',
      baseUrl: 'https://gateway.test',
      input: ['text'],
      contextWindow: 64_000,
      maxTokens: 8192,
      reasoning: true,
    })
  })

  it('forces the safe defaults on a hand-configured model too', () => {
    const model = modelOf({
      api: 'openai-completions',
      models: [{ id: 'acme-large', contextWindow: 65_536, maxTokens: 4096 }],
    })
    expect(model.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    })
  })

  it('passes an explicitly enabled developer role through', () => {
    const model = modelOf({
      api: 'openai-completions',
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1, compat: { supportsDeveloperRole: true } }],
    })
    expect(model.compat).toMatchObject({ supportsDeveloperRole: true })
    // The other forced fields stay at their safe values.
    expect(model.compat.supportsStore).toBe(false)
    expect(model.compat.maxTokensField).toBe('max_tokens')
  })

  it('applies the route compat as the default under each model', () => {
    const model = modelOf({
      api: 'openai-completions',
      compat: { supportsDeveloperRole: true, supportsStore: true, maxTokensField: 'max_completion_tokens' },
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
    })
    expect(model.compat).toEqual({
      supportsDeveloperRole: true,
      supportsStore: true,
      maxTokensField: 'max_completion_tokens',
    })
  })

  it('prefers the model compat over the route compat per field', () => {
    const model = modelOf({
      api: 'openai-completions',
      compat: { supportsDeveloperRole: true, supportsStore: true },
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1, compat: { supportsDeveloperRole: false } }],
    })
    expect(model.compat).toEqual({
      supportsDeveloperRole: false,
      supportsStore: true,
      maxTokensField: 'max_tokens',
    })
  })

  it('leaves the dialect switches absent when nothing names them', () => {
    const model = modelOf({ api: 'openai-completions', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] })
    expect(model.compat.thinkingFormat).toBeUndefined()
    expect(model.compat.supportsReasoningEffort).toBeUndefined()
    expect(model.compat.supportsLongCacheRetention).toBeUndefined()
  })

  it('passes configured dialect switches through', () => {
    const model = modelOf({
      api: 'openai-completions',
      models: [{
        id: 'm',
        contextWindow: 1,
        maxTokens: 1,
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false, supportsLongCacheRetention: true },
      }],
    })
    expect(model.compat).toEqual({
      thinkingFormat: 'deepseek',
      supportsReasoningEffort: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsLongCacheRetention: true,
    })
  })
})

describe('reasoning efforts', () => {
  /** One configured-only model declaring exactly the given efforts. */
  function declared(efforts: false | NewApiReasoningEfforts, id = 'm'): NewApiModel {
    return modelOf({
      api: 'openai-completions',
      models: [{ id, contextWindow: 1, maxTokens: 1, reasoningEfforts: efforts }],
    })
  }

  it('translates a declared dict into an explicit thinkingLevelMap', () => {
    const model = declared({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })

  it('retains a declared wire value in the map', () => {
    expect(declared({ high: 'boost', max: 'extreme' }).thinkingLevelMap?.high).toBe('boost')
    expect(declared({ high: 'boost', max: 'extreme' }).thinkingLevelMap?.max).toBe('extreme')
  })

  it('disables reasoning with false', () => {
    const model = declared(false)
    expect(model.reasoning).toBe(false)
    expect(model.thinkingLevelMap).toBeUndefined()
  })

  it('inherits the discovered reasoning capability when the field is absent', () => {
    expect(modelOf({}, [discovered({ reasoning: true })]).reasoning).toBe(true)
    expect(modelOf({}, [discovered({ reasoning: false })]).reasoning).toBe(false)
  })

  it('inhibits a discovered reasoning model to the default five levels', () => {
    const model = modelOf({}, [discovered({ reasoning: true })])
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })

  it('reports no reasoning for a model nothing describes', () => {
    expect(modelOf({ api: 'openai-completions', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] }).reasoning)
      .toBe(false)
  })

  it('rejects an empty dict and a valueless null', () => {
    expect(() => declared({})).toThrow(/empty reasoningEfforts/)
    expect(() => declared(null as never)).toThrow(/empty reasoningEfforts/)
  })

  it('accepts a non-core pass-through key instead of rejecting it', () => {
    // Docs: preserve the upstream's authoritative optional list rather than
    // promoting a fixed core enum, so an unknown key (e.g. `turbo`) is kept.
    const m = declared({ turbo: 'turbo' } as never)
    expect(m.reasoning).toBe(true)
    expect(m.thinkingLevelMap?.turbo).toBe('turbo')
    // The undeclared core levels stay pinned unsupported.
    expect(m.thinkingLevelMap?.low).toBeNull()
  })

  it('keeps a declared non-core level (e.g. off) as a pass-through option', () => {
    // Docs: preserve the upstream's authoritative optional list, including
    // `off`, rather than promoting a fixed core enum. `off` supports "send
    // nothing" (null wire); extra spellings pass their value through.
    const model = declared({ off: null, max: 'max' })
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap?.off).toBeNull()
    expect(model.thinkingLevelMap?.max).toBe('max')
    // The undeclared core levels stay pinned unsupported.
    expect(model.thinkingLevelMap?.low).toBeNull()
  })

  it('lets a declared off with an explicit wire value pass that value through', () => {
    expect(declared({ off: 'none', max: 'max' }).thinkingLevelMap?.off).toBe('none')
  })

  it('rejects a declared level left without a wire value', () => {
    expect(() => declared({ high: null })).toThrow(/needs the wire value dispatch/)
  })

  it('rejects an empty string wire', () => {
    expect(() => declared({ high: '' })).toThrow(/must not be an empty string/)
  })
})

describe('protocol routing', () => {
  it('routes a model id through the first matching modelApiOverrides regex', () => {
    const overrides = new Map<string, NewApiProtocol>([
      ['^deepseek-', 'openai-completions'],
      ['^claude-', 'anthropic-messages'],
    ])
    expect(routeModelApi('deepseek-v4-flash', ['anthropic'], request({
      api: 'openai-responses',
      modelApiOverrides: overrides,
    }))).toBe('openai-completions')
    expect(routeModelApi('claude-sonnet', ['anthropic'], request({ modelApiOverrides: overrides })))
      .toBe('anthropic-messages')
  })

  it('falls through an unmatched regex to the route api, then to discovery', () => {
    const overrides = new Map<string, NewApiProtocol>([['^deepseek-', 'openai-completions']])
    expect(routeModelApi('other-model', ['openai'], request({ modelApiOverrides: overrides })))
      .toBe('openai-completions')
    expect(routeModelApi('other-model', undefined, request({ api: 'anthropic-messages', modelApiOverrides: overrides })))
      .toBe('anthropic-messages')
  })

  it('derives completions from openai discovery and messages from anthropic', () => {
    expect(routeModelApi('m', ['openai'], request())).toBe('openai-completions')
    expect(routeModelApi('m', ['anthropic'], request())).toBe('anthropic-messages')
    expect(routeModelApi('m', ['other'], request())).toBeUndefined()
    expect(routeModelApi('m', undefined, request())).toBeUndefined()
  })

  it('uses the configured route api for every model', () => {
    const model = modelOf({
      api: 'anthropic-messages',
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
    }, [discovered({ id: 'm' })])
    expect(model.api).toBe('anthropic-messages')
  })

  it('refuses a route with no api anywhere', () => {
    expect(() => resolveModels(request({ models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] })))
      .toThrow(/needs an api/)
  })

  it('rejects an invalid regular expression', () => {
    expect(() => routeModelApi('m', undefined, request({
      modelApiOverrides: new Map<string, NewApiProtocol>([['[', 'openai-completions']]),
    }))).toThrow(/not a valid regular expression/)
    expect(() => resolveModels(request({
      api: 'openai-completions',
      modelApiOverrides: new Map<string, NewApiProtocol>([['[', 'openai-completions']]),
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
    }))).toThrow(/not a valid regular expression/)
  })
})

describe('discovery merging', () => {
  it('serves only configured models when discovery has not answered', () => {
    const { models } = resolveModels(request({
      api: 'openai-completions',
      models: [
        { id: 'acme-large', contextWindow: 65_536, maxTokens: 4096 },
        { id: 'acme-small', contextWindow: 8192, maxTokens: 512 },
      ],
    }))
    expect(models.map(model => model.id)).toEqual(['acme-large', 'acme-small'])
  })

  it('materializes the discovered catalog when nothing is configured', () => {
    const { models } = resolveModels(request(), [
      discovered(),
      { id: 'deepseek-reasoner', endpoints: ['openai'], input: ['text'], contextWindow: 128_000, maxTokens: 16_384 },
    ])
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      api: 'openai-completions',
      input: ['text'],
      contextWindow: 64_000,
      maxTokens: 8192,
    })
    // A listing that discloses no name falls back to the id.
    expect(models[1]?.name).toBe('deepseek-reasoner')
  })

  it('replaces the discovered set entirely with a configured models list', () => {
    const { models } = resolveModels(request({
      api: 'openai-completions',
      models: [{ id: 'acme-large', contextWindow: 65_536, maxTokens: 4096 }],
    }), [discovered()])
    expect(models.map(model => model.id)).toEqual(['acme-large'])
  })

  it('reshapes one discovered model through modelOverrides and leaves its siblings alone', () => {
    const { models, configuredMaxTokens } = resolveModels(request({
      modelOverrides: { 'deepseek-chat': { name: 'DeepSeek (proxied)', maxTokens: 4096 } },
    }), [
      discovered(),
      { id: 'deepseek-reasoner', endpoints: ['openai'], input: ['text'], contextWindow: 128_000 },
    ])
    const reshaped = models.find(model => model.id === 'deepseek-chat')
    const sibling = models.find(model => model.id === 'deepseek-reasoner')
    expect(reshaped).toMatchObject({ name: 'DeepSeek (proxied)', maxTokens: 4096, contextWindow: 64_000 })
    expect(reshaped?.compat).toEqual({ supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' })
    expect(sibling).toMatchObject({ id: 'deepseek-reasoner', name: 'deepseek-reasoner', contextWindow: 128_000 })
    expect(models).toHaveLength(2)
    // An override's cap is explicit configuration, so it becomes the request default.
    expect(configuredMaxTokens.get('deepseek-chat')).toBe(4096)
    expect(configuredMaxTokens.has('deepseek-reasoner')).toBe(false)
  })

  it('ignores overrides when discovery has not answered and models are configured', () => {
    const { models } = resolveModels(request({
      api: 'openai-completions',
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
      modelOverrides: { ghost: { name: 'x' } },
    }))
    expect(models.map(model => model.id)).toEqual(['m'])
  })

  it('refuses an override that names a model discovery does not describe', () => {
    expect(() => resolveModels(request({ modelOverrides: { ghost: { name: 'x' } } }), [discovered()]))
      .toThrow(/which the discovered catalog does not describe/)
  })

  it('refuses an override with an empty model id', () => {
    expect(() => resolveModels(request({ modelOverrides: { '': { name: 'x' } } }), [discovered()]))
      .toThrow(/empty model id/)
  })

  it('refuses an override that smuggles an id field', () => {
    const smuggled = { name: 'x', id: 'other' } as unknown as NewApiModelOverride
    expect(() => resolveModels(request({ modelOverrides: { 'deepseek-chat': smuggled } }), [discovered()]))
      .toThrow(/sets "id", which is the dict key/)
  })

  it('refuses duplicate and empty model ids', () => {
    expect(() => resolveModels(request({
      api: 'openai-completions',
      models: [
        { id: 'dup', contextWindow: 1, maxTokens: 1 },
        { id: 'dup', contextWindow: 2, maxTokens: 2 },
      ],
    }))).toThrow(/more than once/)
    expect(() => resolveModels(request({
      api: 'openai-completions',
      models: [{ id: '', contextWindow: 1, maxTokens: 1 }],
    }))).toThrow(/empty id/)
  })

  it('refuses a route with no models at all', () => {
    expect(() => resolveModels(request({ api: 'openai-completions' }))).toThrow(/resolves no models/)
    expect(() => resolveModels(request({ api: 'openai-completions', models: [] }))).toThrow(/resolves no models/)
  })
})

describe('capacity defaults', () => {
  it('falls back from entry to discovery to the request defaults', () => {
    const entry = modelOf({
      api: 'openai-completions',
      models: [{ id: 'sized', contextWindow: 32_000, maxTokens: 2048 }],
    })
    expect(entry.contextWindow).toBe(32_000)
    expect(entry.maxTokens).toBe(2048)

    const discoveredCap = modelOf(
      { api: 'openai-completions', models: [{ id: 'm' }] },
      [discovered({ id: 'm', contextWindow: 16_000, maxTokens: 1024 })],
    )
    expect(discoveredCap.contextWindow).toBe(16_000)
    expect(discoveredCap.maxTokens).toBe(1024)

    const defaults = modelOf({ api: 'openai-completions', models: [{ id: 'bare' }] })
    expect(defaults.contextWindow).toBe(4096)
    expect(defaults.maxTokens).toBe(1024)
  })

  it('refuses a capacity that is not a positive integer', () => {
    const declare = (partial: Partial<NewApiModelProfile>): (() => unknown) =>
      () => resolveModels(request({
        api: 'openai-completions',
        models: [{ id: 'm', contextWindow: 1, maxTokens: 1, ...partial }],
      }))
    expect(declare({ contextWindow: 0 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ contextWindow: 1.5 })).toThrow(/contextWindow must be a positive integer/)
    expect(declare({ maxTokens: 0 })).toThrow(/maxTokens must be a positive integer/)
    expect(declare({ maxTokens: 1.5 })).toThrow(/maxTokens must be a positive integer/)
  })

  it('refuses a discovered capacity that is not a positive integer', () => {
    expect(() => resolveModels(request(), [discovered({ contextWindow: 0 })]))
      .toThrow(/contextWindow must be a positive integer/)
    expect(() => resolveModels(request(), [discovered({ maxTokens: 0 })]))
      .toThrow(/maxTokens must be a positive integer/)
  })

  it('records only explicitly configured caps as the request default', () => {
    const { models, configuredMaxTokens } = resolveModels(request({
      api: 'openai-completions',
      models: [
        { id: 'capped', contextWindow: 1, maxTokens: 2048 },
        { id: 'bare' },
      ],
    }), [discovered({ id: 'bare', contextWindow: 1, maxTokens: 512 })])
    expect(configuredMaxTokens.get('capped')).toBe(2048)
    // A discovered or fallback cap is a capability, not a choice.
    expect(configuredMaxTokens.has('bare')).toBe(false)
    expect(models.find(model => model.id === 'bare')?.maxTokens).toBe(512)
  })
})

describe('input defaults', () => {
  it('falls back from entry to discovery to the route default', () => {
    const entry = modelOf({
      api: 'openai-completions',
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1, input: ['text', 'image'] }],
    })
    expect(entry.input).toEqual(['text', 'image'])

    const discoveredInput = modelOf(
      { api: 'openai-completions', models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }] },
      [discovered({ id: 'm', input: ['text', 'image'] })],
    )
    expect(discoveredInput.input).toEqual(['text', 'image'])

    const routeDefault = modelOf({
      api: 'openai-completions',
      defaultInput: ['text', 'image'],
      models: [{ id: 'm', contextWindow: 1, maxTokens: 1 }],
    })
    expect(routeDefault.input).toEqual(['text', 'image'])
  })
})

describe('modelInfo', () => {
  it('projects the advisory model info a selector needs', () => {
    const model = modelOf({
      api: 'openai-completions',
      models: [{
        id: 'acme-large',
        name: 'Acme Large',
        contextWindow: 1,
        maxTokens: 1,
        input: ['text', 'image'],
      }],
    })
    expect(modelInfo('acme-gateway', model)).toEqual({
      provider: 'acme-gateway',
      id: 'acme-large',
      name: 'Acme Large',
      inputModalities: ['text', 'image'],
    })
  })
})

describe('catalog constants', () => {
  it('declares the modalities, thinking levels, formats, and protocols', () => {
    expect(MODALITIES).toEqual(['text', 'image'])
    expect(THINKING_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(SUPPORTED_THINKING_FORMATS).toEqual([
      'openai',
      'deepseek',
      'openrouter',
      'together',
      'zai',
      'qwen',
      'string-thinking',
      'ant-ling',
    ])
    expect(SUPPORTED_PROTOCOLS).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  })
})
