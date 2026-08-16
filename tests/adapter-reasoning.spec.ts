import { describe, expect, it } from 'vitest'
import { NewApiAdapter, resolveReasoningEffort } from '../src/adapter.ts'
import type { NewApiModel } from '../src/catalog.ts'
import type { NewApiReasoningEfforts } from '../src/catalog.ts'
import type { ResolvedNewApiProviderProfile } from '../src/config.ts'

/** A reasoning-capable model: the five core levels plus a pass-through `off`. */
function model(map: Record<string, string | null>, provider = 'p', id = 'm'): NewApiModel {
  return {
    provider, id, name: id, reasoning: true, thinkingLevelMap: map,
    input: ['text'], contextWindow: 1, maxTokens: 1, api: 'openai-completions',
  } as NewApiModel
}

function profile(reasoning?: NewApiReasoningEfforts): ResolvedNewApiProviderProfile {
  return { reasoning } as ResolvedNewApiProviderProfile
}

describe('resolveReasoningEffort: send-nothing `off` pass-through', () => {
  const fivePlusOff = model({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', off: null })

  it('treats `off` as "supported, send nothing" instead of throwing', () => {
    expect(resolveReasoningEffort(fivePlusOff, profile(), 'off')).toEqual({ wire: undefined, offered: true })
  })

  it('still throws for a level that is genuinely unsupported', () => {
    expect(() => resolveReasoningEffort(fivePlusOff, profile(), 'nope'))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})

describe('resolveReasoningEffort: default level', () => {
  const five = model({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })

  it('defaults to medium when the request names no effort and medium is offered', () => {
    expect(resolveReasoningEffort(five, profile({ medium: 'medium' }), undefined)).toEqual({ wire: 'medium', offered: true })
  })

  it('resolves an explicitly requested core level to its wire value', () => {
    expect(resolveReasoningEffort(five, profile(), 'high')).toEqual({ wire: 'high', offered: true })
  })
})

describe('NewApiAdapter.resolveModel: default effort falls back to an offered level', () => {
  /** A model whose thinkingLevelMap lacks medium but offers low/high. */
  const noMediumModel = model({ low: 'low', high: 'high' })

  it('does not set defaultEffort to medium when the model does not offer it', async () => {
    const route: ResolvedNewApiProviderProfile = {
      reasoning: { medium: 'medium' },
      baseURL: 'https://g',
      configuredMaxTokens: new Map(),
      models: [noMediumModel],
    } as unknown as ResolvedNewApiProviderProfile
    const adapter = new NewApiAdapter({ profiles: () => new Map([['p', route]]), resolveApiKey: async () => undefined })
    const info = await adapter.resolveModel('p', 'm')
    expect(info.reasoning?.efforts.map(e => e.id.toString())).toEqual(['low', 'high'])
    // The declared route default (medium) is not offered, so it falls back to
    // the model's first offered level rather than pointing at an absent one.
    expect(info.reasoning?.defaultEffort?.toString()).toBe('low')
  })

  it('leaves defaultEffort absent when the route declares no reasoning default', async () => {
    const route: ResolvedNewApiProviderProfile = {
      baseURL: 'https://g',
      configuredMaxTokens: new Map(),
      models: [model({ medium: 'medium', high: 'high' })],
    } as unknown as ResolvedNewApiProviderProfile
    const adapter = new NewApiAdapter({ profiles: () => new Map([['p', route]]), resolveApiKey: async () => undefined })
    const info = await adapter.resolveModel('p', 'm')
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })
})
