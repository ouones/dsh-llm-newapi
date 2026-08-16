/**
 * Decode New API SSE byte streams into `data` payloads and translate them into
 * the harness `StreamChunk` protocol. Framing — chunk reassembly, UTF-8/CRLF/
 * BOM handling, comment and non-data field skipping, multi-`data:` joining —
 * is `eventsource-parser`'s. The OpenAI completions route and the Anthropic
 * messages route share the byte decoder but translate through different state
 * machines; both defer finish, usage, and block assembly to their terminal
 * event, so no chunk follows `finish`.
 *
 * @module dsh-llm-newapi/stream
 */
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AnthropicUsage, WireUsage } from './types.ts';
/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export declare const DONE = "[DONE]";
/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export declare function parseSse(stream: ReadableStream<BufferSource>, onComment?: (comment: string) => void): AsyncGenerator<string>;
/**
 * Map the OpenAI wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export declare function mapFinishReason(reason: string): FinishReason;
/**
 * Map the Anthropic wire stop_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `stop_reason` string.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as `code`.
 */
export declare function mapAnthropicStopReason(reason: string): FinishReason;
/**
 * Map OpenAI wire usage fields. The harness TokenUsage convention is DISJOINT
 * counts, and OpenAI-compatible relays report cache hits inside
 * `prompt_tokens`, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export declare function mapUsage(usage: WireUsage): TokenUsage;
/**
 * Map Anthropic wire usage fields. Unlike OpenAI-compatible relays, Anthropic
 * reports cache counts DISJOINT from `input_tokens`, so no subtraction is
 * needed to reach the harness convention.
 * @param usage - wire usage from the `message_start` or `message_delta` event.
 * @returns harness counts; cache fields present only when the wire reported them.
 */
export declare function mapAnthropicUsage(usage: AnthropicUsage): TokenUsage;
/**
 * Consume OpenAI chat-completions SSE data payloads (ending with `[DONE]`) and
 * yield StreamChunks. An empty initial reasoning delta does not open a block.
 * Finish reason and the latest usage are deferred until `[DONE]`, covering both
 * finish-attached and trailing usage-only shapes while ensuring no chunk
 * follows `finish`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export declare function translateChat(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>;
/**
 * Consume Anthropic messages SSE data payloads and yield StreamChunks. Blocks
 * open on `content_block_start`, accumulate on `content_block_delta`, and
 * close on `content_block_stop`; finish and usage are deferred to
 * `message_stop`. A `stop` finish with no opened blocks is a degenerate
 * provider completion and maps to an `EMPTY_RESPONSE` error finish.
 * @param payloads - SSE data payloads from {@link parseSse}; the Anthropic
 *   route does not send the `[DONE]` sentinel, so the terminal `message_stop`
 *   event ends the stream instead.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are
 *   deferred to the `message_stop` event, so no chunk follows `finish`.
 */
export declare function translateAnthropic(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>;
