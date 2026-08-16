import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { CallId, EMPTY_RESPONSE_CODE, INVALID_CREDENTIAL_CODE, LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, normalizeApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
//#region lib/types/catalog.js
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
/** Every request modality a profile may declare. */
const MODALITIES = ["text", "image"];
/** Reasoning levels a route or model may offer, in escalation order. */
const THINKING_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** The out-of-the-box effort map: all five levels, each wiring its own name. */
function defaultThinkingLevels() {
	return Object.fromEntries(THINKING_LEVELS.map((level) => [level, level]));
}
/** Reasoning-dispatch wire formats a profile may name, most-reached first. */
const SUPPORTED_THINKING_FORMATS = [
	"openai",
	"deepseek",
	"openrouter",
	"together",
	"zai",
	"qwen",
	"string-thinking",
	"ant-ling"
];
/** Wire protocols a New API route may name. */
const SUPPORTED_PROTOCOLS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages"
];
/** Report a route the deployment cannot serve, naming the settings key at fault. */
function invalid(provider, detail) {
	throw new Error(`llm-newapi: provider "${provider}" ${detail}`);
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
function routeModelApi(id, discoveredEndpoints, request) {
	for (const [source, api] of request.modelApiOverrides ?? []) {
		let regex;
		try {
			regex = new RegExp(source);
		} catch (error) {
			throw new Error(`llm-newapi: provider "${request.provider}" modelApiOverrides "${source}" is not a valid regular expression: ${String(error)}`);
		}
		if (regex.test(id)) return api;
	}
	if (request.api !== void 0) return request.api;
	if (discoveredEndpoints === void 0) return void 0;
	if (discoveredEndpoints.includes("openai")) return "openai-completions";
	if (discoveredEndpoints.includes("anthropic")) return "anthropic-messages";
}
/**
* Resolve one model's reasoning capability from its declared efforts.
* A declared dict translates to a `thinkingLevelMap` with every level decided
* explicitly: declared levels carry their wire spelling, undeclared levels are
* pinned to `null` (unsupported).
* @param provider - provider route key, for diagnostics.
* @param entry - the configured model entry.
* @param discovered - the discovered catalog entry of the same id, when one exists.
* @returns the reasoning fields the materialized model carries.
*/
function resolveModelReasoning(provider, entry, discovered) {
	const efforts = entry.reasoningEfforts;
	if (efforts === void 0) return discovered?.reasoning === true ? {
		reasoning: true,
		thinkingLevelMap: defaultThinkingLevels()
	} : { reasoning: discovered?.reasoning ?? false };
	if (efforts === false) return { reasoning: false };
	if (efforts === null || Object.keys(efforts).length === 0) invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set false for a non-reasoning model, or omit the field to keep the discovered capability`);
	const entries = Object.entries(efforts);
	const core = new Set(THINKING_LEVELS);
	for (const [level, wire] of entries) if (wire === null) {
		if (level !== "off") invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch should send; the level is declared offered`);
	} else if (wire.length === 0) invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`);
	const map = {};
	for (const level of THINKING_LEVELS) map[level] = efforts[level] ?? null;
	for (const [level, wire] of entries) if (!core.has(level)) map[level] = wire;
	return {
		reasoning: true,
		thinkingLevelMap: map
	};
}
/**
* The compat block for one materialized model. The plugin FORCES the safe
* defaults on every model — the reason llm-newapi exists — and lets an
* explicit configuration override them per field. Model-level switches win
* over the route's; a route-level default applies to every model on the route.
* @param entry - the configured model entry.
* @param route - the route-level switches, when any.
* @returns the resolved compat block with the three forced defaults decided.
*/
function resolveModelCompat(entry, route) {
	const thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat;
	const supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort;
	const supportsLongCacheRetention = entry.compat?.supportsLongCacheRetention ?? route?.supportsLongCacheRetention;
	return {
		...thinkingFormat === void 0 ? {} : { thinkingFormat },
		...supportsReasoningEffort === void 0 ? {} : { supportsReasoningEffort },
		supportsDeveloperRole: entry.compat?.supportsDeveloperRole ?? route?.supportsDeveloperRole ?? false,
		maxTokensField: entry.compat?.maxTokensField ?? route?.maxTokensField ?? "max_tokens",
		supportsStore: entry.compat?.supportsStore ?? route?.supportsStore ?? false,
		...supportsLongCacheRetention === void 0 ? {} : { supportsLongCacheRetention }
	};
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
function resolveModels(request, discoveredModels = []) {
	const { provider } = request;
	const discovered = new Map(discoveredModels.map((model) => [model.id, model]));
	const overrides = request.modelOverrides ?? {};
	if (discovered.size > 0) for (const [id, override] of Object.entries(overrides)) {
		if (id.length === 0) invalid(provider, "has a modelOverrides entry with an empty model id");
		if (!discovered.has(id)) invalid(provider, `modelOverrides names "${id}", which the discovered catalog does not describe`);
		if ("id" in override) invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`);
	}
	const configured = request.models;
	const entries = configured !== void 0 && configured.length > 0 ? configured : [...discovered.values()].map((model) => ({
		id: model.id,
		...overrides[model.id]
	}));
	if (entries.length === 0) invalid(provider, "resolves no models; the gateway disclosed none and no models are listed in configuration");
	const seen = /* @__PURE__ */ new Set();
	const configuredMaxTokens = /* @__PURE__ */ new Map();
	return {
		models: entries.map((entry) => {
			if (entry.id.length === 0) invalid(provider, "has a model with an empty id");
			if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`);
			seen.add(entry.id);
			const base = discovered.get(entry.id);
			const api = routeModelApi(entry.id, base?.endpoints, request);
			if (api === void 0) invalid(provider, `model "${entry.id}" needs an api; discovery did not advertise one, so set the route's api or a modelApiOverrides entry`);
			const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
			if (!Number.isInteger(contextWindow) || contextWindow <= 0) invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
			const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;
			if (!Number.isInteger(maxTokens) || maxTokens <= 0) invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`);
			if (entry.maxTokens !== void 0) configuredMaxTokens.set(entry.id, entry.maxTokens);
			return {
				id: entry.id,
				name: entry.name ?? base?.name ?? entry.id,
				api,
				provider,
				baseUrl: request.baseURL,
				input: entry.input ?? base?.input ?? [...request.defaultInput],
				contextWindow,
				maxTokens,
				...resolveModelReasoning(provider, entry, base),
				compat: resolveModelCompat(entry, request.compat)
			};
		}),
		configuredMaxTokens
	};
}
/** Build the advisory {@link LlmModelInfo} for one materialized model. */
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		inputModalities: [...model.input]
	};
}
//#endregion
//#region lib/types/serialize.js
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
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Read one image block's bytes and encode them as a data URI for the OpenAI wire. */
async function openAiImagePart(block, attachments) {
	const stored = await attachments.readImage(block.attachment);
	const base64 = Buffer.from(stored.data).toString("base64");
	return {
		type: "image_url",
		image_url: { url: `data:${stored.ref.mediaType};base64,${base64}` }
	};
}
/** Read one image block's bytes and build the Anthropic `image` source block. */
async function anthropicImageBlock(block, attachments) {
	const stored = await attachments.readImage(block.attachment);
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: stored.ref.mediaType,
			data: Buffer.from(stored.data).toString("base64")
		}
	};
}
/**
* Serialize one assistant message for the OpenAI wire (text + tool calls).
* Text-less turns send "" — NEVER null; some gateways reject null outright.
* Reasoning blocks have no OpenAI replay channel, so they are dropped.
*/
function serializeAssistantOpenAi(message) {
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: flattenText(message.content),
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize one assistant message for the Anthropic wire. Text becomes a text
* block, tool calls become `tool_use` blocks; reasoning blocks have no
* Anthropic replay channel, so they are dropped.
*/
function serializeAssistantAnthropic(message) {
	const content = [];
	const text = flattenText(message.content);
	if (text.length > 0) content.push({
		type: "text",
		text
	});
	for (const call of message.content.filter((block) => block.type === "tool-call")) content.push({
		type: "tool_use",
		id: call.id,
		name: call.name,
		input: parseArguments(call.arguments)
	});
	return {
		role: "assistant",
		content
	};
}
/**
* Parse a tool-call argument JSON string into the object Anthropic's
* `input` field requires. A parse failure is a broken model turn, not a
* caller bug: the arguments were model-produced and are already durably
* logged, so the message refuses loudly instead of silently degrading.
*/
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return {};
	} catch {
		throw new LlmError(`Cannot replay tool-call arguments as an Anthropic input object: ${raw.slice(0, 120)}`, "INVALID_ARGS");
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
async function serializeMessages(messages, anthropic, attachments) {
	const wire = [];
	for (const message of messages) {
		if (contentHasImage(message.content) && attachments === void 0) throw new LlmError("newapi image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
		if (message.role === "system") {
			if (anthropic) continue;
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(anthropic ? serializeAssistantAnthropic(message) : serializeAssistantOpenAi(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (anthropic) {
			const blocks = [];
			if (text.length > 0) blocks.push({
				type: "text",
				text
			});
			for (const part of await anthropicUserParts(message.content, attachments)) blocks.push(part);
			for (const result of toolResults) {
				const resultContent = [];
				const resultText = flattenText(result.content);
				if (resultText.length > 0) resultContent.push({
					type: "text",
					text: resultText
				});
				for (const part of await anthropicUserParts(result.content, attachments)) resultContent.push(part);
				if (resultContent.length === 0) resultContent.push({
					type: "text",
					text: "(no output)"
				});
				blocks.push({
					type: "tool_result",
					tool_use_id: result.toolCallId,
					content: resultContent,
					...result.isError === true ? { is_error: true } : {}
				});
			}
			if (blocks.length > 0) wire.push({
				role: "user",
				content: blocks
			});
			continue;
		}
		const imageParts = await openAiUserParts(message.content, attachments);
		if (imageParts !== void 0 || text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: openAiUserContent(text, imageParts)
		});
		for (const result of toolResults) {
			const resultImages = await openAiUserParts(result.content, attachments);
			wire.push({
				role: "tool",
				tool_call_id: result.toolCallId,
				content: openAiToolContent(flattenText(result.content), resultImages)
			});
		}
	}
	return wire;
}
/** The image blocks a message carries, or `undefined` when it carries none. */
function imageBlocksOf(blocks) {
	if (!contentHasImage(blocks)) return [];
	return blocks.filter((block) => block.type === "image");
}
/** Build the OpenAI image_url parts for one message. */
async function openAiUserParts(blocks, attachments) {
	const images = imageBlocksOf(blocks);
	if (images.length === 0) return void 0;
	if (attachments === void 0) throw new LlmError("newapi image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
	const parts = [];
	for (const block of images) parts.push(await openAiImagePart(block, attachments));
	return parts;
}
/** The OpenAI user content value: a plain string when text-only, else a parts array. */
function openAiUserContent(text, imageParts) {
	if (imageParts === void 0) return text;
	return [...text.length > 0 ? [{
		type: "text",
		text
	}] : [], ...imageParts];
}
/**
* The OpenAI tool-role content: always a plain string, because `image_url`
* parts are not a tool-message wire shape. An image in a tool result is
* therefore DEGRADED to a fixed text marker (`image attached`) — the model never
* receives those pixels on the OpenAI tool wire. Any callers relying on
* image-understanding in tool results should prefer the Anthropic route, which
* carries tool-result images as real `image` blocks.
*/
function openAiToolContent(text, imageParts) {
	if (imageParts === void 0) return text || "(no output)";
	return [text.length > 0 ? text : "(no output)", ...imageParts.map(() => "image attached")].join("\n");
}
/** The Anthropic user content blocks for one message's image blocks. */
async function anthropicUserParts(blocks, attachments) {
	const images = imageBlocksOf(blocks);
	if (images.length === 0) return [];
	if (attachments === void 0) throw new LlmError("newapi image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
	const parts = [];
	for (const block of images) parts.push(await anthropicImageBlock(block, attachments));
	return parts;
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
async function serializeChatRequest(options, model, reasoningEffort, attachments) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: model.compat.supportsDeveloperRole === true ? "developer" : "system",
		content: options.system
	});
	messages.push(...await serializeMessages(options.messages, false, attachments));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const maxTokens = options.maxTokens ?? model.maxTokens;
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...model.compat.maxTokensField === "max_completion_tokens" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens },
		...reasoningEffort !== void 0 ? { reasoning_effort: reasoningEffort } : {},
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
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
async function serializeAnthropicRequest(options, model, _reasoningEffort, attachments) {
	const messages = await serializeMessages(options.messages, true, attachments);
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters
	}));
	return {
		model: options.model,
		max_tokens: options.maxTokens ?? model.maxTokens,
		...options.system !== void 0 ? { system: options.system } : {},
		messages,
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		stream: true,
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.stop !== void 0 ? { stop_sequences: options.stop } : {}
	};
}
/**
* Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
* value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
* without it (truncated response — the model call cannot be trusted).
* @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
* @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
*/
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
/**
* Map the OpenAI wire finish_reason vocabulary to the harness FinishReason.
* @param reason - the wire `finish_reason` string.
* @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map the Anthropic wire stop_reason vocabulary to the harness FinishReason.
* @param reason - the wire `stop_reason` string.
* @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as `code`.
*/
function mapAnthropicStopReason(reason) {
	switch (reason) {
		case "end_turn": return { kind: "stop" };
		case "max_tokens": return { kind: "max-tokens" };
		case "tool_use": return { kind: "tool-calls" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map OpenAI wire usage fields. The harness TokenUsage convention is DISJOINT
* counts, and OpenAI-compatible relays report cache hits inside
* `prompt_tokens`, so cache reads are subtracted out of `inputTokens`.
* @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
* @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
*/
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/**
* Map Anthropic wire usage fields. Unlike OpenAI-compatible relays, Anthropic
* reports cache counts DISJOINT from `input_tokens`, so no subtraction is
* needed to reach the harness convention.
* @param usage - wire usage from the `message_start` or `message_delta` event.
* @returns harness counts; cache fields present only when the wire reported them.
*/
function mapAnthropicUsage(usage) {
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		...usage.cache_read_input_tokens !== void 0 ? { cacheReadTokens: usage.cache_read_input_tokens } : {},
		...usage.cache_creation_input_tokens !== void 0 ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* The empty-response finish both translators emit when a stream completes
* with a stop but opened no content block.
*/
function emptyFinish() {
	return {
		kind: "error",
		failure: {
			message: "model returned a completed response with no content",
			code: EMPTY_RESPONSE_CODE
		}
	};
}
/**
* Parse one SSE data payload as a wire chunk; malformed JSON aborts the
* stream with `MALFORMED_RESPONSE`.
* @param payload - one SSE `data:` payload.
* @returns the parsed chunk.
*/
function parseChunk(payload) {
	try {
		return JSON.parse(payload);
	} catch {
		throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
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
async function* translateChat(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? emptyFinish() : reason
			};
			return;
		}
		const chunk = parseChunk(payload);
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
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
async function* translateAnthropic(payloads) {
	const blocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind, index) {
		const block = {
			index,
			kind,
			text: ""
		};
		blocks.set(index, block);
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		switch (event.type) {
			case "message_start": {
				const usage = event.message?.usage;
				if (usage) pendingUsage = mapAnthropicUsage(usage);
				break;
			}
			case "content_block_start": {
				const block = event.content_block;
				if (block === void 0 || event.index === void 0) break;
				let kind;
				switch (block.type) {
					case "text":
						kind = "text";
						break;
					case "thinking":
						kind = "reasoning";
						break;
					case "tool_use":
						kind = "tool-call";
						break;
					default: continue;
				}
				const openBlock = open(kind, event.index);
				if (block.type === "tool_use") {
					openBlock.callId = block.id;
					openBlock.name = block.name;
					openBlock.text = "";
				}
				yield {
					type: "block-start",
					index: openBlock.index,
					blockType: kind
				};
				break;
			}
			case "content_block_delta": {
				const block = blocks.get(event.index ?? -1);
				const delta = event.delta;
				if (block === void 0 || delta === void 0) break;
				if (delta.type === "text_delta" && delta.text !== void 0 && delta.text.length > 0) {
					block.text += delta.text;
					yield {
						type: "text-delta",
						index: block.index,
						text: delta.text
					};
				} else if (delta.type === "thinking_delta" && delta.thinking !== void 0 && delta.thinking.length > 0) {
					block.text += delta.thinking;
					yield {
						type: "reasoning-delta",
						index: block.index,
						text: delta.thinking
					};
				} else if (delta.type === "input_json_delta" && delta.partial_json !== void 0) {
					const fragment = delta.partial_json;
					block.text += fragment;
					yield {
						type: "tool-call-delta",
						index: block.index,
						id: CallId(block.callId ?? ""),
						...block.name !== void 0 ? { name: block.name } : {},
						argumentsDelta: fragment
					};
				}
				break;
			}
			case "content_block_stop": {
				const block = blocks.get(event.index ?? -1);
				if (block === void 0) break;
				yield {
					type: "block-end",
					index: block.index,
					block: closeBlock(block)
				};
				blocks.delete(block.index);
				break;
			}
			case "message_delta":
				if (typeof event.stop_reason === "string") pendingFinish = mapAnthropicStopReason(event.stop_reason);
				if (event.usage) pendingUsage = mapAnthropicUsage(event.usage);
				break;
			case "message_stop": {
				if (pendingUsage) yield {
					type: "usage",
					usage: pendingUsage
				};
				const reason = pendingFinish ?? { kind: "stop" };
				yield {
					type: "finish",
					reason: reason.kind === "stop" && order.length === 0 ? emptyFinish() : reason
				};
				return;
			}
			case "ping": break;
			case "error": {
				const message = event.error?.message ?? "Anthropic messages stream error";
				throw new LlmError(message, event.error?.type?.toUpperCase() ?? "API_ERROR");
			}
		}
	}
	throw new LlmError("SSE payload stream ended without message_stop", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/adapter.js
/**
* New API adapter: streams model calls through the harness LLM seam against a
* self-hosted New API gateway, speaking OpenAI Chat Completions and Anthropic
* Messages directly over fetch.
*
* Each operation reads the current resolved profiles, so a configuration
* change reaches the next request without a restart; model descriptors come
* from the catalog those profiles built.
*
* @module dsh-llm-newapi/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Prefer `medium` when a route declares it, otherwise the first declared level. */
function preferMedium(keys) {
	if (keys.length === 0) return void 0;
	return keys.includes("medium") ? "medium" : keys[0];
}
/** The route-level reasoning default this model can actually take, for describing it. */
function describableReasoningLevel(model, effort) {
	if (effort === void 0 || !model.reasoning) return void 0;
	return preferMedium(Object.keys(effort));
}
/** The compat block as the serializers read it (every forced field decided). */
function wireModelOf(model) {
	return {
		api: model.api,
		compat: model.compat,
		baseUrl: model.baseUrl,
		maxTokens: model.maxTokens
	};
}
/** Resolve the harness effort against the model's offered levels and wire spellings. */
function resolveReasoningEffort(model, profile, requested) {
	const map = model.thinkingLevelMap;
	if (map === void 0 || !model.reasoning) return {
		wire: void 0,
		offered: false
	};
	if (requested === void 0) {
		const level = preferMedium(Object.keys(profile.reasoning ?? {}));
		if (level === void 0) return {
			wire: void 0,
			offered: false
		};
		const fallback = map[level];
		return fallback === null || fallback === void 0 ? {
			wire: void 0,
			offered: false
		} : {
			wire: fallback,
			offered: true
		};
	}
	const wire = map[requested];
	if (wire === null || wire === void 0) {
		if (requested === "off") return {
			wire: void 0,
			offered: true
		};
		throw new LlmError(`New API provider "${model.provider}" model "${model.id}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
	}
	return {
		wire,
		offered: true
	};
}
/** The selectable reasoning efforts for one model, or nothing. */
function reasoningInfo(model, defaultLevel) {
	if (!model.reasoning || model.thinkingLevelMap === void 0) return {};
	const levels = Object.keys(model.thinkingLevelMap).filter((level) => {
		const wire = model.thinkingLevelMap?.[level];
		return wire !== null && wire !== void 0;
	});
	if (levels.length === 0) return {};
	const defaultEffort = defaultLevel === void 0 ? void 0 : levels.includes(defaultLevel) ? defaultLevel : levels[0];
	return { reasoning: {
		efforts: levels.map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		})),
		...defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }
	} };
}
/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers) {
	const attribution = attributionHeaders();
	const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
	return {
		...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
		...attribution
	};
}
/**
* New API-backed adapter. Each operation reads the current profiles, so a
* configuration change reaches the next request without a restart; model
* descriptors come from the catalog those profiles built.
*/
var NewApiAdapter = class extends LlmAdapter {
	config;
	snapshot;
	constructor(config) {
		super();
		this.config = config;
	}
	/**
	* The snapshot for the current profiles. Resolution memoizes its result, so
	* an unchanged configuration is recognized by identity.
	*/
	current() {
		const profiles = this.config.profiles();
		if (this.snapshot?.profiles === profiles) return this.snapshot;
		this.snapshot = { profiles };
		return this.snapshot;
	}
	/** The profile for one route within one snapshot, or the not-owned failure. */
	profileOf(snapshot, provider) {
		const profile = snapshot.profiles.get(provider);
		if (profile === void 0) throw new LlmError(`newapi adapter does not own provider "${provider}"`, "NO_ADAPTER");
		return profile;
	}
	/** The configured descriptor for one exact route/model pair within one snapshot. */
	modelOf(snapshot, provider, model) {
		this.profileOf(snapshot, provider);
		const resolved = snapshot.profiles.get(provider)?.models.find((entry) => entry.id === model);
		if (resolved === void 0) throw new LlmError(`newapi provider "${provider}" has no configured model "${model}"`, "UNKNOWN_MODEL");
		return resolved;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.current().profiles.get(provider)?.displayName ?? provider
		};
	}
	providerRetryPolicy(provider) {
		return this.current().profiles.get(provider)?.retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			this.profileOf(snapshot, provider);
			return (snapshot.profiles.get(provider)?.models ?? []).map((model) => modelInfo(provider, model));
		});
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			const profile = this.profileOf(snapshot, provider);
			const resolvedModel = this.modelOf(snapshot, provider, model);
			const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
			const configuredMaxTokens = profile.configuredMaxTokens.get(model);
			return {
				provider,
				id: model,
				name: resolvedModel.name,
				inputModalities: [...resolvedModel.input],
				context: { contextWindow: resolvedModel.contextWindow },
				...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
				...reasoningInfo(resolvedModel, defaultLevel)
			};
		});
	}
	async *stream(options) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			if (options.stop !== void 0) throw new LlmError("llm-newapi does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
			const snapshot = this.current();
			const profile = this.profileOf(snapshot, options.provider);
			const model = this.modelOf(snapshot, options.provider, options.model);
			const reasoning = resolveReasoningEffort(model, profile, options.reasoningEffort?.toString());
			const apiKey = await this.config.resolveApiKey(options.provider, profile);
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const streamIdleTimeoutMs = profile.streamIdleTimeoutMs;
			const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"), false);
			try {
				const containsImage = options.messages.some((message) => contentHasImage(message.content));
				if (containsImage && !model.input.includes("image")) throw new LlmError(`newapi model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
				const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
				if (containsImage && attachments === void 0) throw new LlmError("newapi image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const url = model.api === "anthropic-messages" ? `${model.baseUrl.replace(/\/+$/, "")}/v1/messages` : `${model.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
				const headers = {
					accept: "text/event-stream",
					"content-type": "application/json",
					...requestHeaders(profile.headers),
					...apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` }
				};
				if (model.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
				const body = model.api === "anthropic-messages" ? await serializeAnthropicRequest(options, wireModelOf(model), reasoning.wire, attachments) : await serializeChatRequest(options, wireModelOf(model), reasoning.wire, attachments);
				let response;
				try {
					response = await fetch(url, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: watchdog.signal
					});
				} catch (error) {
					if (watchdog.signal.aborted || options.signal?.aborted) throw new LlmError("newapi request aborted by caller", "ABORTED", { cause: error });
					throw new LlmError(`could not reach ${url}`, "TRANSPORT", { cause: error });
				}
				if (!response.ok) {
					const text = await response.text().catch(() => "");
					const message = text.length > 0 ? `${url} answered ${response.status}: ${text.slice(0, 200)}` : `${url} answered ${response.status}`;
					const code = response.status === 401 || response.status === 403 ? "AUTH" : response.status === 429 ? "RATE_LIMIT" : response.status >= 500 ? "SERVER" : "INVALID_REQUEST";
					throw new LlmError(message, code, { status: response.status });
				}
				if (response.body === null) throw new LlmError(`${url} returned no response body`, "TRANSPORT");
				const payloads = parseSse(response.body);
				const iterator = (model.api === "anthropic-messages" ? translateAnthropic(payloads) : translateChat(payloads))[Symbol.asyncIterator]();
				let exhausted = false;
				try {
					while (true) {
						const result = await watchdog.next(iterator);
						const timeout = timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT");
						if (timeout !== void 0) throw timeout;
						if (result.done) {
							exhausted = true;
							return;
						}
						yield result.value;
					}
				} finally {
					if (!exhausted) {
						consumer.abort("newapi stream consumer stopped");
						try {
							await iterator.return(void 0);
						} catch (_abortedSdkTeardown) {}
					}
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`newapi stream idle timeout after ${streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("newapi request aborted by caller", "ABORTED", { cause: error });
				throw error;
			} finally {
				consumer.abort("newapi stream consumer stopped");
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
};
//#endregion
//#region lib/types/config.js
/**
* Configuration schema and provider-profile resolution for the New API adapter.
* Profiles are a dict keyed by provider route, so the composition base and a
* user-settings layer merge per provider and the route set is structural.
*
* A route names a self-hosted New API gateway. The gateway speaks OpenAI
* Chat Completions and/or Anthropic Messages; a route declares its endpoint
* and the wire protocol(s) its models speak. Model metadata — capacities,
* reasoning, compat — is declared in configuration or discovered from the
* gateway's `/v1/models` listing; nothing is guessed from the endpoint URL.
*
* @module dsh-llm-newapi/config
*/
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Context capacity assumed for a model neither configuration nor discovery sizes. */
const DEFAULT_CONTEXT_WINDOW = 262144;
/** Output capability assumed for a model neither configuration nor discovery sizes. */
const DEFAULT_MAX_TOKENS = 32768;
/**
* Modalities assumed for a model neither configuration nor discovery
* declares. Text is the floor every supported protocol certainly carries.
*/
const DEFAULT_INPUT = ["text"];
const thinkingBudgets = z.object({
	minimal: z.number(),
	low: z.number(),
	medium: z.number(),
	high: z.number()
});
const compatProfile = z.object({
	thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
	supportsReasoningEffort: z.boolean(),
	supportsDeveloperRole: z.boolean().default(false),
	maxTokensField: z.union(["max_tokens", "max_completion_tokens"]),
	supportsStore: z.boolean(),
	supportsLongCacheRetention: z.boolean()
});
/**
* Keys are the offered levels, values their wire spellings. The five core
* levels are the out-of-the-box set; extra keys (e.g. the upstream's `off`)
* pass through rather than being promoted to a fixed enum. Nullable members
* survive validation because schemastery passes nullable data through before
* any member schema runs; the catalog rejects a stated-but-valueless non-`off`
* level and lets a valueless `off` mean "supported, send nothing".
*/
const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.string());
/** The fields a `models` entry and a `modelOverrides` value share; only the id's home differs. */
const modelFields = {
	name: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	input: z.array(z.union(MODALITIES)),
	reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
	compat: compatProfile
};
const modelProfile = z.object({
	id: z.string().required(),
	...modelFields
});
/** A {@link modelProfile} whose id lives in the `modelOverrides` dict key. */
const modelOverride = z.object(modelFields);
const profile = z.object({
	apiKeyEnv: z.string().role("credential-ref"),
	displayName: z.string(),
	baseURL: z.string().required(),
	api: z.union(SUPPORTED_PROTOCOLS),
	models: z.array(modelProfile),
	modelOverrides: z.dict(modelOverride),
	modelApiOverrides: z.dict(z.union(SUPPORTED_PROTOCOLS)),
	compat: compatProfile,
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
	headers: z.dict(z.string()),
	reasoning: reasoningEfforts,
	thinkingBudgets,
	timeoutMs: z.natural(),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/** Runtime schema for {@link Config}. */
const Config = z.object({ providers: z.dict(profile).default({}) });
/**
* Reject a section this adapter could not serve. Registered as the settings
* namespace's validator, so an unserviceable profile is refused where it is
* *written* instead of being stored and then quietly disabling every route
* in the namespace.
* @param config - the resolved section to check.
* @throws Error naming the route and model that cannot be served.
*/
function assertServiceable(config) {
	resolveProfiles(config.providers);
}
/**
* Validate profiles and return a detached route-keyed map suitable for
* per-request reads. This is the one explicit resolve step: an omitted dict
* resolves to the empty (dormant) route set, and each route's models are
* materialized once with compat injected.
* @param providers - configured provider profiles keyed by route.
* @returns validated profiles in configuration order.
*/
function resolveProfiles(providers) {
	if (Array.isArray(providers)) throw new Error("llm-newapi: providers is now a dict keyed by provider route, not an array of profiles");
	const entries = Object.entries(providers ?? {});
	const resolved = /* @__PURE__ */ new Map();
	for (const [provider, source] of entries) {
		if (provider.length === 0) throw new Error("llm-newapi: provider names must be non-empty");
		if (source.baseURL.length === 0) throw new Error(`llm-newapi: provider "${provider}" has an empty baseURL`);
		if (source.displayName !== void 0 && source.displayName.length === 0) throw new Error(`llm-newapi: provider "${provider}" has an empty displayName`);
		const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? 3e5;
		if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-newapi: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
		const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT];
		if (defaultInput.length === 0) throw new Error(`llm-newapi: provider "${provider}" defaultInput must name at least one modality`);
		const displayName = source.displayName ?? provider;
		const modelApiOverrides = new Map(Object.entries(source.modelApiOverrides ?? {}));
		const catalog = resolveModels({
			provider,
			...source.api === void 0 ? {} : { api: source.api },
			baseURL: source.baseURL,
			...source.models === void 0 ? {} : { models: source.models },
			...source.modelOverrides === void 0 ? {} : { modelOverrides: source.modelOverrides },
			...source.modelApiOverrides === void 0 ? {} : { modelApiOverrides },
			...source.compat === void 0 ? {} : { compat: source.compat },
			defaultInput,
			defaultContextWindow: source.defaultContextWindow ?? 262144,
			defaultMaxTokens: source.defaultMaxTokens ?? 32768
		});
		const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source;
		resolved.set(provider, {
			provider,
			displayName,
			baseURL: source.baseURL,
			...source.api === void 0 ? {} : { api: source.api },
			modelApiOverrides,
			...apiKeyEnv === void 0 ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
			streamIdleTimeoutMs,
			retryPolicy: resolveRetryPolicy(retryPolicy, `llm-newapi: provider "${provider}" retryPolicy`),
			models: catalog.models,
			configuredMaxTokens: catalog.configuredMaxTokens,
			...rest.reasoning === void 0 ? {} : { reasoning: rest.reasoning },
			...rest.thinkingBudgets === void 0 ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
			...rest.timeoutMs === void 0 ? {} : { timeoutMs: rest.timeoutMs },
			...rest.headers === void 0 ? {} : { headers: { ...rest.headers } }
		});
	}
	return resolved;
}
//#endregion
//#region lib/types/discovery.js
/**
* Answering "which models can this gateway serve?" for the configuration
* surface's "fetch available models" action. A New API gateway is interrogated
* over the wire — unlike pi-ai, this adapter ships no registry, so the
* gateway's own `/v1/models` listing is the only authority for its models.
*
* Nothing here is stored: the request carries a draft the user is still
* editing, and the reply is candidate metadata the surface offers for
* adoption. `settings.yaml` remains the only thing that decides what a route
* serves.
*
* Only the OpenAI-compatible listing shape is read: it is the one dialect New
* API speaks for model discovery, and it carries the endpoint types
* (`supported_endpoint_types`) this adapter needs to route each model onto a
* wire protocol. Cost ratios and protocol routing are deliberately absent —
* the former was cut from the design, and the latter lives in
* `catalog.ts`'s {@link routeModelApi}.
*
* @module dsh-llm-newapi/discovery
*/
/**
* Endpoint replies larger than this are refused. The endpoint is whatever URL
* the user typed, so the ceiling holds on the bytes actually read rather than
* on the length the server claims — the same two-stage shape `dsh-web-fetch`
* uses for its own caller-supplied URLs, except that a truncated model listing
* is not parseable, so overflow rejects instead of truncating.
*/
const MAX_RESPONSE_BYTES = 10485760;
/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
}
/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates) {
	for (const candidate of candidates) if (typeof candidate === "string" && candidate.length > 0) return candidate;
}
/**
* The endpoint types a listing entry advertises. A non-string member is
* dropped rather than failing the row: New API's spelling is the only one
* known, and a malformed member should not deny the rest of the entry.
*/
function endpointTypes(raw) {
	if (!Array.isArray(raw)) return void 0;
	const types = raw.filter((type) => typeof type === "string" && type.length > 0);
	return types.length === 0 ? void 0 : types;
}
/**
* The request modalities a listing entry advertises. New API discloses a list
* that may name `image`; any entry accepting images is offered both text and
* image, and one that does not is offered text alone.
*/
function modalities(raw) {
	if (!Array.isArray(raw)) return void 0;
	if (raw.some((type) => type === "image")) return ["text", "image"];
}
/**
* Join the endpoint base with the listing path. The base is treated as a
* prefix rather than a URL to resolve against, so a deployment path such as
* `https://gateway.example/openai/v1` keeps its segments instead of losing
* them to `URL` resolution.
*/
function listingUrl(baseURL) {
	return `${baseURL.replace(/\/+$/, "")}/v1/models`;
}
/**
* Read a reply body, refusing one that outgrows the ceiling. A declared length
* is checked first so an honest server is turned away without transferring
* anything; the accumulated total is what actually enforces the bound, because
* a server that under-declares (or streams) tells us nothing up front.
*/
async function readBounded(response, url) {
	const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, "DISCOVERY_FAILED");
	const declared = Number(response.headers.get("content-length") ?? NaN);
	if (Number.isFinite(declared) && declared > 10485760) {
		await response.body?.cancel();
		throw oversized();
	}
	/* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > 10485760) throw oversized();
			chunks.push(value);
		}
	} finally {
		/* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
		await reader.cancel().catch(() => {});
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}
/**
* Read one OpenAI-compatible listing reply. Entries without a usable id are
* skipped rather than failing the whole interrogation: a single malformed row
* should not deny the user the rest of a working gateway's catalog. Duplicate
* ids collapse onto the first entry, which is the one the gateway means.
*/
function readListing(body) {
	const data = body?.data;
	if (!Array.isArray(data)) throw new LlmError("the endpoint's model listing has no \"data\" array; enter this gateway's models by hand", "DISCOVERY_FAILED");
	const models = /* @__PURE__ */ new Map();
	for (const raw of data) {
		const entry = raw;
		const id = label(entry?.id);
		if (id === void 0 || models.has(id)) continue;
		const name = label(entry?.name, entry?.display_name);
		const endpoints = endpointTypes(entry?.supported_endpoint_types);
		const input = modalities(entry?.input_modalities);
		const contextWindow = capacity(entry?.context_window, entry?.context_length);
		const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens);
		const model = { id };
		if (name !== void 0) model.name = name;
		if (endpoints !== void 0) model.endpoints = endpoints;
		if (input !== void 0) model.input = input;
		if (contextWindow !== void 0) model.contextWindow = contextWindow;
		if (maxTokens !== void 0) model.maxTokens = maxTokens;
		models.set(id, model);
	}
	return [...models.values()];
}
/**
* Accept one probe key, or refuse it before the header is built. Without this
* the `fetch` below would throw a ByteString `TypeError` that this function's
* catch reports as `could not reach <url>` — blaming the network for a local,
* deterministic fault.
* @param raw - the key typed into the form or read from storage.
* @returns the trimmed, usable key.
*/
function usableProbeKey(raw) {
	const checked = normalizeApiKey(raw);
	if (checked.ok) return checked.value;
	throw new LlmError(checked.reason === "empty" ? "this gateway's API key is blank; enter it on the Models page, or clear it to probe unauthenticated" : "this gateway's API key contains characters no HTTP header can carry; paste the raw key only", INVALID_CREDENTIAL_CODE);
}
/**
* Interrogate one draft gateway endpoint for the models it advertises.
* @param request - the endpoint and one-shot credential to use.
* @param storedApiKey - the credential the named route already stored, asked
*   for only when the draft carries none and only on the path that reaches the
*   network. A configuration surface never holds a stored secret — it edits a
*   redacted descriptor — so without this an already-configured route would be
*   interrogated unauthenticated and answer 401.
* @returns the advertised models in endpoint order.
* @throws LlmError when the endpoint refuses or fails the request, or the
*   reply is not a model listing.
*/
async function discoverModels(request, storedApiKey) {
	if (request.baseURL === void 0 || request.baseURL.length === 0) throw new LlmError("a New API gateway's models can only come from its endpoint; set a baseURL, or enter this gateway's models by hand", "DISCOVERY_FAILED");
	const url = listingUrl(request.baseURL);
	const supplied = request.apiKey ?? await storedApiKey?.(request.provider);
	const apiKey = supplied === void 0 ? void 0 : usableProbeKey(supplied);
	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json",
				...apiKey === void 0 ? {} : { authorization: `Bearer ${apiKey}` },
				...attributionHeaders()
			},
			...request.signal === void 0 ? {} : { signal: request.signal }
		});
	} catch (error) {
		if (request.signal?.aborted) throw new LlmError("model discovery aborted by caller", "ABORTED", { cause: error });
		throw new LlmError(`could not reach ${url}`, "DISCOVERY_FAILED", { cause: error });
	}
	if (!response.ok) throw new LlmError(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? "; check the API key" : ""}`, "DISCOVERY_FAILED");
	let text;
	try {
		text = await readBounded(response, url);
	} catch (error) {
		if (request.signal?.aborted) throw new LlmError("model discovery aborted by caller", "ABORTED", { cause: error });
		throw error;
	}
	let body;
	try {
		body = JSON.parse(text);
	} catch (error) {
		throw new LlmError(`${url} did not answer with JSON`, "DISCOVERY_FAILED", { cause: error });
	}
	return readListing(body);
}
//#endregion
//#region lib/types/web.js
/**
* Web-profile routes for the llm-newapi Settings section. The browser never
* sees credential values; it reads and rewrites the redacted configuration the
* same settings seam already holds. Model candidates come straight from the
* gateway's own `/v1/models` listing, exactly as the models page interrogates
* a draft endpoint.
*
* @module dsh-llm-newapi/web
*/
/** Exact namespace the settings panel edits. */
const NS$1 = "llm-newapi";
/** The branded namespace the settings seam addresses. */
const NS_SCHEMA = settingsNamespace(NS$1);
/** Exact routes the bundled Web settings panel calls. */
const SETTINGS_ROUTE = "/_dsh/llm-newapi/settings";
const MODELS_ROUTE = "/_dsh/llm-newapi/models";
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function publicMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The settings seam's descriptor for this plugin's namespace. */
function descriptorOf(ctx) {
	const settings = ctx.get("settings");
	if (settings === void 0) throw new LlmError("llm-newapi settings seam is unavailable", "UNAVAILABLE");
	const descriptor = settings.describe().find((row) => row.ns === NS$1);
	if (descriptor === void 0) throw new LlmError("llm-newapi settings namespace is not registered", "UNAVAILABLE");
	return {
		value: descriptor.value,
		base: descriptor.base,
		user: descriptor.user,
		revision: descriptor.revision
	};
}
function responseJson(res, status, body) {
	const bytes = Buffer.from(JSON.stringify(body));
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Content-Length", String(bytes.length));
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.writeHead(status);
	res.end(bytes);
}
function requestError(res, status, code, message) {
	responseJson(res, status, { error: {
		code,
		message
	} });
}
/** Accept state-changing requests only from the DSH Web application's origin. */
function sameOriginPost(req) {
	const fetchSite = String(req.headers["sec-fetch-site"] ?? "");
	if (fetchSite === "cross-site") return false;
	const origin = req.headers.origin;
	const rawHost = req.headers.host;
	if (origin === void 0) return fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
	if (rawHost === void 0) return false;
	try {
		const parsed = new URL(String(origin));
		const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
	} catch {
		return false;
	}
}
async function readJson(req, maxBytes = 131072) {
	if (String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new TypeError("Content-Type must be application/json");
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += part.length;
		if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`);
		chunks.push(part);
	}
	if (chunks.length === 0) throw new TypeError("request body is empty");
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** A settings snapshot view returned to the panel. */
function settingsView(ctx) {
	const d = descriptorOf(ctx);
	return {
		writable: ctx.get("settings")?.writable === true,
		value: d.value,
		...d.base === void 0 ? {} : { base: d.base },
		...d.user === void 0 ? {} : { user: d.user },
		revision: d.revision
	};
}
/** Fill a SAME-ORIGIN exact route the model/base secret never crosses in the clear. */
async function handleSettings(req, res, ctx) {
	if (req.method === "GET") {
		responseJson(res, 200, settingsView(ctx));
		return;
	}
	if (req.method !== "POST") {
		res.setHeader("Allow", "GET, POST");
		requestError(res, 405, "method-not-allowed", "Use GET or POST");
		return;
	}
	if (!sameOriginPost(req)) {
		requestError(res, 403, "origin-rejected", "The request must originate from this DSH Web application");
		return;
	}
	const settings = ctx.get("settings");
	if (settings === void 0 || settings.writable !== true) {
		requestError(res, 400, "settings-conflict", "settings provider is read-only");
		return;
	}
	let parsed;
	try {
		parsed = await readJson(req);
	} catch (error) {
		requestError(res, error instanceof RangeError ? 413 : 400, "invalid-request", publicMessage(error));
		return;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.ops)) {
		requestError(res, 400, "invalid-request", "ops must be an array");
		return;
	}
	let expectedRevision;
	if (Number.isSafeInteger(parsed.expectedRevision) && parsed.expectedRevision >= 0) expectedRevision = parsed.expectedRevision;
	try {
		await settings.mutate(NS_SCHEMA, parsed.ops, expectedRevision);
		responseJson(res, 200, settingsView(ctx));
	} catch (error) {
		const conflict = /changed since it was read/.test(publicMessage(error));
		requestError(res, conflict ? 409 : 400, conflict ? "settings-conflict" : "settings-rejected", publicMessage(error));
	}
}
/** Interrogate one draft gateway for its advertised models. */
async function handleModels(req, res, ctx, deps) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		requestError(res, 405, "method-not-allowed", "Use POST");
		return;
	}
	if (!sameOriginPost(req)) {
		requestError(res, 403, "origin-rejected", "The request must originate from this DSH Web application");
		return;
	}
	let parsed;
	try {
		parsed = await readJson(req);
	} catch (error) {
		requestError(res, error instanceof RangeError ? 413 : 400, "invalid-request", publicMessage(error));
		return;
	}
	if (!isRecord(parsed) || typeof parsed.baseURL !== "string" || parsed.baseURL.length === 0) {
		requestError(res, 400, "invalid-request", "baseURL is required");
		return;
	}
	if (parsed.apiKey !== void 0 && typeof parsed.apiKey !== "string") {
		requestError(res, 400, "invalid-request", "apiKey must be a string");
		return;
	}
	const baseURL = parsed.baseURL;
	const provider = typeof parsed.provider === "string" ? parsed.provider : void 0;
	try {
		let apiKey;
		if (typeof parsed.apiKey === "string") {
			const check = normalizeApiKey(parsed.apiKey);
			if (!check.ok) throw new LlmError("this gateway's API key cannot be carried by an HTTP header", "INVALID_CREDENTIAL");
			apiKey = check.value;
		} else apiKey = await deps.storedApiKey?.(provider);
		responseJson(res, 200, { models: (await deps.discover(baseURL, apiKey, provider)).map((model) => ({
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name }
		})) });
	} catch (error) {
		ctx.logger.warn("llm-newapi models interrogation failed: %s", publicMessage(error));
		requestError(res, 400, "models-failed", publicMessage(error));
	}
}
/**
* Attach the Web routes a bundled Settings panel depends on. Mounts whenever a
* `webServer` service is present (Web profile); absent in headless runs.
* @param ctx - plugin context.
* @param deps - model-discovery and credential seams.
*/
function installLlmNewapiWeb(ctx, deps) {
	ctx.inject(["webServer", "settings"], (seam) => {
		seam.effect(() => {
			const webServer = seam.get("webServer");
			const disposeSettings = webServer.register({
				kind: "exact",
				path: SETTINGS_ROUTE,
				handler: async (req, res) => {
					try {
						await handleSettings(req, res, seam);
					} catch (error) {
						seam.logger.warn("llm-newapi settings route failed: %s", publicMessage(error));
						try {
							requestError(res, 400, "settings-rejected", publicMessage(error));
						} catch {}
					}
				}
			});
			const disposeModels = webServer.register({
				kind: "exact",
				path: MODELS_ROUTE,
				handler: async (req, res) => {
					try {
						await handleModels(req, res, seam, deps);
					} catch (error) {
						seam.logger.warn("llm-newapi models route failed: %s", publicMessage(error));
						try {
							requestError(res, 400, "models-failed", publicMessage(error));
						} catch {}
					}
				}
			});
			return () => {
				disposeModels?.();
				disposeSettings?.();
			};
		}, "llm-newapi: Web routes");
	});
}
//#endregion
//#region lib/types/index.js
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
*           low: low
*           medium: medium
*           high: high
*           xhigh: xhigh
*           max: max
*         compat:
*           # Forced defaults: supportsDeveloperRole: false, supportsStore: false,
*           # maxTokensField: max_tokens. Override only when the upstream accepts more.
* ```
*
* @module @deepseek-ai/dsh-llm-newapi
*/
const name = "llm-newapi";
const inject = ["llm"];
const NS = settingsNamespace("llm-newapi");
/**
* The registry captures these per route; a change here must re-register.
* Sorted by provider so a settings document that merely reorders its keys is
* not mistaken for a route change.
*/
function registrationFacts(profiles) {
	return [...profiles.entries()].map(([provider, profile]) => ({
		provider,
		displayName: profile.displayName,
		retryPolicy: profile.retryPolicy
	})).sort((left, right) => left.provider.localeCompare(right.provider));
}
/**
* The configurable-provider directory: every route the current profiles
* declare. The profile half is unconditional, which is what keeps a route
* already stored against a withheld provider editable and deletable rather
* than stranded in the settings document with nothing on the page to remove it.
* @param profiles - the currently resolved provider profiles.
* @returns the directory entries in declaration order.
*/
function directoryEntries(profiles) {
	const entries = /* @__PURE__ */ new Map();
	for (const [provider, profile] of profiles) entries.set(provider, {
		provider,
		displayName: profile.displayName,
		settingsNs: NS,
		settingsPath: ["providers", provider],
		declared: true
	});
	return [...entries.values()];
}
/** Register one New API adapter for all configured provider routes. */
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let memoized;
	/**
	* The resolved profiles for the current configuration, memoized by the raw
	* snapshot's identity — which is also what makes the adapter's own snapshot
	* stable across operations that observe no change.
	*/
	const profiles = () => {
		const raw = current();
		if (raw === lastRaw && memoized !== void 0) return memoized;
		const next = resolveProfiles(raw.providers);
		lastRaw = raw;
		memoized = next;
		return next;
	};
	profiles();
	const resolveApiKey = async (provider, profile) => {
		const ref = profile.apiKeyEnv;
		if (ref === void 0) return void 0;
		const credentials = ctx.get("credentials");
		const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value;
		if (hit !== void 0 && hit.length > 0) return assertUsableApiKey(hit, "llm-newapi", ref);
		throw new LlmError(`llm-newapi: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this gateway should authenticate anonymously`, "MISSING_CREDENTIAL");
	};
	const adapter = new NewApiAdapter({
		profiles,
		resolveApiKey,
		resolveAttachments: () => ctx.get("attachments")
	});
	let directory;
	let directoryFacts;
	const ensureDirectory = () => {
		const entries = directoryEntries(profiles());
		if (deepEqualJson(entries, directoryFacts)) return;
		if (entries.length === 0) {
			directory?.replace([]);
			directoryFacts = entries;
			return;
		}
		if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
		directoryFacts = entries;
	};
	ensureDirectory();
	const storedApiKey = async (provider) => {
		if (provider === void 0) return void 0;
		const profile = profiles().get(provider);
		if (profile === void 0) return void 0;
		return resolveApiKey(provider, profile);
	};
	ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, storedApiKey));
	let registration;
	let registeredFacts;
	const ensureRegistrationFacts = () => {
		const facts = registrationFacts(profiles());
		if (deepEqualJson(facts, registeredFacts)) return;
		const routes = [...profiles().keys()];
		if (registration === void 0) {
			if (routes.length === 0) {
				registeredFacts = facts;
				return;
			}
			registration = ctx.llm.registerAdapter(routes, adapter);
		} else registration.replace(routes);
		registeredFacts = facts;
	};
	ensureRegistrationFacts();
	installSettingsSection(ctx, NS, Config, config, {
		validate: assertServiceable,
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			try {
				ensureRegistrationFacts();
			} catch (error) {
				ctx.logger.error("llm-newapi: keeping the previously registered routes after a refused update");
				ctx.logger.error(error);
			}
			try {
				ensureDirectory();
			} catch (error) {
				ctx.logger.error("llm-newapi: keeping the previous configurable-provider directory after a refused update");
				ctx.logger.error(error);
			}
		}
	});
	installLlmNewapiWeb(ctx, {
		storedApiKey,
		discover: (baseURL, apiKey, provider) => discoverModels({
			baseURL,
			...apiKey === void 0 ? {} : { apiKey },
			...provider === void 0 ? {} : { provider }
		})
	});
}
//#endregion
export { Config, NewApiAdapter, apply, inject, name };
