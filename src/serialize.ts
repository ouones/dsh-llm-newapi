/**
 * Serialize harness messages into New API wire requests for the
 * openai-completions and anthropic-messages routes. User text is joined;
 * assistant text becomes `content` and tool calls become `tool_calls` /
 * `tool_use` blocks; tool results become separate tool messages / `tool_result`
 * blocks. Image blocks read their bytes through the optional durable
 * attachment service and become OpenAI `image_url` parts or Anthropic `image`
 * blocks; unknown declaration-merged block types retain the adapter's
 * documented extension fallback.
 *
 * @module dsh-llm-newapi/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { NewApiCompatProfile } from './catalog.ts'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  WireImagePart,
  WireMessage,
  WireRequest,
  WireTextPart,
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

/** Read one image block's bytes and encode them as a data URI for the OpenAI wire. */
async function openAiImagePart(
  block: ImageBlock,
  attachments: AttachmentStore,
): Promise<WireImagePart> {
  const stored = await attachments.readImage(block.attachment)
  const base64 = Buffer.from(stored.data).toString('base64')
  return { type: 'image_url', image_url: { url: `data:${stored.ref.mediaType};base64,${base64}` } }
}

/** Read one image block's bytes and build the Anthropic `image` source block. */
async function anthropicImageBlock(
  block: ImageBlock,
  attachments: AttachmentStore,
): Promise<AnthropicContentBlock & { type: 'image' }> {
  const stored = await attachments.readImage(block.attachment)
  return {
    type: 'image',
    source: { type: 'base64', media_type: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') },
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
 * Image blocks in user or tool-result content are read through the attachment
 * store and emitted as vision parts / image blocks when one was supplied;
 * without the store an image is refused loudly rather than silently dropped.
 * @param messages - the harness conversation, in order.
 * @param anthropic - whether to emit Anthropic blocks (tool_result) instead of OpenAI tool messages.
 * @param attachments - the durable attachment store, required when any message carries an image.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
async function serializeMessages(
  messages: Message[],
  anthropic: boolean,
  attachments?: AttachmentStore,
): Promise<(WireMessage | AnthropicMessage)[]> {
  const wire: (WireMessage | AnthropicMessage)[] = []
  for (const message of messages) {
    if (contentHasImage(message.content) && attachments === undefined) {
      throw new LlmError('newapi image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
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
      for (const part of await anthropicUserParts(message.content, attachments)) {
        blocks.push(part)
      }
      for (const result of toolResults) {
        const resultContent: AnthropicContentBlock[] = []
        const resultText = flattenText(result.content)
        if (resultText.length > 0) resultContent.push({ type: 'text', text: resultText })
        for (const part of await anthropicUserParts(result.content, attachments)) {
          resultContent.push(part)
        }
        if (resultContent.length === 0) resultContent.push({ type: 'text', text: '(no output)' })
        blocks.push({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: resultContent,
          ...result.isError === true ? { is_error: true } : {},
        })
      }
      if (blocks.length > 0) wire.push({ role: 'user', content: blocks })
      continue
    }
    const imageParts = await openAiUserParts(message.content, attachments)
    if (imageParts !== undefined || text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: openAiUserContent(text, imageParts) })
    }
    for (const result of toolResults) {
      const resultImages = await openAiUserParts(result.content, attachments)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: openAiToolContent(flattenText(result.content), resultImages),
      })
    }
  }
  return wire
}

/** The image blocks a message carries, or `undefined` when it carries none. */
function imageBlocksOf(blocks: readonly ContentBlock[]): ImageBlock[] {
  if (!contentHasImage(blocks)) return []
  return blocks.filter((block): block is ImageBlock => block.type === 'image')
}

/** Build the OpenAI image_url parts for one message. */
async function openAiUserParts(
  blocks: readonly ContentBlock[],
  attachments?: AttachmentStore,
): Promise<WireImagePart[] | undefined> {
  const images = imageBlocksOf(blocks)
  if (images.length === 0) return undefined
  if (attachments === undefined) {
    throw new LlmError('newapi image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const parts: WireImagePart[] = []
  for (const block of images) parts.push(await openAiImagePart(block, attachments))
  return parts
}

/** The OpenAI user content value: a plain string when text-only, else a parts array. */
function openAiUserContent(text: string, imageParts: WireImagePart[] | undefined): string | (WireTextPart | WireImagePart)[] {
  if (imageParts === undefined) return text
  return [...text.length > 0 ? [{ type: 'text' as const, text }] : [], ...imageParts]
}

/**
 * The OpenAI tool-role content: always a plain string, because `image_url`
 * parts are not a tool-message wire shape. An image in a tool result is
 * therefore DEGRADED to a fixed text marker (`image attached`) — the model never
 * receives those pixels on the OpenAI tool wire. Any callers relying on
 * image-understanding in tool results should prefer the Anthropic route, which
 * carries tool-result images as real `image` blocks.
 */
function openAiToolContent(text: string, imageParts: WireImagePart[] | undefined): string {
  if (imageParts === undefined) return text || '(no output)'
  return [text.length > 0 ? text : '(no output)', ...imageParts.map(() => 'image attached')].join('\n')
}

/** The Anthropic user content blocks for one message's image blocks. */
async function anthropicUserParts(
  blocks: readonly ContentBlock[],
  attachments?: AttachmentStore,
): Promise<AnthropicContentBlock[]> {
  const images = imageBlocksOf(blocks)
  if (images.length === 0) return []
  if (attachments === undefined) {
    throw new LlmError('newapi image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const parts: AnthropicContentBlock[] = []
  for (const block of images) parts.push(await anthropicImageBlock(block, attachments))
  return parts
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
 * @param attachments - the durable attachment store, required when any message carries an image.
 * @returns the chat-completions request body.
 */
export async function serializeChatRequest(
  options: GenerateOptions,
  model: WireModel,
  reasoningEffort?: string,
  attachments?: AttachmentStore,
): Promise<WireRequest> {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({
      role: model.compat.supportsDeveloperRole === true ? 'developer' : 'system',
      content: options.system,
    })
  }
  messages.push(...await serializeMessages(options.messages, false, attachments) as WireMessage[])

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
 * @param attachments - the durable attachment store, required when any message carries an image.
 * @returns the messages request body.
 */
export async function serializeAnthropicRequest(
  options: GenerateOptions,
  model: WireModel,
  _reasoningEffort?: string,
  attachments?: AttachmentStore,
): Promise<AnthropicRequest> {
  const messages = await serializeMessages(options.messages, true, attachments) as AnthropicMessage[]
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
