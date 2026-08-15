/**
 * Materialization of one provider route's model catalog for the New API
 * adapter. A route's models come from the gateway's `/v1/models` discovery
 * and/or configuration (`models`/`modelOverrides`); every model carries a
 * compat block the plugin owns outright.
 *
 * The reason this plugin exists: a New API gateway is a relay over arbitrary
 * upstreams, so its wire dialect cannot be guessed from a URL. In particular,
 * pi-ai's URL-derived detection assumes a standard OpenAI endpoint and sends
 * the system prompt as `role: "developer"` on reasoning models — which most
 * New API upstreams reject with HTTP 400. This catalog therefore FORCES the
 * safe compat on every model (`supportsDeveloperRole: false`,
 * `supportsStore: false`, `maxTokensField: 'max_tokens'`), overridable per
 * model or route only when the deployment knows its upstream accepts more.
 *
 * @module dsh-llm-newapi/catalog
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

/** One request modality a New API model may accept. */
export type NewApiModality = 'text' | 'image'

/** Every request modality a profile may declare. */
export const MODALITIES = ['text', 'image'] as const

/** Reasoning levels a route or model may offer, in escalation order. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type NewApiThinkingLevel = typeof THINKING_LEVELS[number]

/** The `compat.thinkingFormat` spellings the OpenAI completions wire accepts. */
export type NewApiThinkingFormat = 'openai' | 'deepseek' | 'qwen' | 'zai' | 'openrouter' | 'together' | 'ant-ling' | 'string-thinking'

/** Reasoning-dispatch wire formats a profile may name, most-reached first. */
export const SUPPORTED_THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'zai',
  'qwen',
  'string-thinking',
  'ant-ling',
] as const

/** Wire protocols a New API route may name. */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type NewApiProtocol = typeof SUPPORTED_PROTOCOLS[number]

/**
 * Selectable reasoning efforts for one model: each key is a level the model
 * offers (and selectors show), and its value is the wire spelling dispatch
 * sends for it. `off` alone may leave its value empty — "supported, send
 * nothing" — because for most providers not thinking is the parameter's
 * absence; every other declared level must name a wire value.
 */
export type NewApiReasoningEfforts = Partial<Record<NewApiThinkingLevel, string | null>>

/**
 * Reasoning-dispatch compatibility switches for one model. Unlike pi-ai's
 * catalog, this is the COMPLETE compat surface — the plugin decides every
 * field, never the endpoint URL. `supportsDeveloperRole` defaults to false
 * and is the fix for the `role: "developer"` 400.
 */
export interface NewApiCompatProfile {
  /** Reasoning parameter format the endpoint expects. */
  thinkingFormat?: NewApiThinkingFormat
  /** Whether the endpoint accepts `reasoning_effort`. */
  supportsReasoningEffort?: boolean
  /**
   * Whether the endpoint accepts the OpenAI `developer` role for the system
   * prompt. Default false: New API relays to upstreams that overwhelmingly
   * accept only `user|assistant|tool`. A deployment whose upstream does
   * accept it may set true explicitly.
   */
  supportsDeveloperRole?: boolean
  /** The output-token field name; New API/CommandCode use `max_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Whether the endpoint accepts OpenAI's `store` parameter. New API does not. */
  supportsStore?: boolean
  /** Whether the endpoint accepts Anthropic's long cache retention. */
  supportsLongCacheRetention?: boolean
}

/** One configured model entry: an id plus the catalog fields it overrides. */
export interface NewApiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens. Configuring one also makes it this model's per-request default. */
  maxTokens?: number
  /** Request modalities this model accepts. Absent keeps the discovered entry's, then the route's `defaultInput`. */
  input?: NewApiModality[]
  /** Selectable reasoning efforts. Absent keeps the discovered entry's capability; `false` disables reasoning. */
  reasoningEfforts?: false | NewApiReasoningEfforts
  /** Reasoning-dispatch switches for this model, winning over the route's. */
  compat?: NewApiCompatProfile
}

/**
 * Customization of one discovered catalog model, keyed by its id in the
 * route's `modelOverrides` dict — the same fields a `models` entry may set,
 * with the id living in the key.
 */
export type NewApiModelOverride = Omit<NewApiModelProfile, 'id'>

/** The model descriptor the adapter streams against. */
export interface NewApiModel {
  /** Model id sent to the provider. */
  id: string
  /** Selector label. */
  name: string
  /** Wire protocol this model speaks. */
  api: NewApiProtocol
  /** Provider route key. */
  provider: string
  /** Gateway root URL. */
  baseUrl: string
  /** Request modalities this model accepts. */
  input: NewApiModality[]
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
  /** Output capability (never a per-request default by itself). */
  maxTokens: number
  /** Whether the model reasons; false makes dispatch ignore the effort map. */
  reasoning: boolean
  /** Level → wire spelling map; absent when the model does not reason. */
  thinkingLevelMap?: Record<string, string | null>
  /** The compat block, forced by this plugin. */
  compat: NewApiCompatProfile
}

/** The route-level facts model materialization reads. */
export interface RouteCatalogRequest {
  /** Provider route key, stamped onto every materialized model. */
  provider: string
  /** Wire protocol override; absent defers to discovery's `supported_endpoint_types`. */
  api?: NewApiProtocol
  /** Gateway root URL. */
  baseURL: string
  /** Configured catalog; absent means the whole discovered catalog for this route. */
  models?: readonly NewApiModelProfile[]
  /** Discovered-catalog customizations by model id; only meaningful while `models` is absent. */
  modelOverrides?: Readonly<Record<string, NewApiModelOverride>>
  /** Wire-protocol routing overrides by model id (regex source → protocol). */
  modelApiOverrides?: Readonly<Map<string, NewApiProtocol>>
  /** Reasoning-dispatch switches for every `openai-completions` model on the route. */
  compat?: NewApiCompatProfile
  /** Context capacity for a model neither the entry nor discovery sizes. */
  defaultContextWindow: number
  /** Output capability for a model neither the entry nor discovery sizes. */
  defaultMaxTokens: number
  /** Modalities for a model neither the entry nor discovery declares. */
  defaultInput: NewApiModality[]
}

/** One model a gateway listing disclosed about itself. */
export interface NewApiDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Display name when the listing supplies one. */
  name?: string
  /** Wire protocols the gateway advertises (`supported_endpoint_types`). */
  endpoints?: readonly string[]
  /** Request modalities, when the listing discloses them. */
  input?: NewApiModality[]
  /** Maximum combined context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
  /** Whether the model reasons, when the listing discloses it. */
  reasoning?: boolean
}

/** Report a route the deployment cannot serve, naming the settings key at fault. */
function invalid(provider: string, detail: string): never {
  throw new Error(`llm-newapi: provider "${provider}" ${detail}`)
}

/**
 * Route one model id onto a wire protocol: a regex `modelApiOverrides` match
 * wins, then a configured route `api`, then the discovered
 * `supported_endpoint_types` (openai → completions, anthropic → messages).
 * @param id - the model id.
 * @param discoveredEndpoints - the gateway's advertised endpoint types.
 * @param request - the route-level routing facts.
 * @returns the protocol, or `undefined` when nothing decides it.
 */
export function routeModelApi(
  id: string,
  discoveredEndpoints: readonly string[] | undefined,
  request: RouteCatalogRequest,
): NewApiProtocol | undefined {
  for (const [source, api] of request.modelApiOverrides ?? []) {
    let regex: RegExp
    try {
      regex = new RegExp(source)
    } catch (error: unknown) {
      throw new Error(
        `llm-newapi: provider "${request.provider}" modelApiOverrides "${source}" is not a valid regular`
        + ` expression: ${String(error)}`,
      )
    }
    if (regex.test(id)) return api
  }
  if (request.api !== undefined) return request.api
  if (discoveredEndpoints === undefined) return undefined
  if (discoveredEndpoints.includes('openai')) return 'openai-completions'
  if (discoveredEndpoints.includes('anthropic')) return 'anthropic-messages'
  return undefined
}

/**
 * Resolve one model's reasoning capability from its declared efforts.
 * A declared dict translates to a `thinkingLevelMap` with every level decided
 * explicitly: declared levels carry their wire spelling, undeclared levels are
 * pinned to `null` (unsupported).
 * @param provider - provider route key, for diagnostics.
 * @param entry - the configured model entry.
 * @param discovered - the discovered catalog entry of the same id, when one exists.
 * @returns the reasoning fields the materialized model carries.
 */
function resolveModelReasoning(
  provider: string,
  entry: NewApiModelProfile,
  discovered: NewApiDiscoveredModel | undefined,
): Pick<NewApiModel, 'reasoning' | 'thinkingLevelMap'> {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined) {
    return { reasoning: discovered?.reasoning ?? false }
  }
  if (efforts === false) return { reasoning: false }
  if ((efforts as unknown) === null || Object.keys(efforts).length === 0) {
    invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set`
      + ' false for a non-reasoning model, or omit the field to keep the discovered capability')
  }
  const declared = THINKING_LEVELS.flatMap((level) => {
    const wire = efforts[level]
    return wire === undefined ? [] : [[level, wire] as const]
  })
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== 'off') {
        invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch`
          + ' should send; only "off" may leave it empty')
      }
    } else if (wire.length === 0) {
      invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`)
    }
  }
  if (!declared.some(([level]) => level !== 'off')) {
    invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking`
      + ' level, or set reasoningEfforts to false for a non-reasoning model')
  }
  const map: Record<string, string | null> = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) {
      map[level] = null
    } else if (wire !== null) {
      map[level] = wire
    }
  }
  return { reasoning: true, thinkingLevelMap: map }
}

/**
 * The compat block for one materialized model. The plugin FORCES the safe
 * defaults on every model — the reason llm-newapi exists — and lets an
 * explicit configuration override them per field. Model-level switches win
 * over the route's; a route-level default applies to every model on the route.
 * @param entry - the configured model entry.
 * @param route - the route-level switches, when any.
 * @returns the resolved compat block with the three forced defaults decided.
 */
function resolveModelCompat(
  entry: NewApiModelProfile,
  route: NewApiCompatProfile | undefined,
): NewApiCompatProfile {
  // The configured value wins per field; what neither sets is forced here —
  // the plugin's reason to exist. `thinkingFormat` and
  // `supportsReasoningEffort` are wire facts a gateway cannot be trusted to
  // guess, so an unset field stays absent and the serializer's own defaults
  // answer (plain OpenAI dialect, effort accepted).
  const thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat
  const supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort
  const supportsLongCacheRetention = entry.compat?.supportsLongCacheRetention ?? route?.supportsLongCacheRetention
  return {
    ...thinkingFormat === undefined ? {} : { thinkingFormat },
    ...supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort },
    supportsDeveloperRole: entry.compat?.supportsDeveloperRole ?? route?.supportsDeveloperRole ?? false,
    maxTokensField: entry.compat?.maxTokensField ?? route?.maxTokensField ?? 'max_tokens',
    supportsStore: entry.compat?.supportsStore ?? route?.supportsStore ?? false,
    ...supportsLongCacheRetention === undefined ? {} : { supportsLongCacheRetention },
  }
}

/** One route's materialized catalog, plus the request caps its profile chose. */
export interface RouteCatalog {
  /** The materialized models in configuration order. */
  models: readonly NewApiModel[]
  /** Per-request output caps this profile explicitly configured, by model id. */
  configuredMaxTokens: ReadonlyMap<string, number>
}

/**
 * Materialize one route's catalog by merging the discovered catalog defaults
 * under the configured entries. A configured `models` list replaces the
 * discovered set entirely (each entry still defaults its unset fields from the
 * discovered model of the same id); `modelOverrides` reshape individual
 * discovered entries. A route with neither configured models nor any
 * discovered entry is refused — a New API gateway's models are never guessable.
 * @param request - the route-level catalog facts.
 * @param discoveredModels - models the gateway disclosed; empty when discovery
 *   has not answered yet or failed (the route then serves only configured models).
 * @returns the materialized models and the explicitly configured request caps.
 */
export function resolveModels(
  request: RouteCatalogRequest,
  discoveredModels: readonly NewApiDiscoveredModel[] = [],
): RouteCatalog {
  const { provider } = request
  const discovered = new Map(discoveredModels.map(model => [model.id, model]))
  const overrides = request.modelOverrides ?? {}
  // An override that lands nowhere is a typo someone would hunt for in a
  // silently unchanged model. Only refused when discovery answered: without
  // it there is no catalog to name a miss against, and the configured models
  // path below still serves.
  if (discovered.size > 0) {
    for (const [id, override] of Object.entries(overrides)) {
      if (id.length === 0) invalid(provider, 'has a modelOverrides entry with an empty model id')
      if (!discovered.has(id)) {
        invalid(provider, `modelOverrides names "${id}", which the discovered catalog does not describe`)
      }
      if ('id' in override) {
        invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`)
      }
    }
  }
  const configured = request.models
  const entries: readonly NewApiModelProfile[] = configured !== undefined && configured.length > 0
    ? configured
    : [...discovered.values()].map(model => ({ id: model.id, ...overrides[model.id] }))
  if (entries.length === 0) {
    invalid(provider, 'resolves no models; the gateway disclosed none and no models are listed in configuration')
  }
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = entries.map((entry) => {
    if (entry.id.length === 0) invalid(provider, 'has a model with an empty id')
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`)
    seen.add(entry.id)
    const base = discovered.get(entry.id)
    const api = routeModelApi(entry.id, base?.endpoints, request)
    if (api === undefined) {
      invalid(provider, `model "${entry.id}" needs an api; discovery did not advertise one, so set the`
        + ' route\'s api or a modelApiOverrides entry')
    }
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`)
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`)
    }
    if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)
    return {
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl: request.baseURL,
      input: entry.input ?? base?.input ?? [...request.defaultInput],
      contextWindow,
      maxTokens,
      ...resolveModelReasoning(provider, entry, base),
      compat: resolveModelCompat(entry, request.compat),
    }
  })
  return { models, configuredMaxTokens }
}

/** Build the advisory {@link LlmModelInfo} for one materialized model. */
export function modelInfo(provider: string, model: NewApiModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
  }
}
