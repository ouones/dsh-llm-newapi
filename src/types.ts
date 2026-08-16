/**
 * New API wire formats for the OpenAI chat-completions and Anthropic messages
 * routes. Types only. The OpenAI side follows the chat.completion.chunk SSE
 * vocabulary (delta/reasoning_content/tool_calls/usage); the Anthropic side
 * follows the messages SSE event vocabulary (message_start, content_block_*,
 * message_delta, message_stop). Both are relay dialects: New API passes the
 * upstream payload through, so the types cover the fields this adapter reads
 * or writes, with everything else optional.
 *
 * @module dsh-llm-newapi/types
 */

/** Request body for `POST {baseURL}/v1/chat/completions` (OpenAI completions route). */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  /**
   * Output-token cap. The field name is a compat decision: New API upstreams
   * overwhelmingly accept `max_tokens`; `max_completion_tokens` is the
   * o-series spelling some relays pass through.
   */
  max_tokens?: number
  max_completion_tokens?: number
  /** Reasoning effort, when the endpoint accepts it (`compat.supportsReasoningEffort`). */
  reasoning_effort?: string
  /**
   * Stop sequences (OpenAI `stop`): generation halts as soon as the model
   * produces any one of these strings. Mapped from `GenerateOptions.stop`.
   */
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** Developer-role message: the OpenAI reasoning-model spelling of the system prompt. */
export interface WireDeveloperMessage {
  role: 'developer'
  content: string
}

/** One content part of an OpenAI vision user message. */
export interface WireImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** One text part of an OpenAI vision user message. */
export interface WireTextPart {
  type: 'text'
  text: string
}

/** User-role message: a single string, or an array of vision parts when it carries an image. */
export interface WireUserMessage {
  role: 'user'
  content: string | (WireTextPart | WireImagePart)[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireDeveloperMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/**
 * Assistant-role history message. The harness replays `content: ""` (never
 * null) on tool-call-only turns — some gateways reject null — and sends null
 * only when the turn carried neither text nor tool calls.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: WireToolCall[]
}

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /** CoT (the `reasoning_content` spelling a relay passes through); absent entirely in non-thinking mode. */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

/**
 * Wire token accounting. `prompt_tokens` INCLUDES cache hits; `mapUsage`
 * subtracts them to keep the harness convention of disjoint counts.
 * `prompt_tokens_details.cached_tokens` is the OpenAI-compat spelling of the
 * hit count.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}

/** Request body for `POST {baseURL}/v1/messages` (Anthropic messages route). */
export interface AnthropicRequest {
  model: string
  /** Output-token cap; Anthropic requires it. */
  max_tokens: number
  /** System prompt; Anthropic has no developer role. */
  system?: string
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  stream: true
  temperature?: number
  /** Stop sequences (Anthropic `stop_sequences`), mapped from `GenerateOptions.stop`. */
  stop_sequences?: string[]
}

/** User- or assistant-role history message. */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

/**
 * One content block. Tool results ride in user messages as `tool_result`
 * blocks; assistant tool calls are `tool_use` blocks; `thinking` carries the
 * CoT channel.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
    type: 'tool_result'
    tool_use_id: string
    /** `content` must be a string or a list of content blocks (text, and image on vision routes); `is_error` marks a failed call. */
    content: string | AnthropicContentBlock[]
    is_error?: boolean
  }
  | { type: 'thinking'; thinking: string; signature?: string }

/** One entry of the request `tools` array; `input_schema` is a JSON Schema object. */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** One parsed SSE `event:` + `data:` payload of the Anthropic messages stream. */
export interface AnthropicResponseEvent {
  type:
    | 'message_start'
    | 'message_delta'
    | 'message_stop'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'ping'
    | 'error'
  /** The streamed message (`message_start`), or `message_delta` fields. */
  message?: { usage?: AnthropicUsage }
  /** Index of the block this event addresses (content_block_* events). */
  index?: number
  /** Block header (`content_block_start`) or terminal block (`content_block_stop`). */
  content_block?: AnthropicContentBlock
  /** Incremental content fragment (`content_block_delta`). */
  delta?: AnthropicDelta
  /** Terminal delta fields (`message_delta`). */
  usage?: AnthropicUsage
  stop_reason?: string
  /** Provider error payload (`error` event). */
  error?: { type?: string; message?: string }
}

/** The incremental content of one streamed block (`content_block_delta`). */
export interface AnthropicDelta {
  type: 'text_delta' | 'thinking_delta' | 'input_json_delta'
  /** text_delta: the visible text fragment. */
  text?: string
  /** thinking_delta: the CoT fragment (Anthropic's `thinking` field). */
  thinking?: string
  /** thinking_delta: the signature fragment, when the upstream sends one. */
  signature?: string
  /** input_json_delta: a tool-argument JSON fragment (concatenate across deltas). */
  partial_json?: string
}

/** Anthropic wire token accounting; `cache_*` counts are disjoint from the base counts. */
export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
