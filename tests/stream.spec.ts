import { describe, expect, it } from 'vitest'
import { BlockAssembler, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DONE, parseSse } from '../src/stream.ts'
import {
  mapAnthropicStopReason,
  mapAnthropicUsage,
  mapFinishReason,
  mapUsage,
  translateAnthropic,
  translateChat,
} from '../src/stream.ts'

async function* feed(...payloads: (string | object)[]): AsyncGenerator<string> {
  for (const payload of payloads) {
    yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** The live first-chunk signature: role + null content + EMPTY reasoning. */
const firstChunk = { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] }

describe('parseSse', () => {
  function bytes(...fragments: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const fragment of fragments) controller.enqueue(encoder.encode(fragment))
        controller.close()
      },
    })
  }

  async function collectPayloads(stream: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = []
    for await (const item of stream) out.push(item)
    return out
  }

  it('yields event payloads and the DONE sentinel', async () => {
    const events = await collectPayloads(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('reports comments out of band without yielding them', async () => {
    const comments: string[] = []
    const events = await collectPayloads(parseSse(
      bytes(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'),
      (comment) => { comments.push(comment) },
    ))
    expect(comments).toEqual(['keep-alive'])
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('throws STREAM_CLOSED when the stream ends without DONE', async () => {
    await expect(collectPayloads(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(/without \[DONE\]/)
  })
})

describe('translateChat: text', () => {
  it('streams a text block and defers finish to DONE', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles into the message BlockAssembler expects', async () => {
    const assembler = new BlockAssembler()
    for await (const chunk of translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    ))) {
      assembler.push(chunk)
    }
    const result = { message: assembler.message(), finish: assembler.finish }
    expect(result.message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })
})

describe('translateChat: reasoning', () => {
  it('does NOT open a reasoning block for the empty first-chunk signature', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: 'plain' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'reasoning')).toBe(false)
  })

  it('streams reasoning then text as separate blocks', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: null, reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: null, reasoning_content: 'ing' } }] },
      { choices: [{ delta: { content: 'answer', reasoning_content: null } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'reasoning-delta', index: 0, text: 'ing' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translateChat: tool calls', () => {
  it('reassembles a tool call from fragmented argument deltas', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_00_x', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': "Paris"}' } }] } }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 28, completion_tokens: 6 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_00_x', name: 'get_weather', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_00_x', name: 'get_weather', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, id: 'call_00_x', name: 'get_weather', argumentsDelta: ': "Paris"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_00_x', name: 'get_weather', arguments: '{"city": "Paris"}' },
      },
      { type: 'usage', usage: { inputTokens: 28, outputTokens: 6 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('disambiguates parallel tool calls by wire index', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
              { index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '' } },
            ],
          },
        }],
      },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      DONE,
    )))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends).toEqual([
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'one', arguments: '{}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'b', name: 'two', arguments: '{}' } },
    ])
  })

  it('handles tool-call deltas that never carry id or name (empty-string fallbacks)', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('handles tool-call deltas with a function object but no arguments field', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      DONE,
    )))
    expect(chunks[1]).toEqual({ type: 'tool-call-delta', index: 0, id: 'c', name: 'f', argumentsDelta: '' })
  })

  it('handles chunks with no choices at all', async () => {
    const chunks = await collect(translateChat(feed(
      {},
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })
})

describe('translateChat: finish and usage handling', () => {
  it('takes usage from a trailing usage-only chunk', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: 'x' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } },
      DONE,
    )))
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('last usage wins when both attached and trailing arrive', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2 } },
      DONE,
    )))
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } })
  })

  it('defaults to finish stop when no finish_reason ever arrives', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: 'x' } }] },
      DONE,
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('classifies an explicit stop with no opened blocks as EMPTY_RESPONSE', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 0 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })

  it('keeps a reasoning-only stream a successful stop (any opened block counts)', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: { content: null, reasoning_content: 'mull' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('leaves non-stop finishes unclassified even with no opened blocks', async () => {
    const chunks = await collect(translateChat(feed(
      firstChunk,
      { choices: [{ delta: {}, finish_reason: 'length' }] },
      DONE,
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('translateChat: errors', () => {
  it('throws MALFORMED_RESPONSE for invalid JSON payloads', async () => {
    await expect(collect(translateChat(feed('{bad json')))).rejects.toThrow(LlmError)
    await expect(collect(translateChat(feed('{bad json')))).rejects.toThrow(/malformed SSE payload/)
  })

  it('throws STREAM_CLOSED when the payload source ends without DONE', async () => {
    await expect(collect(translateChat(feed(firstChunk)))).rejects.toThrow(/without \[DONE\]/)
  })
})

describe('translateAnthropic: text and thinking', () => {
  it('streams text blocks and defers finish to message_stop', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('streams thinking deltas as a reasoning block', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mull', signature: 'sig1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    const starts = chunks.filter(chunk => chunk.type === 'block-start')
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(starts).toEqual([{ type: 'block-start', index: 0, blockType: 'reasoning' }])
    expect(ends).toEqual([{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'mull' } }])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles into the message BlockAssembler expects', async () => {
    const assembler = new BlockAssembler()
    for await (const chunk of translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 1 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    ))) {
      assembler.push(chunk)
    }
    const result = { message: assembler.message(), finish: assembler.finish }
    expect(result.message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })
})

describe('translateAnthropic: tool calls', () => {
  it('reassembles a tool_use block from input_json deltas', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ': "Paris"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 4 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: '{"city"' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'get_weather', argumentsDelta: ': "Paris"}' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city": "Paris"}' },
      },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('interleaves text and tool_use blocks with distinct indices', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    const starts = chunks.filter(chunk => chunk.type === 'block-start')
    expect(starts).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
    ])
  })
})

describe('translateAnthropic: finish and usage handling', () => {
  it('maps max_tokens stop_reason to max-tokens', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'max_tokens' },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('takes usage from message_start when message_delta carries none', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 0 } })
  })

  it('classifies a stop with no opened blocks as EMPTY_RESPONSE', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })

  it('defaults to finish stop when no stop_reason ever arrives', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('skips ping events', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'ping' },
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ignores tool_result content_block_start events (request-side blocks never stream)', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_result', tool_use_id: 'x', content: 'ok' } },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        },
      },
    ])
  })

  it('ignores content_block_delta for an unknown block index', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 99, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ignores content_block_delta events without a delta object', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0 },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ignores content_block_stop for an unknown block index', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 99 },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends).toEqual([{ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }])
  })

  it('runs without usage when neither message_start nor message_delta carries it', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    )))
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ignores content_block_start events without a content block or index', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start' },
      { type: 'content_block_start', index: 0 },
      { type: 'content_block_start', content_block: { type: 'text', text: '' } },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' },
      { type: 'message_stop' },
    )))
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    })
  })

  it('yields empty argument deltas for tool_use blocks with no name or partial_json', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    expect(chunks[1]).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: 't',
      name: 'f',
      argumentsDelta: '{}',
    })
  })

  it('handles a tool_use block whose start event lacks a name', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: '', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 't', name: '', arguments: '{}' },
    })
  })

  it('handles a tool_use block whose start event lacks an id', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '', name: 'f', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(delta).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: '',
      name: 'f',
      argumentsDelta: '{}',
    })
  })

  it('handles a tool_use block whose start event lacks both id and name', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
    expect(delta).toEqual({
      type: 'tool-call-delta',
      index: 0,
      id: '',
      argumentsDelta: '{}',
    })
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
    })
  })

  it('ignores input_json_delta events without partial_json', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'tool_use' },
      { type: 'message_stop' },
    )))
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toEqual([])
  })

  it('ignores content_block_delta and content_block_stop events without an index', async () => {
    const chunks = await collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
      { type: 'content_block_stop' },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 0 } },
      { type: 'message_stop' },
    )))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends).toEqual([{ type: 'block-end', index: 0, block: { type: 'text', text: '' } }])
  })

  it('throws a generic error for an error event without message or type', async () => {
    await expect(collect(translateAnthropic(feed(
      { type: 'error', error: {} },
    )))).rejects.toThrow(/Anthropic messages stream error/)
    await expect(collect(translateAnthropic(feed(
      { type: 'error' },
    )))).rejects.toThrow(/Anthropic messages stream error/)
  })
})

describe('translateAnthropic: errors', () => {
  it('throws MALFORMED_RESPONSE for invalid JSON payloads', async () => {
    await expect(collect(translateAnthropic(feed('{bad json')))).rejects.toThrow(/malformed SSE payload/)
  })

  it('throws STREAM_CLOSED when the payload source ends without message_stop', async () => {
    await expect(collect(translateAnthropic(feed(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    )))).rejects.toThrow(/without message_stop/)
  })

  it('throws the provider error from an error event', async () => {
    await expect(collect(translateAnthropic(feed(
      { type: 'error', error: { type: 'overloaded_error', message: 'upstream overloaded' } },
    )))).rejects.toThrow(/upstream overloaded/)
  })
})

describe('mapFinishReason', () => {
  it.each([
    ['stop', { kind: 'stop' }],
    ['tool_calls', { kind: 'tool-calls' }],
    ['length', { kind: 'max-tokens' }],
  ])('maps %s', (wire, expected) => {
    expect(mapFinishReason(wire)).toEqual(expected)
  })

  it.each(['content_filter', 'insufficient_system_resource', 'mystery_reason'])(
    'maps %s to an error kind with the wire code',
    (wire) => {
      expect(mapFinishReason(wire)).toEqual({
        kind: 'error',
        failure: { message: `model stopped: ${wire}`, code: wire.toUpperCase() },
      })
    },
  )
})

describe('mapAnthropicStopReason', () => {
  it.each([
    ['end_turn', { kind: 'stop' }],
    ['max_tokens', { kind: 'max-tokens' }],
    ['tool_use', { kind: 'tool-calls' }],
  ])('maps %s', (wire, expected) => {
    expect(mapAnthropicStopReason(wire)).toEqual(expected)
  })

  it.each(['stop_sequence', 'pause_turn', 'refusal', 'mystery_reason'])(
    'maps %s to an error kind with the wire code',
    (wire) => {
      expect(mapAnthropicStopReason(wire)).toEqual({
        kind: 'error',
        failure: { message: `model stopped: ${wire}`, code: wire.toUpperCase() },
      })
    },
  )
})

describe('mapUsage', () => {
  it('maps the full live-capture shape', () => {
    expect(mapUsage({
      prompt_tokens: 283,
      completion_tokens: 69,
      prompt_tokens_details: { cached_tokens: 256 },
      completion_tokens_details: { reasoning_tokens: 24 },
    })).toEqual({
      // 283 wire prompt_tokens minus the 256 cached → 27 uncached input
      // (TokenUsage counts are disjoint).
      inputTokens: 27,
      outputTokens: 69,
      cacheReadTokens: 256,
      reasoningTokens: 24,
    })
  })

  it('omits optional fields when the wire omits them', () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 2 }))
      .toEqual({ inputTokens: 10, outputTokens: 2 })
  })
})

describe('mapAnthropicUsage', () => {
  it('maps base counts and disjoint cache reads', () => {
    expect(mapAnthropicUsage({
      input_tokens: 27,
      output_tokens: 69,
      cache_read_input_tokens: 256,
      cache_creation_input_tokens: 10,
    })).toEqual({
      inputTokens: 27,
      outputTokens: 69,
      cacheReadTokens: 256,
      cacheWriteTokens: 10,
    })
  })

  it('omits cache fields when the wire omits them', () => {
    expect(mapAnthropicUsage({ input_tokens: 5, output_tokens: 2 }))
      .toEqual({ inputTokens: 5, outputTokens: 2 })
  })
})
