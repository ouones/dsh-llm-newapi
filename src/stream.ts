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

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AnthropicResponseEvent, AnthropicUsage, WireChunk, WireUsage } from './types.ts'

/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the OpenAI wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map the Anthropic wire stop_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `stop_reason` string.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapAnthropicStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn': return { kind: 'stop' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'tool_use': return { kind: 'tool-calls' }
    default:
      // stop_sequence, pause_turn, refusal, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map OpenAI wire usage fields. The harness TokenUsage convention is DISJOINT
 * counts, and OpenAI-compatible relays report cache hits inside
 * `prompt_tokens`, so cache reads are subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/**
 * Map Anthropic wire usage fields. Unlike OpenAI-compatible relays, Anthropic
 * reports cache counts DISJOINT from `input_tokens`, so no subtraction is
 * needed to reach the harness convention.
 * @param usage - wire usage from the `message_start` or `message_delta` event.
 * @returns harness counts; cache fields present only when the wire reported them.
 */
export function mapAnthropicUsage(usage: AnthropicUsage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
    ...usage.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * The empty-response finish both translators emit when a stream completes
 * with a stop but opened no content block.
 */
function emptyFinish(): FinishReason {
  return {
    kind: 'error',
    failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
  }
}

/**
 * Parse one SSE data payload as a wire chunk; malformed JSON aborts the
 * stream with `MALFORMED_RESPONSE`.
 * @param payload - one SSE `data:` payload.
 * @returns the parsed chunk.
 */
function parseChunk(payload: string): WireChunk {
  try {
    return JSON.parse(payload) as WireChunk
  } catch {
    throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
  }
}

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
export async function* translateChat(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0 ? emptyFinish() : reason,
      }
      return
    }

    const chunk = parseChunk(payload)

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

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
export async function* translateAnthropic(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind'], index: number): OpenBlock {
    const block: OpenBlock = { index, kind, text: '' }
    blocks.set(index, block)
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    let event: AnthropicResponseEvent
    try {
      event = JSON.parse(payload) as AnthropicResponseEvent
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage) pendingUsage = mapAnthropicUsage(usage)
        break
      }
      case 'content_block_start': {
        const block = event.content_block
        if (block === undefined || event.index === undefined) break
        let kind: OpenBlock['kind']
        switch (block.type) {
          case 'text': kind = 'text'; break
          case 'thinking': kind = 'reasoning'; break
          case 'tool_use': kind = 'tool-call'; break
          default:
            // tool_result blocks never stream (they are request-side only).
            continue
        }
        const openBlock = open(kind, event.index)
        if (block.type === 'tool_use') {
          openBlock.callId = block.id
          openBlock.name = block.name
          openBlock.text = ''
        }
        yield { type: 'block-start', index: openBlock.index, blockType: kind }
        break
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index ?? -1)
        const delta = event.delta
        if (block === undefined || delta === undefined) break
        if (delta.type === 'text_delta' && delta.text !== undefined && delta.text.length > 0) {
          block.text += delta.text
          yield { type: 'text-delta', index: block.index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined && delta.thinking.length > 0) {
          block.text += delta.thinking
          yield { type: 'reasoning-delta', index: block.index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const fragment = delta.partial_json
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...block.name !== undefined ? { name: block.name } : {},
            argumentsDelta: fragment,
          }
        }
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index ?? -1)
        if (block === undefined) break
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        blocks.delete(block.index)
        break
      }
      case 'message_delta': {
        if (typeof event.stop_reason === 'string') {
          pendingFinish = mapAnthropicStopReason(event.stop_reason)
        }
        if (event.usage) pendingUsage = mapAnthropicUsage(event.usage)
        break
      }
      case 'message_stop': {
        if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
        const reason = pendingFinish ?? { kind: 'stop' as const }
        yield {
          type: 'finish',
          reason: reason.kind === 'stop' && order.length === 0 ? emptyFinish() : reason,
        }
        return
      }
      case 'ping':
        break
      case 'error': {
        const message = event.error?.message ?? 'Anthropic messages stream error'
        throw new LlmError(message, event.error?.type?.toUpperCase() ?? 'API_ERROR')
      }
    }
  }

  // parseSse guarantees the [DONE] sentinel (or throws) for OpenAI routes;
  // the Anthropic route sends no [DONE], so the terminal message_stop event is
  // the only legal stream end. Reaching here means the source violated that
  // contract — same truncation classification as a missing [DONE].
  throw new LlmError('SSE payload stream ended without message_stop', 'STREAM_CLOSED')
}
