import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, CallId, ReasoningEffortId, createMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeChatRequest, serializeAnthropicRequest } from '../src/serialize.ts'
import type { WireModel } from '../src/serialize.ts'

function model(overrides: Partial<WireModel> = {}): WireModel {
  return {
    api: 'openai-completions',
    compat: {},
    baseUrl: 'https://gateway.example',
    maxTokens: 4096,
    ...overrides,
  }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'newapi', model: 'gpt-5', messages: [], ...overrides }
}

const history: Message[] = [createUserMessage({
  content: [{ type: 'text', text: 'hi' }],
  source: { kind: 'plugin', plugin: 'test' },
})]

describe('serializeChatRequest', () => {
  it('always streams with usage and maps the basics', async () => {
    const wire = await serializeChatRequest(request({ messages: history }), model())
    expect(wire).toEqual({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
    })
  })

  it('sends the system prompt as role system by default (never developer)', async () => {
    const wire = await serializeChatRequest(request({ messages: history, system: 'be helpful' }), model())
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(wire.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps system-role history messages to system content', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('uses the developer role only when the compat profile accepts it', async () => {
    const wire = await serializeChatRequest(request({ messages: history, system: 'be helpful' }), model({
      compat: { supportsDeveloperRole: true },
    }))
    expect(wire.messages[0]).toEqual({ role: 'developer', content: 'be helpful' })
  })

  it('maps maxTokensField to max_tokens by default', async () => {
    const wire = await serializeChatRequest(request({ messages: history, maxTokens: 100 }), model())
    expect(wire.max_tokens).toBe(100)
    expect(wire.max_completion_tokens).toBeUndefined()
  })

  it('maps maxTokensField to max_completion_tokens when the compat profile names it', async () => {
    const wire = await serializeChatRequest(request({ messages: history, maxTokens: 100 }), model({
      compat: { maxTokensField: 'max_completion_tokens' },
    }))
    expect(wire.max_completion_tokens).toBe(100)
    expect(wire.max_tokens).toBeUndefined()
  })

  it('defaults maxTokens to the model capability when the request names none', async () => {
    const wire = await serializeChatRequest(request({ messages: history }), model({ maxTokens: 8192 }))
    expect(wire.max_tokens).toBe(8192)
  })

  it('maps the reasoning effort to reasoning_effort', async () => {
    const wire = await serializeChatRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      model(),
      'high',
    )
    expect(wire.reasoning_effort).toBe('high')
  })

  it('omits reasoning_effort when dispatch resolved none', async () => {
    const wire = await serializeChatRequest(request({ messages: history, reasoningEffort: ReasoningEffortId('off') }), model())
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('maps sampling params and stop sequences', async () => {
    const wire = await serializeChatRequest(request({
      messages: history,
      temperature: 0.2,
      stop: ['END'],
    }), model())
    expect(wire.temperature).toBe(0.2)
    expect(wire.stop).toEqual(['END'])
  })

  it('maps tools to the wire function shape', async () => {
    const wire = await serializeChatRequest(request({
      messages: history,
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      ],
    }), model())
    expect(wire.tools).toEqual([
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ])
  })

  it('omits an empty tools array', async () => {
    const wire = await serializeChatRequest(request({ messages: history, tools: [] }), model())
    expect(wire.tools).toBeUndefined()
  })

  it('turns tool results into role:tool messages', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'Sunny 22C' }])
  })

  it('sends a sentinel for empty tool-result content', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: '(no output)' }])
  })

  it('serializes assistant tool calls with empty-string content, never null', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '{}' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages[0]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
    })
  })

  it('serializes a plain assistant text turn without tool_calls', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages[0]).toEqual({ role: 'assistant', content: 'answer' })
  })

  it('splits mixed user text + tool results into separate wire messages', async () => {
    const wire = await serializeChatRequest(request({
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model())
    expect(wire.messages).toEqual([
      { role: 'user', content: 'context note' },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ])
  })
})

describe('serializeAnthropicRequest', () => {
  const anthropic = model({ api: 'anthropic-messages' })

  it('maps the basics with a required max_tokens', async () => {
    const wire = await serializeAnthropicRequest(request({ messages: history, maxTokens: 100 }), anthropic)
    expect(wire).toEqual({
      model: 'gpt-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
    })
  })

  it('defaults max_tokens to the model capability when the request names none', async () => {
    const wire = await serializeAnthropicRequest(request({ messages: history }), model({
      api: 'anthropic-messages',
      maxTokens: 8192,
    }))
    expect(wire.max_tokens).toBe(8192)
  })

  it('maps the system prompt to the system field (Anthropic has no developer role)', async () => {
    const wire = await serializeAnthropicRequest(request({ messages: history, system: 'be helpful' }), anthropic)
    expect(wire.system).toBe('be helpful')
    expect(wire.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('maps tools to the input_schema shape', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: history,
      tools: [{ name: 'a', description: 'A', parameters: { type: 'object', properties: {} } }],
    }), anthropic)
    expect(wire.tools).toEqual([
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: {} } },
    ])
  })

  it('maps sampling params and stop sequences', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: history,
      temperature: 0.2,
      stop: ['END'],
    }), anthropic)
    expect(wire.temperature).toBe(0.2)
    expect(wire.stop_sequences).toEqual(['END'])
  })

  it('turns tool results into tool_result blocks', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [{ type: 'text', text: 'Sunny 22C' }],
      }],
    }])
  })

  it('marks failed tool results with is_error', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    const first = wire.messages[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    expect(first.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call-1',
      is_error: true,
    })
  })

  it('serializes assistant tool calls as tool_use blocks', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '{"x":1}' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c', name: 'f', input: { x: 1 } }],
    })
  })

  it('serializes a plain assistant text turn as a text block without tool_use', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    })
  })

  it('refuses unparseable tool-call arguments instead of degrading the input', async () => {
    await expect(serializeAnthropicRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: 'not json' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('falls back to an empty input object for non-object arguments', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '[]' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c', name: 'f', input: {} }],
    })
  })

  it('sends a sentinel for empty Anthropic tool-result content', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages[0]).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: [{ type: 'text', text: '(no output)' }],
      }],
    })
  })

  it('drops an Anthropic user message with neither text nor tool results', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createUserMessage({
        content: [],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages).toEqual([])
  })

  it('merges user text and tool results into one Anthropic user message', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), anthropic)
    expect(wire.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'context note' },
        { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'ok' }] },
      ],
    }])
  })

  it('drops system-role history messages (the system field is the one system slot)', async () => {
    const wire = await serializeAnthropicRequest(request({
      messages: [
        createMessage({
          role: 'system', content: [{ type: 'text', text: 'be brief' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        ...history,
      ],
      system: 'top-level system',
    }), anthropic)
    expect(wire.system).toBe('top-level system')
    expect(wire.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('ignores reasoningEffort (the Anthropic wire has no reasoning_effort field)', async () => {
    const wire = await serializeAnthropicRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      anthropic,
      'high',
    )
    expect(wire).not.toHaveProperty('reasoning_effort')
  })
})

describe('serializeChatRequest: image input', () => {
  /** A fake store returning the given base64-decoded bytes for any ref. */
  function store(mediaType: string, data: Uint8Array) {
    return {
      readImage: () => Promise.resolve({
        ref: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType, bytes: data.byteLength, width: 1, height: 1,
        },
        data,
      }),
    } as unknown as AttachmentStore
  }

  const imageMsg = createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png', bytes: 68, width: 1, height: 1,
      },
    }],
    source: { kind: 'plugin', plugin: 'test' },
  })

  const imageAttachment: ImageAttachmentRef = {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png', bytes: 68, width: 1, height: 1,
  }

  it('rejects image blocks without the durable attachment store', async () => {
    await expect(serializeChatRequest(request({ messages: [imageMsg] }), model()))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('serializes image blocks into data-URI image_url parts', async () => {
    const bytes = new TextEncoder().encode('fake-png')
    const wire = await serializeChatRequest(request({ messages: [imageMsg] }), model(), undefined, store('image/png', bytes))
    expect(wire.messages).toEqual([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${btoa('fake-png')}` } }],
    }])
  })

  it('keeps text alongside an image as parallel parts', async () => {
    const bytes = new TextEncoder().encode('fake-png')
    const wire = await serializeChatRequest(request({
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', attachment: { ...imageAttachment } },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }), model(), undefined, store('image/png', bytes))
    expect(wire.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${btoa('fake-png')}` } },
      ],
    })
  })
})

describe('serializeAnthropicRequest: image input', () => {
  /** A fake store returning the given media type + bytes for any ref. */
  function store(mediaType: string, data: Uint8Array) {
    return {
      readImage: () => Promise.resolve({
        ref: {
          attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
          mediaType, bytes: data.byteLength, width: 1, height: 1,
        },
        data,
      }),
    } as unknown as AttachmentStore
  }

  const imageMsg = createUserMessage({
    content: [{
      type: 'image',
      attachment: {
        attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
        mediaType: 'image/webp', bytes: 68, width: 1, height: 1,
      },
    }],
    source: { kind: 'plugin', plugin: 'test' },
  })

  it('serializes image blocks into Anthropic base64 image blocks', async () => {
    const bytes = new TextEncoder().encode('fake-webp')
    const anthropic = model({ api: 'anthropic-messages' })
    const wire = await serializeAnthropicRequest(request({ messages: [imageMsg] }), anthropic, undefined, store('image/webp', bytes))
    expect(wire.messages).toEqual([{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: btoa('fake-webp') } }],
    }])
  })
})
