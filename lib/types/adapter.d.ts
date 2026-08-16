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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { type NewApiModel } from './catalog.ts';
import type { ResolvedNewApiProviderProfile } from './config.ts';
/** Constructor options for {@link NewApiAdapter}: the resolution hooks the plugin owns. */
export interface NewApiAdapterOptions {
    /** Current validated profiles by provider route; called once per operation. */
    profiles: () => ReadonlyMap<string, ResolvedNewApiProviderProfile>;
    /**
     * Resolve the bearer token for one already-resolved profile; called once
     * per stream call and frozen for that call. Throws `LlmError`
     * `MISSING_CREDENTIAL` when a named reference misses.
     */
    resolveApiKey: (provider: string, profile: ResolvedNewApiProviderProfile) => Promise<string | undefined>;
    /** Resolve the optional durable attachment service at request time. */
    resolveAttachments?: () => AttachmentStore | undefined;
}
/** Resolve the harness effort against the model's offered levels and wire spellings. */
export declare function resolveReasoningEffort(model: NewApiModel, profile: ResolvedNewApiProviderProfile, requested: string | undefined): {
    wire: string | undefined;
    offered: boolean;
};
/**
 * New API-backed adapter. Each operation reads the current profiles, so a
 * configuration change reaches the next request without a restart; model
 * descriptors come from the catalog those profiles built.
 */
export declare class NewApiAdapter extends LlmAdapter {
    private readonly config;
    private snapshot;
    constructor(config: NewApiAdapterOptions);
    /**
     * The snapshot for the current profiles. Resolution memoizes its result, so
     * an unchanged configuration is recognized by identity.
     */
    private current;
    /** The profile for one route within one snapshot, or the not-owned failure. */
    private profileOf;
    /** The configured descriptor for one exact route/model pair within one snapshot. */
    private modelOf;
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
