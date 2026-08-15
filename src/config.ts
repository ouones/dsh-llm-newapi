/**
 * Configuration schema and provider-profile resolution for the New API adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider and the route set is structural.
 *
 * A route names a self-hosted New API gateway. The gateway speaks OpenAI
 * Chat Completions and/or Anthropic Messages; a route declares its endpoint
 * and the wire protocol(s) its models speak. Model metadata — capacities,
 * reasoning, compat — is declared in configuration or discovered from the
 * gateway's `/v1/models` listing; nothing is guessed from the endpoint URL.
 *
 * @module dsh-llm-newapi/config
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MODALITIES, resolveModels, SUPPORTED_PROTOCOLS, SUPPORTED_THINKING_FORMATS, THINKING_LEVELS } from './catalog.ts'
import type {
  NewApiCompatProfile,
  NewApiModality,
  NewApiModelOverride,
  NewApiModelProfile,
  NewApiReasoningEfforts,
} from './catalog.ts'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Context capacity assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Output capability assumed for a model neither configuration nor discovery sizes. */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * Modalities assumed for a model neither configuration nor discovery
 * declares. Text is the floor every supported protocol certainly carries.
 */
export const DEFAULT_INPUT: readonly NewApiModality[] = ['text']

export type {
  NewApiCompatProfile,
  NewApiModality,
  NewApiModelOverride,
  NewApiModelProfile,
  NewApiReasoningEfforts,
  NewApiThinkingFormat,
} from './catalog.ts'

/** Wire protocols a New API route may name, mapped to their request serializers. */
export type NewApiProtocol = typeof SUPPORTED_PROTOCOLS[number]

/** Configuration for one New API provider route; the `providers` dict key IS the route. */
export interface NewApiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /** Gateway root URL, without a trailing slash or protocol path (e.g. `https://gateway.example.com`). */
  baseURL: string
  /**
   * Wire protocol every model on this route speaks. Omission routes each model
   * by its discovered `supported_endpoint_types`, falling back to
   * `modelApiOverrides`; a route whose models cannot be routed must name one.
   */
  api?: NewApiProtocol
  /**
   * This route's model catalog. Omission serves the discovered catalog;
   * an explicit list replaces it, each entry defaulting its unset fields
   * from the discovered model of the same id.
   */
  models?: NewApiModelProfile[]
  /**
   * Discovered-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched.
   */
  modelOverrides?: Record<string, NewApiModelOverride>
  /**
   * Wire-protocol routing overrides by model id: a regular expression that,
   * when it matches a model id, forces that model onto the named protocol.
   * Wins over `supported_endpoint_types`.
   */
  modelApiOverrides?: Record<string, NewApiProtocol>
  /** Reasoning-dispatch switches for every `openai-completions` model on this route. */
  compat?: NewApiCompatProfile
  /** Context capacity for a model this route lists that neither the entry nor discovery sizes (default 262,144). */
  defaultContextWindow?: number
  /** Output capability for a model this route lists that neither the entry nor discovery sizes (default 32,768). */
  defaultMaxTokens?: number
  /** Request modalities for a model this route lists that neither its entry's `input` nor discovery declares (default `[text]`). */
  defaultInput?: NewApiModality[]
  /** Provider request headers; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral reasoning level applied to requests that name none. */
  reasoning?: NewApiReasoningEfforts
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: Record<string, number>
  /** HTTP timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

/** Validated profile with its route stamped and every adapter-owned default resolved. */
export interface ResolvedNewApiProviderProfile {
  /** Harness route key. */
  provider: string
  /** Resolved display name for selectors and configuration surfaces. */
  displayName: string
  /** Gateway root URL. */
  baseURL: string
  /** Wire protocol override, when one is configured. */
  api?: NewApiProtocol
  /** Wire-protocol routing overrides by model id (regex source → protocol). */
  modelApiOverrides: ReadonlyMap<string, NewApiProtocol>
  /** Validated credential reference, when one is configured. */
  apiKeyEnv?: CredentialRef
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
  /** The materialized model catalog (discovered + configured, compat injected). */
  models: readonly import('./catalog.ts').NewApiModel[]
  /** Per-request output caps this profile explicitly configured, by model id. */
  configuredMaxTokens: ReadonlyMap<string, number>
  /** Route-level reasoning default. */
  reasoning?: NewApiReasoningEfforts
  /** Route-level thinking budgets. */
  thinkingBudgets?: Readonly<Record<string, number>>
  /** Route-level timeout. */
  timeoutMs?: number
  /** Provider request headers; attribution wins collisions. */
  headers?: Readonly<Record<string, string>>
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * New API provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers?: Record<string, NewApiProviderProfile>
}

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

const compatProfile: z<NewApiCompatProfile> = z.object({
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  supportsReasoningEffort: z.boolean(),
  // Default false: New API is a gateway over arbitrary upstreams, and most
  // reject the OpenAI `developer` role. The value is a wire fact the plugin
  // owns, not something an endpoint URL can be trusted to guess.
  supportsDeveloperRole: z.boolean().default(false),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']),
  supportsStore: z.boolean(),
  supportsLongCacheRetention: z.boolean(),
})

/**
 * Keys are the offered levels, values their wire spellings. A valueless key
 * (`off:`) survives validation because schemastery passes nullable data
 * through before any member schema runs.
 */
const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS),
) as unknown as z<NewApiReasoningEfforts>

/** The fields a `models` entry and a `modelOverrides` value share; only the id's home differs. */
const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(MODALITIES)),
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: compatProfile,
}

const modelProfile: z<NewApiModelProfile> = z.object({
  id: z.string().required(),
  ...modelFields,
})

/** A {@link modelProfile} whose id lives in the `modelOverrides` dict key. */
const modelOverride: z<NewApiModelOverride> = z.object(modelFields)

const profile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  baseURL: z.string().required(),
  api: z.union(SUPPORTED_PROTOCOLS),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  modelApiOverrides: z.dict(z.union(SUPPORTED_PROTOCOLS)),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: reasoningEfforts,
  thinkingBudgets,
  timeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.dict(profile).default({}),
})

/**
 * Reject a section this adapter could not serve. Registered as the settings
 * namespace's validator, so an unserviceable profile is refused where it is
 * *written* instead of being stored and then quietly disabling every route
 * in the namespace.
 * @param config - the resolved section to check.
 * @throws Error naming the route and model that cannot be served.
 */
export function assertServiceable(config: Config): void {
  resolveProfiles(config.providers)
}

/**
 * Validate profiles and return a detached route-keyed map suitable for
 * per-request reads. This is the one explicit resolve step: an omitted dict
 * resolves to the empty (dormant) route set, and each route's models are
 * materialized once with compat injected.
 * @param providers - configured provider profiles keyed by route.
 * @returns validated profiles in configuration order.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, NewApiProviderProfile>> | undefined,
): Map<string, ResolvedNewApiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-newapi: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedNewApiProviderProfile>()
  for (const [provider, source] of entries) {
    if (provider.length === 0) throw new Error('llm-newapi: provider names must be non-empty')
    if (source.baseURL.length === 0) {
      throw new Error(`llm-newapi: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-newapi: provider "${provider}" has an empty displayName`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-newapi: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT]
    if (defaultInput.length === 0) {
      throw new Error(`llm-newapi: provider "${provider}" defaultInput must name at least one modality`)
    }
    const displayName = source.displayName ?? provider
    const modelApiOverrides = new Map(Object.entries(source.modelApiOverrides ?? {}))
    const catalog = resolveModels({
      provider,
      ...source.api === undefined ? {} : { api: source.api },
      baseURL: source.baseURL,
      ...source.models === undefined ? {} : { models: source.models },
      ...source.modelOverrides === undefined ? {} : { modelOverrides: source.modelOverrides },
      ...source.modelApiOverrides === undefined ? {} : { modelApiOverrides },
      ...source.compat === undefined ? {} : { compat: source.compat },
      defaultInput,
      defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source
    resolved.set(provider, {
      provider,
      displayName,
      baseURL: source.baseURL,
      ...source.api === undefined ? {} : { api: source.api },
      modelApiOverrides,
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-newapi: provider "${provider}" retryPolicy`),
      models: catalog.models,
      configuredMaxTokens: catalog.configuredMaxTokens,
      ...rest.reasoning === undefined ? {} : { reasoning: rest.reasoning },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      ...rest.timeoutMs === undefined ? {} : { timeoutMs: rest.timeoutMs },
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
    })
  }
  return resolved
}
