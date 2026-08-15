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
 *           off:
 *           high: high
 *         compat:
 *           # Forced defaults: supportsDeveloperRole: false, supportsStore: false,
 *           # maxTokensField: max_tokens. Override only when the upstream accepts more.
 * ```
 *
 * @module @deepseek-ai/dsh-llm-newapi
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export { NewApiAdapter } from './adapter.ts';
export type { NewApiAdapterOptions } from './adapter.ts';
export { Config } from './config.ts';
export type { NewApiCompatProfile, NewApiModality, NewApiModelOverride, NewApiModelProfile, NewApiProviderProfile, NewApiReasoningEfforts, NewApiThinkingFormat, ResolvedNewApiProviderProfile, } from './config.ts';
export declare const name = "llm-newapi";
export declare const inject: string[];
/** Register one New API adapter for all configured provider routes. */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map