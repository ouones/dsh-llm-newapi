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
import z from '@deepseek-ai/schemastery';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import { SUPPORTED_PROTOCOLS } from './catalog.ts';
import type { NewApiCompatProfile, NewApiModality, NewApiModelOverride, NewApiModelProfile, NewApiReasoningEfforts } from './catalog.ts';
/** Default maximum idle interval while an adapter stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Context capacity assumed for a model neither configuration nor discovery sizes. */
export declare const DEFAULT_CONTEXT_WINDOW = 262144;
/** Output capability assumed for a model neither configuration nor discovery sizes. */
export declare const DEFAULT_MAX_TOKENS = 32768;
/**
 * Modalities assumed for a model neither configuration nor discovery
 * declares. Text is the floor every supported protocol certainly carries.
 */
export declare const DEFAULT_INPUT: readonly NewApiModality[];
export type { NewApiCompatProfile, NewApiModality, NewApiModelOverride, NewApiModelProfile, NewApiReasoningEfforts, NewApiThinkingFormat, } from './catalog.ts';
/** Wire protocols a New API route may name, mapped to their request serializers. */
export type NewApiProtocol = typeof SUPPORTED_PROTOCOLS[number];
/** Configuration for one New API provider route; the `providers` dict key IS the route. */
export interface NewApiProviderProfile {
    /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
    apiKeyEnv?: string;
    /** Name shown by configuration surfaces; defaults to the route key. */
    displayName?: string;
    /** Gateway root URL, without a trailing slash or protocol path (e.g. `https://gateway.example.com`). */
    baseURL: string;
    /**
     * Wire protocol every model on this route speaks. Omission routes each model
     * by its discovered `supported_endpoint_types`, falling back to
     * `modelApiOverrides`; a route whose models cannot be routed must name one.
     */
    api?: NewApiProtocol;
    /**
     * This route's model catalog. Omission serves the discovered catalog;
     * an explicit list replaces it, each entry defaulting its unset fields
     * from the discovered model of the same id.
     */
    models?: NewApiModelProfile[];
    /**
     * Discovered-catalog customizations by model id: each entry reshapes that
     * one model with the same fields a {@link models} entry takes, while the
     * rest of the catalog keeps serving untouched.
     */
    modelOverrides?: Record<string, NewApiModelOverride>;
    /**
     * Wire-protocol routing overrides by model id: a regular expression that,
     * when it matches a model id, forces that model onto the named protocol.
     * Wins over `supported_endpoint_types`.
     */
    modelApiOverrides?: Record<string, NewApiProtocol>;
    /** Reasoning-dispatch switches for every `openai-completions` model on this route. */
    compat?: NewApiCompatProfile;
    /** Context capacity for a model this route lists that neither the entry nor discovery sizes (default 262,144). */
    defaultContextWindow?: number;
    /** Output capability for a model this route lists that neither the entry nor discovery sizes (default 32,768). */
    defaultMaxTokens?: number;
    /** Request modalities for a model this route lists that neither its entry's `input` nor discovery declares (default `[text]`). */
    defaultInput?: NewApiModality[];
    /** Provider request headers; Harness attribution wins reserved names. */
    headers?: Record<string, string>;
    /** Provider-neutral reasoning level applied to requests that name none. */
    reasoning?: NewApiReasoningEfforts;
    /** Token budgets used by reasoning providers that support them. */
    thinkingBudgets?: Record<string, number>;
    /** HTTP timeout in milliseconds. */
    timeoutMs?: number;
    /** Maximum provider idle time while one stream read is outstanding. */
    streamIdleTimeoutMs?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
/** Validated profile with its route stamped and every adapter-owned default resolved. */
export interface ResolvedNewApiProviderProfile {
    /** Harness route key. */
    provider: string;
    /** Resolved display name for selectors and configuration surfaces. */
    displayName: string;
    /** Gateway root URL. */
    baseURL: string;
    /** Wire protocol override, when one is configured. */
    api?: NewApiProtocol;
    /** Wire-protocol routing overrides by model id (regex source → protocol). */
    modelApiOverrides: ReadonlyMap<string, NewApiProtocol>;
    /** Validated credential reference, when one is configured. */
    apiKeyEnv?: CredentialRef;
    /** Positive finite provider-idle interval after defaulting. */
    streamIdleTimeoutMs: number;
    /** Immutable retry policy captured with this provider route. */
    retryPolicy: ResolvedRetryPolicy;
    /** The materialized model catalog (discovered + configured, compat injected). */
    models: readonly import('./catalog.ts').NewApiModel[];
    /** Per-request output caps this profile explicitly configured, by model id. */
    configuredMaxTokens: ReadonlyMap<string, number>;
    /** Route-level reasoning default. */
    reasoning?: NewApiReasoningEfforts;
    /** Route-level thinking budgets. */
    thinkingBudgets?: Readonly<Record<string, number>>;
    /** Route-level timeout. */
    timeoutMs?: number;
    /** Provider request headers; attribution wins collisions. */
    headers?: Readonly<Record<string, string>>;
}
/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
    /**
     * New API provider routes, keyed by provider. An empty (or omitted) dict is
     * the dormant settings-driven posture: the adapter mounts with no routes
     * and registers them the moment a settings section supplies profiles.
     */
    providers?: Record<string, NewApiProviderProfile>;
}
/** Runtime schema for {@link Config}. */
export declare const Config: z<Config>;
/**
 * Reject a section this adapter could not serve. Registered as the settings
 * namespace's validator, so an unserviceable profile is refused where it is
 * *written* instead of being stored and then quietly disabling every route
 * in the namespace.
 * @param config - the resolved section to check.
 * @throws Error naming the route and model that cannot be served.
 */
export declare function assertServiceable(config: Config): void;
/**
 * Validate profiles and return a detached route-keyed map suitable for
 * per-request reads. This is the one explicit resolve step: an omitted dict
 * resolves to the empty (dormant) route set, and each route's models are
 * materialized once with compat injected.
 * @param providers - configured provider profiles keyed by route.
 * @returns validated profiles in configuration order.
 */
export declare function resolveProfiles(providers: Readonly<Record<string, NewApiProviderProfile>> | undefined): Map<string, ResolvedNewApiProviderProfile>;
