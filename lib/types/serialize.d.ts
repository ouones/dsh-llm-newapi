/**
 * Serialize harness messages into New API wire requests for the
 * openai-completions and anthropic-messages routes. User text is joined;
 * assistant text becomes `content` and tool calls become `tool_calls` /
 * `tool_use` blocks; tool results become separate tool messages / `tool_result`
 * blocks. Core image blocks are rejected explicitly because both wire routes
 * are text-only; unknown declaration-merged block types retain the adapter's
 * documented extension fallback.
 *
 * @module dsh-llm-newapi/serialize
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { NewApiCompatProfile } from './catalog.ts';
import type { AnthropicRequest, WireRequest } from './types.ts';
/** Wire facts one request is serialized against; the adapter resolves them per model. */
export interface WireModel {
    /** The wire protocol this model speaks. */
    api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
    /** The compat block resolved for this model by the catalog. */
    compat: NewApiCompatProfile;
    /** Gateway root URL; unused by the serializers (the adapter owns the endpoint path). */
    baseUrl: string;
    /** Output capability for this model, used when the request names no cap. */
    maxTokens: number;
}
/**
 * Build the full OpenAI chat-completions request. Always streaming
 * (`stream: true`, usage reporting on); optional fields are omitted rather
 * than sent as null, so provider defaults apply. The system prompt uses the
 * `developer` role only when the model's compat block accepts it — the forced
 * default is `system`, which is the fix this plugin exists for.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param model - the resolved wire facts for this model.
 * @param reasoningEffort - the wire spelling of the selected reasoning level, when dispatch resolved one.
 * @returns the chat-completions request body.
 */
export declare function serializeChatRequest(options: GenerateOptions, model: WireModel, reasoningEffort?: string): WireRequest;
/**
 * Build the full Anthropic messages request. Always streaming; optional fields
 * are omitted rather than sent as null. The `anthropic-version` header is the
 * adapter's job, not this body's. System history messages are dropped — the
 * `system` field is Anthropic's one system slot.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param model - the resolved wire facts for this model.
 * @param _reasoningEffort - unused by the Anthropic wire; accepted for a uniform adapter dispatch signature.
 * @returns the messages request body.
 */
export declare function serializeAnthropicRequest(options: GenerateOptions, model: WireModel, _reasoningEffort?: string): AnthropicRequest;
//# sourceMappingURL=serialize.d.ts.map