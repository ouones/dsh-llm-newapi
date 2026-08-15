/**
 * New API adapter: streams model calls through the harness LLM seam against a
 * self-hosted New API gateway, speaking OpenAI Chat Completions and Anthropic
 * Messages directly over fetch.
 *
 * Each operation reads the current resolved profiles, so a configuration
 * change reaches the next request without a restart; model descriptors come
 * from the catalog those profiles built.
 *
 * @module dsh-llm-newapi/adapter
 */

import { attributionHeaders, contentHasImage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { modelInfo, type NewApiModel } from './catalog.ts'
import type { NewApiReasoningEfforts } from './catalog.ts'
import type { ResolvedNewApiProviderProfile } from './config.ts'
import { serializeAnthropicRequest, serializeChatRequest, type WireModel } from './serialize.ts'
import { parseSse, translateAnthropic, translateChat } from './stream.ts'

/** One resolution's frozen view: the profiles and the catalog built from them. */
interface NewApiSnapshot {
  /** The resolved profiles this catalog was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedNewApiProviderProfile>
}

/** Constructor options for {@link NewApiAdapter}: the resolution hooks the plugin owns. */
export interface NewApiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedNewApiProviderProfile>
  /**
   * Resolve the bearer token for one already-resolved profile; called once
   * per stream call and frozen for that call. Throws `LlmError`
   * `MISSING_CREDENTIAL` when a named reference misses.
   */
  resolveApiKey: (provider: string, profile: ResolvedNewApiProviderProfile) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** The route-level reasoning default this model can actually take, for describing it. */
function describableReasoningLevel(
  model: NewApiModel,
  effort: NewApiReasoningEfforts | undefined,
): string | undefined {
  if (effort === undefined || !model.reasoning) return undefined
  const offered = Object.keys(effort)
  return offered.length > 0 ? offered[0] : undefined
}

/** The compat block as the serializers read it (every forced field decided). */
function wireModelOf(model: NewApiModel): WireModel {
  return {
    api: model.api,
    compat: model.compat,
    baseUrl: model.baseUrl,
    maxTokens: model.maxTokens,
  }
}

/** Resolve the harness effort against the model's offered levels and wire spellings. */
function resolveReasoningEffort(
  model: NewApiModel,
  profile: ResolvedNewApiProviderProfile,
  requested: string | undefined,
): { wire: string | undefined; offered: boolean } {
  const map = model.thinkingLevelMap
  if (map === undefined || !model.reasoning) return { wire: undefined, offered: false }
  const level = requested ?? Object.keys(profile.reasoning ?? {})[0]
  if (level === undefined) return { wire: undefined, offered: false }
  const wire = map[level]
  if (wire === null || wire === undefined) {
    // `off` is "supported, send nothing".
    if (level === 'off') return { wire: undefined, offered: true }
    throw new LlmError(
      `New API provider "${model.provider}" model "${model.id}" does not support reasoning effort "${level}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return { wire, offered: true }
}

/** The selectable reasoning efforts for one model, or nothing. */
function reasoningInfo(
  model: NewApiModel,
  defaultLevel: string | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning || model.thinkingLevelMap === undefined) return {}
  const levels = Object.keys(model.thinkingLevelMap).filter((level) => {
    const wire = model.thinkingLevelMap?.[level]
    return wire !== null && wire !== undefined
  })
  if (levels.length === 0) return {}
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * New API-backed adapter. Each operation reads the current profiles, so a
 * configuration change reaches the next request without a restart; model
 * descriptors come from the catalog those profiles built.
 */
export class NewApiAdapter extends LlmAdapter {
  private snapshot: NewApiSnapshot | undefined

  constructor(private readonly config: NewApiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity.
   */
  private current(): NewApiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    this.snapshot = { profiles }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: NewApiSnapshot, provider: string): ResolvedNewApiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`newapi adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: NewApiSnapshot, provider: string, model: string): NewApiModel {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.profiles.get(provider)?.models.find(entry => entry.id === model)
    if (resolved === undefined) {
      throw new LlmError(`newapi provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      const models = snapshot.profiles.get(provider)?.models ?? []
      return models.map(model => modelInfo(provider, model))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-newapi does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the credential all come from the same immutable
    // snapshot. A configuration change mid-request builds a separate snapshot,
    // so this request finishes under the one it started with.
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningEffort(model, profile, options.reasoningEffort?.toString())
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`newapi model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('newapi image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      // Image support is declared per model; this adapter's wire routes are
      // text-only, so image-capable models still cannot be served.
      if (containsImage) {
        throw new LlmError('newapi wire routes are text-only', 'UNSUPPORTED_CONTENT')
      }

      const url = model.api === 'anthropic-messages'
        ? `${model.baseUrl.replace(/\/+$/, '')}/v1/messages`
        : `${model.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...requestHeaders(profile.headers),
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      }
      if (model.api === 'anthropic-messages') {
        headers['anthropic-version'] = '2023-06-01'
      }
      const body = model.api === 'anthropic-messages'
        ? serializeAnthropicRequest(options, wireModelOf(model), reasoning.wire)
        : serializeChatRequest(options, wireModelOf(model), reasoning.wire)

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error: unknown) {
        if (watchdog.signal.aborted || options.signal?.aborted) {
          throw new LlmError('newapi request aborted by caller', 'ABORTED', { cause: error })
        }
        throw new LlmError(`could not reach ${url}`, 'TRANSPORT', { cause: error })
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = text.length > 0 ? `${url} answered ${response.status}: ${text.slice(0, 200)}` : `${url} answered ${response.status}`
        const code = response.status === 401 || response.status === 403 ? 'AUTH'
          : response.status === 429 ? 'RATE_LIMIT'
            : response.status >= 500 ? 'SERVER'
              : 'INVALID_REQUEST'
        throw new LlmError(message, code, { status: response.status })
      }
      if (response.body === null) {
        throw new LlmError(`${url} returned no response body`, 'TRANSPORT')
      }

      const payloads = parseSse(response.body)
      const iterator = (model.api === 'anthropic-messages'
        ? translateAnthropic(payloads)
        : translateChat(payloads))[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('newapi stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns teardown; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`newapi stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('newapi request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('newapi stream consumer stopped')
    }
  }
}
