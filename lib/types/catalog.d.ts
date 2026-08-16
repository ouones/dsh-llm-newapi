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
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm';
/** One request modality a New API model may accept. */
export type NewApiModality = 'text' | 'image';
/** Every request modality a profile may declare. */
export declare const MODALITIES: readonly ["text", "image"];
/** Reasoning levels a route or model may offer, in escalation order. */
export declare const THINKING_LEVELS: readonly ["low", "medium", "high", "xhigh", "max"];
export type NewApiThinkingLevel = typeof THINKING_LEVELS[number];
/** The `compat.thinkingFormat` spellings the OpenAI completions wire accepts. */
export type NewApiThinkingFormat = 'openai' | 'deepseek' | 'qwen' | 'zai' | 'openrouter' | 'together' | 'ant-ling' | 'string-thinking';
/** Reasoning-dispatch wire formats a profile may name, most-reached first. */
export declare const SUPPORTED_THINKING_FORMATS: readonly ["openai", "deepseek", "openrouter", "together", "zai", "qwen", "string-thinking", "ant-ling"];
/** Wire protocols a New API route may name. */
export declare const SUPPORTED_PROTOCOLS: readonly ["openai-completions", "openai-responses", "anthropic-messages"];
export type NewApiProtocol = typeof SUPPORTED_PROTOCOLS[number];
/**
 * Selectable reasoning efforts for one model: each key is a level the model
 * offers (and selectors show), and its value is the wire spelling dispatch
 * sends for it. The five core levels are typed; extra keys (e.g. the upstream
 * capability's `off`) pass through by convention rather than being promoted to
 * a fixed enum (see the LLM-adapter guidance). A valueless `off` means
 * "supported, send nothing"; every other declared level must name a wire value.
 */
export type NewApiReasoningEfforts = Partial<Record<NewApiThinkingLevel, string | null>> & Record<string, string | null>;
/**
 * Reasoning-dispatch compatibility switches for one model. Unlike pi-ai's
 * catalog, this is the COMPLETE compat surface — the plugin decides every
 * field, never the endpoint URL. `supportsDeveloperRole` defaults to false
 * and is the fix for the `role: "developer"` 400.
 */
export interface NewApiCompatProfile {
    /** Reasoning parameter format the endpoint expects. */
    thinkingFormat?: NewApiThinkingFormat;
    /** Whether the endpoint accepts `reasoning_effort`. */
    supportsReasoningEffort?: boolean;
    /**
     * Whether the endpoint accepts the OpenAI `developer` role for the system
     * prompt. Default false: New API relays to upstreams that overwhelmingly
     * accept only `user|assistant|tool`. A deployment whose upstream does
     * accept it may set true explicitly.
     */
    supportsDeveloperRole?: boolean;
    /** The output-token field name; New API/CommandCode use `max_tokens`. */
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
    /** Whether the endpoint accepts OpenAI's `store` parameter. New API does not. */
    supportsStore?: boolean;
    /** Whether the endpoint accepts Anthropic's long cache retention. */
    supportsLongCacheRetention?: boolean;
}
/** One configured model entry: an id plus the catalog fields it overrides. */
export interface NewApiModelProfile {
    /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
    id: string;
    /** Display name for selectors; defaults to the catalog name, then the id. */
    name?: string;
    /** Maximum combined request and response context in tokens. */
    contextWindow?: number;
    /** Maximum output tokens. Configuring one also makes it this model's per-request default. */
    maxTokens?: number;
    /** Request modalities this model accepts. Absent keeps the discovered entry's, then the route's `defaultInput`. */
    input?: NewApiModality[];
    /** Selectable reasoning efforts. Absent keeps the discovered entry's capability; `false` disables reasoning. */
    reasoningEfforts?: false | NewApiReasoningEfforts;
    /** Reasoning-dispatch switches for this model, winning over the route's. */
    compat?: NewApiCompatProfile;
}
/**
 * Customization of one discovered catalog model, keyed by its id in the
 * route's `modelOverrides` dict — the same fields a `models` entry may set,
 * with the id living in the key.
 */
export type NewApiModelOverride = Omit<NewApiModelProfile, 'id'>;
/** The model descriptor the adapter streams against. */
export interface NewApiModel {
    /** Model id sent to the provider. */
    id: string;
    /** Selector label. */
    name: string;
    /** Wire protocol this model speaks. */
    api: NewApiProtocol;
    /** Provider route key. */
    provider: string;
    /** Gateway root URL. */
    baseUrl: string;
    /** Request modalities this model accepts. */
    input: NewApiModality[];
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
    /** Output capability (never a per-request default by itself). */
    maxTokens: number;
    /** Whether the model reasons; false makes dispatch ignore the effort map. */
    reasoning: boolean;
    /** Level → wire spelling map; absent when the model does not reason. */
    thinkingLevelMap?: Record<string, string | null>;
    /** The compat block, forced by this plugin. */
    compat: NewApiCompatProfile;
}
/** The route-level facts model materialization reads. */
export interface RouteCatalogRequest {
    /** Provider route key, stamped onto every materialized model. */
    provider: string;
    /** Wire protocol override; absent defers to discovery's `supported_endpoint_types`. */
    api?: NewApiProtocol;
    /** Gateway root URL. */
    baseURL: string;
    /** Configured catalog; absent means the whole discovered catalog for this route. */
    models?: readonly NewApiModelProfile[];
    /** Discovered-catalog customizations by model id; only meaningful while `models` is absent. */
    modelOverrides?: Readonly<Record<string, NewApiModelOverride>>;
    /** Wire-protocol routing overrides by model id (regex source → protocol). */
    modelApiOverrides?: Readonly<Map<string, NewApiProtocol>>;
    /** Reasoning-dispatch switches for every `openai-completions` model on the route. */
    compat?: NewApiCompatProfile;
    /** Context capacity for a model neither the entry nor discovery sizes. */
    defaultContextWindow: number;
    /** Output capability for a model neither the entry nor discovery sizes. */
    defaultMaxTokens: number;
    /** Modalities for a model neither the entry nor discovery declares. */
    defaultInput: NewApiModality[];
}
/** One model a gateway listing disclosed about itself. */
export interface NewApiDiscoveredModel {
    /** Model id the endpoint accepts. */
    id: string;
    /** Display name when the listing supplies one. */
    name?: string;
    /** Wire protocols the gateway advertises (`supported_endpoint_types`). */
    endpoints?: readonly string[];
    /** Request modalities, when the listing discloses them. */
    input?: NewApiModality[];
    /** Maximum combined context, when disclosed. */
    contextWindow?: number;
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number;
    /** Whether the model reasons, when the listing discloses it. */
    reasoning?: boolean;
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
export declare function routeModelApi(id: string, discoveredEndpoints: readonly string[] | undefined, request: RouteCatalogRequest): NewApiProtocol | undefined;
/** One route's materialized catalog, plus the request caps its profile chose. */
export interface RouteCatalog {
    /** The materialized models in configuration order. */
    models: readonly NewApiModel[];
    /** Per-request output caps this profile explicitly configured, by model id. */
    configuredMaxTokens: ReadonlyMap<string, number>;
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
export declare function resolveModels(request: RouteCatalogRequest, discoveredModels?: readonly NewApiDiscoveredModel[]): RouteCatalog;
/** Build the advisory {@link LlmModelInfo} for one materialized model. */
export declare function modelInfo(provider: string, model: NewApiModel): LlmModelInfo;
