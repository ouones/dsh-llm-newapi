/**
 * New API gateway LLM adapter plugin. One plugin instance owns a dict of
 * provider routes, each naming a self-hosted New API gateway. Profile facts
 * resolve per request over the optional `llm-newapi` user-settings section and
 * the optional credential seam, so a changed key, endpoint, model, or knob
 * reaches the next request without a restart; a changed *route set* (or a
 * route's registration-captured retry policy) re-registers the same adapter
 * instance in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-newapi'
 *   config:
 *     providers:
 *       my-gateway:
 *         displayName: My New API Gateway
 *         apiKeyEnv: NEWAPI_TEST_TOKEN
 *         baseURL: https://gateway.example.com
 *         # Optional: force a protocol for models the gateway does not advertise.
 *         api: openai-completions
 *         reasoningEfforts:
 *           low: low
 *           medium: medium
 *           high: high
 *           xhigh: xhigh
 *           max: max
 *         compat:
 *           # Forced defaults: supportsDeveloperRole: false, supportsStore: false,
 *           # maxTokensField: max_tokens. Override only when the upstream accepts more.
 * ```
 *
 * @module @deepseek-ai/dsh-llm-newapi
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { NewApiAdapter } from './adapter.ts'
import { assertServiceable, Config, resolveProfiles } from './config.ts'
import type { ResolvedNewApiProviderProfile } from './config.ts'
import { discoverModels } from './discovery.ts'
import { installLlmNewapiWeb } from './web.ts'

export { NewApiAdapter } from './adapter.ts'
export type { NewApiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  NewApiCompatProfile,
  NewApiModality,
  NewApiModelOverride,
  NewApiModelProfile,
  NewApiProviderProfile,
  NewApiReasoningEfforts,
  NewApiThinkingFormat,
  ResolvedNewApiProviderProfile,
} from './config.ts'

export const name = 'llm-newapi'
export const inject = ['llm']

const NS = settingsNamespace('llm-newapi')

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedNewApiProviderProfile>): unknown {
  return [...profiles.entries()]
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every route the current profiles
 * declare. The profile half is unconditional, which is what keeps a route
 * already stored against a withheld provider editable and deletable rather
 * than stranded in the settings document with nothing on the page to remove it.
 * @param profiles - the currently resolved provider profiles.
 * @returns the directory entries in declaration order.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedNewApiProviderProfile>,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  for (const [provider, profile] of profiles) {
    entries.set(provider, {
      provider,
      displayName: profile.displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
      declared: true,
    })
  }
  return [...entries.values()]
}

/** Register one New API adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedNewApiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   */
  const profiles = (): ReadonlyMap<string, ResolvedNewApiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers)
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedNewApiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all is unauthenticated.
    // Once one is named, a miss must fail loud: handing the gateway
    // `undefined` would let it authenticate anonymously, billing another
    // tenant for a request the deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-newapi', ref)
    throw new LlmError(
      `llm-newapi: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this gateway should authenticate anonymously',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new NewApiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles())
    if (deepEqualJson(entries, directoryFacts)) return
    // Dormant mount: no route, no directory registration. The runtime refuses
    // an empty initial registration, so nothing is registered until a settings
    // section supplies profiles — and an emptied section withdraws the entries
    // through `replace([])`, which is legal on a live registration.
    if (entries.length === 0) {
      directory?.replace([])
      directoryFacts = entries
      return
    }
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares would otherwise leave this plugin's whole
    // directory withdrawn and the Models page empty.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()

  const storedApiKey = async (provider: string | undefined): Promise<string | undefined> => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return resolveApiKey(provider, profile)
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet.
  ctx.llm.registerModelDiscovery(NS, request => discoverModels(request, storedApiKey))

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    // Refuse an unserviceable section where it is written.
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-newapi: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('llm-newapi: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })

  // Web-profile Settings panel routes: model candidates come straight from the
  // gateway's /v1/models listing, and the browser edits the same settings seam.
  installLlmNewapiWeb(ctx, {
    storedApiKey,
    discover: (baseURL, apiKey, provider) => discoverModels({
      baseURL,
      ...apiKey === undefined ? {} : { apiKey },
      ...provider === undefined ? {} : { provider },
    }),
  })
}
