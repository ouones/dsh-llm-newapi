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

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { NewApiCompatProfile } from './catalog.ts'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  WireMessage,
  WireRequest,
  WireTool,
} from './types.ts'

/** Wire facts one request is serialized against; the adapter resolves them per model. */
export interface WireModel {
  /** The wire protocol this model speaks. */
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** The compat block resolved for this model by the catalog. */
  compat: NewApiCompatProfile
  /** Gateway root URL; unused by the serializers (the adapter owns the endpoint path). */
  baseUrl: string
  /** Output capability for this model, used when the request names no cap. */
  maxTokens: number
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The New API adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/**
 * Serialize one assistant message for the OpenAI wire (text + tool calls).
 * Text-less turns send "" — NEVER null; some gateways reject null outright.
 * Reasoning blocks have no OpenAI replay channel, so they are dropped.
 */
function serializeAssistantOpenAi(message: Message): WireMessage {
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: flattenText(message.content),
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize one assistant message for the Anthropic wire. Text becomes a text
 * block, tool calls become `tool_use` blocks; reasoning blocks have no
 * Anthropic replay channel, so they are dropped.
 */
function serializeAssistantAnthropic(message: Message): AnthropicMessage {
  const content: AnthropicContentBlock[] = []
  const text = flattenText(message.content)
  if (text.length > 0) content.push({ type: 'text', text })
  for (const call of message.content.filter(block => block.type === 'tool-call')) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parseArguments(call.arguments),
    })
  }
  return { role: 'assistant', content }
}

/**
 * Parse a tool-call argument JSON string into the object Anthropic's
 * `input` field requires. A parse failure is a broken model turn, not a
 * caller bug: the arguments were model-produced and are already durably
 * logged, so the message refuses loudly instead of silently degrading.
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    throw new LlmError(`Cannot replay tool-call arguments as an Anthropic input object: ${raw.slice(0, 120)}`, 'INVALID_ARGS')
  }
}

/**
 * Serialize the conversation for one wire. `tool-result` blocks become
 * standalone OpenAI `{role: 'tool'}` messages or Anthropic `tool_result`
 * blocks; the harness puts each tool result in its own user-role message, so a
 * mixed user message contributes its text first and its tool results after.
 * @param messages - the harness conversation, in order.
 * @param anthropic - whether to emit Anthropic blocks (tool_result) instead of OpenAI tool messages.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
function serializeMessages(messages: Message[], anthropic: boolean): (WireMessage | AnthropicMessage)[] {
  const wire: (WireMessage | AnthropicMessage)[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      if (anthropic) {
        // System-role history messages have no Anthropic home; they are
        // dropped here because the `system` field is the one system slot.
        continue
      }
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(anthropic ? serializeAssistantAnthropic(message) : serializeAssistantOpenAi(message))
      continue
    }
    // user role: tool results ride in user messages in the harness vocabulary.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (anthropic) {
      const blocks: AnthropicContentBlock[] = []
      if (text.length > 0) blocks.push({ type: 'text', text })
      for (const result of toolResults) {
        const resultText = flattenText(result.content) || '(no output)'
        blocks.push({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: [{ type: 'text', text: resultText }],
          ...result.isError === true ? { is_error: true } : {},
        })
      }
      if (blocks.length > 0) wire.push({ role: 'user', content: blocks })
      continue
    }
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
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
export function serializeChatRequest(
  options: GenerateOptions,
  model: WireModel,
  reasoningEffort?: string,
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({
      role: model.compat.supportsDeveloperRole === true ? 'developer' : 'system',
      content: options.system,
    })
  }
  messages.push(...serializeMessages(options.messages, false) as WireMessage[])

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const maxTokens = options.maxTokens ?? model.maxTokens
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...model.compat.maxTokensField === 'max_completion_tokens'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens },
    ...reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {},
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

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
export function serializeAnthropicRequest(
  options: GenerateOptions,
  model: WireModel,
  _reasoningEffort?: string,
): AnthropicRequest {
  const messages = serializeMessages(options.messages, true) as AnthropicMessage[]
  const tools: AnthropicTool[] | undefined = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  return {
    model: options.model,
    max_tokens: options.maxTokens ?? model.maxTokens,
    ...options.system !== undefined ? { system: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    stream: true,
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.stop !== undefined ? { stop_sequences: options.stop } : {},
  }
}
