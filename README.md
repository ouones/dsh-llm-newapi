# @deepseek-ai/dsh-llm-newapi

English | [中文](README.zh.md)

LLM adapter for the harness LLM seam that speaks directly to a self-hosted [New API](https://newapi-docs.vercel.app/) gateway — an OpenAI/Anthropic-compatible relay such as `https://gateway.example.com` — over plain `fetch` + SSE (framed by `eventsource-parser`). One plugin instance owns a dict of provider routes, each naming one gateway; a request selects a route with `GenerateOptions.provider` and resolves `GenerateOptions.model` against that route's catalog.

This package exists because the `llm-pi-ai` adapter misjudges custom gateway URLs: pi-ai guesses `compat.supportsDeveloperRole: true` for any endpoint its URL detector does not classify as non-standard, so reasoning models get their system prompt sent as `role: "developer"` — which most New API upstreams reject with HTTP 400. llm-newapi FORCES the safe compat on every model (`supportsDeveloperRole: false`, `supportsStore: false`, `maxTokensField: 'max_tokens'`), so the same gateway works without a code or config patch, with explicit opt-in only where a deployment knows its upstream accepts more.

The package root exposes the Cordis plugin contract, `NewApiAdapter`, and `Config`; profile resolution, catalog materialization, wire serialization, SSE parsing, and chunk translation remain package-internal.

## Comparison with dsh-llm-pi-ai

| | `dsh-llm-pi-ai` | `dsh-llm-newapi` |
| --- | --- | --- |
| Protocol layer | pi-ai SDK (`@earendil-works/pi-ai`), provider catalogs installed | Direct `fetch` + SSE for OpenAI chat completions and Anthropic messages; no pi-ai dependency |
| `supportsDeveloperRole` | Guessed from the endpoint URL (true for unrecognized gateways — the HTTP 400 source) | Forced `false` on every model; explicit per-model or per-route override only |
| `supportsStore` / `maxTokensField` | pi-ai auto-detection | Forced `false` / `'max_tokens'`; `maxTokensField` overridable to `max_completion_tokens` |
| Model catalog | Installed pi-ai catalog per provider | Gateway `/v1/models` discovery per route, plus configured `models` / `modelOverrides` |
| Protocol routing | One protocol per pi-ai provider | Per model: `modelApiOverrides` regex → route `api` → discovered `supported_endpoint_types` |
| Cost calculation | pi-ai catalog entries can carry pricing | None; New API relays do not disclose upstream cost in the model listing |
| `GenerateOptions.stop` | Rejected (`UNSUPPORTED_OPTION`) | Rejected (`UNSUPPORTED_OPTION`) |

Both adapters target the same seam and can be mounted side by side: each owns its provider routes, and registering the same route from two adapters fails with `LlmError('DUPLICATE_ADAPTER')`.

## Install

This plugin requires an existing DSH installation. Confirm that the `dsh` command is available:

```sh
dsh --version
```

Install the plugin into the profile you run. The following command uses DSH's `web` profile:

```sh
dsh plugin --profile web add github:ouones/dsh-llm-newapi#22d602b5a2ba293bec4b44e30f1bb45100572252
```

The command installs the exact reviewed commit and adds the bundle to that profile. It needs no pnpm `allowBuilds` setting because the repository includes prebuilt `lib/` and declares no `prepare` script.

Verify that DSH composed the plugin:

```sh
dsh --profile web --dump-config
```

The output contains `id: llm-newapi`. Start the Web profile with `dsh --profile web`, then open **Settings → Models**, add a **NewAPI** provider, enter its base URL and API key, select a model, and save. The key is stored by DSH's credentials service; the profile settings retain only its reference.

To install into another profile, replace both occurrences of `web` with that profile's name. Pin the Git reference to a commit as shown above; do not use a moving branch name for a production profile.

## Config

Configure credentials, the model catalog, and deployment-specific transport settings per provider, keyed by the provider route itself. `apiKeyEnv` is a credential *reference* resolved per request, so no secret enters this file. Omitting it leaves the route unauthenticated; a configured reference that resolves to nothing fails the request with `MISSING_CREDENTIAL` instead, because falling through would authenticate with whatever unrelated key the environment happens to hold. One credential serves every model on its route.

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-newapi'
  config:
    providers:
      # Gateway that advertises `supported_endpoint_types`, so per-model
      # protocol routing works without naming `api`.
      liii:
        displayName: LIII Gateway
        apiKeyEnv: NEWAPI_TEST_TOKEN
        baseURL: https://gateway.example.com
        reasoning: high
        retryPolicy:
          mode: normal
          maxRetries: 3
          backoff:
            initialDelayMs: 500
            maxDelayMs: 10000
            jitterRatio: 0.1
        modelApiOverrides:
          '^deepseek-v4-': openai-completions
      # Route whose gateway discloses no endpoint types: every model must be
      # routed explicitly, here by naming the protocol on the route.
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example
        # Wire facts the gateway cannot be trusted to guess. The three forced
        # defaults need not be written; only overrides appear here.
        compat:
          supportsDeveloperRole: true   # only when the upstream accepts it
          thinkingFormat: deepseek
        models:
          - id: acme-large
            name: Acme Large
            contextWindow: 65536
            maxTokens: 4096
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            maxTokens: 32768
            reasoningEfforts:
              off:
              high: high
              max: ultra
            # Per-model switches win over the route's.
            compat:
              maxTokensField: max_completion_tokens
```

The dict shape makes duplicate routes unrepresentable. `providers` may also be empty or omitted entirely: the adapter then mounts **dormant** — zero routes — and registers routes the moment an `llm-newapi:` settings section supplies profiles, dropping them again when it empties. Registration with `ctx.llm` is atomic: a collision with any provider route already owned by another adapter fails plugin loading without registering the remaining routes. A route the configuration names but whose models it does not describe fails before any provider request with `LlmError('UNKNOWN_MODEL')`.

Supported profile fields are `apiKeyEnv`, `displayName`, `api`, `baseURL`, `models`, `modelOverrides`, `modelApiOverrides`, `compat`, `defaultContextWindow`, `defaultMaxTokens`, `defaultInput`, `headers`, `reasoning`, `thinkingBudgets`, `timeoutMs`, `streamIdleTimeoutMs`, and `retryPolicy`. Each profile's optional retry policy is captured with that provider route; omission uses bounded normal defaults. Harness app attribution wins a conflicting configured header name.

## Web UI configuration

Open **Settings → Models** after mounting the plugin. The page shows a **NewAPI** card per configured route (via `registerConfigurableProviders`); a route configured only in `cordis.yml` appears as a card too, so it stays editable and deletable from the page. The form is rendered from the same `Config` schema the plugin validates against:

1. Enter the gateway's **base URL** in the `baseURL` field (for example `https://gateway.example.com`).
2. Enter the API key in the **credential** field. The page stores it in the credentials service and saves only its `apiKeyEnv` reference into settings — the literal secret never enters `settings.yaml`.
3. Select the models the route should serve from the discovered listing, or enter them by hand.
4. Choose **Fetch available models** to query the endpoint currently shown in the form. The reply comes from the gateway's `GET /v1/models` listing and is offered as candidates; nothing is stored until you save, and `settings.yaml` remains the only thing that decides what a route serves. A route that already stored a credential resolves its `apiKeyEnv` for the probe; a key typed into the form wins, being the one under test.

Save writes the `llm-newapi:` settings section; the next request picks it up without a restart.

## Compat semantics

The catalog FORCES three compat defaults on every materialized model, and lets configuration override each of them per field. Model-level switches win over the route's; a route-level default applies to every model on the route. These are wire facts a gateway cannot be trusted to guess, and unlike pi-ai this package decides every compat field itself — never the endpoint URL.

- **`supportsDeveloperRole`** (default `false`) — whether the endpoint accepts the OpenAI `developer` role for the system prompt. New API relays to upstreams that overwhelmingly accept only `user|assistant|tool`, and pi-ai's URL guess (true for any URL it does not classify as non-standard) sends `role: "developer"` on reasoning models, which those upstreams reject with HTTP 400. The forced default sends the system prompt as `role: "system"` instead. Set `true` explicitly only for a deployment whose upstream genuinely accepts the `developer` role.
- **`supportsStore`** (default `false`) — whether the endpoint accepts OpenAI's `store` parameter. New API does not, so the parameter is never sent.
- **`maxTokensField`** (default `'max_tokens'`) — the output-token field name in the OpenAI request. New API and its relays use `max_tokens`; `max_completion_tokens` is the o-series spelling a few upstreams pass through, chosen explicitly when a deployment needs it.

The remaining compat fields — `thinkingFormat` (plain OpenAI `reasoning_effort` dialect by default, with `deepseek`, `qwen`, `zai`, `openrouter`, `together`, `ant-ling`, and `string-thinking` accepted) and `supportsReasoningEffort` — are optional on the route and per model, and `supportsLongCacheRetention` controls Anthropic cache retention on the messages route.

### Reasoning

`reasoningEfforts` declares a model's selectable thinking levels: each key is a level selectors offer, its value the spelling dispatch sends on the wire, so `high: high` passes the canonical name through while `max: ultra` renames it for a gateway with its own vocabulary. Keys come from the shared level set (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`); a level not declared is not offered. `off` is the one level that may leave its value empty — "supported, send nothing" — because for most providers not thinking is the parameter's absence. Omitting the field keeps the discovered entry's capability; `false` declares a non-reasoning model. An empty declaration, or one offering no level beyond `off`, is refused rather than guessed.

A model neither the entry nor discovery sizes takes the route's `defaultContextWindow` (262,144) and `defaultMaxTokens` (32,768); both fallbacks are route fields a deployment corrects once rather than constants buried in the adapter. Request modalities resolve entry `input` → discovered entry → route `defaultInput` (default `[text]`), and `[text]` is the absence of a declaration rather than a guess at the endpoint.

## Model discovery

A route's catalog comes from two sources: the gateway's own listing and configuration. The adapter registers model discovery on the `llm-newapi` settings namespace, which reads `GET {baseURL}/v1/models` with bearer auth — the one listing dialect New API speaks, and the only authority for a gateway's models, since this package ships no registry. The base URL is treated as a prefix rather than a URL to resolve against, so a deployment path such as `https://gateway.example/openai/v1` keeps its segments.

Discovery reads, when the listing supplies them: `name`/`display_name` labels, `supported_endpoint_types` (the routing input below), `context_window`/`context_length`, `max_output_tokens`/`max_tokens`, and `input_modalities` (any entry accepting `image` is offered both text and image). Entries without a usable id are skipped rather than failing the whole listing, and the reply is read under a ten-megabyte ceiling enforced on the bytes actually received. An unreachable endpoint, a refused credential, a non-JSON body, and a body with no `data` array all fail with `DISCOVERY_FAILED`; a 401 or 403 additionally names the credential.

A configured `models` list *replaces* the discovered catalog rather than extending it; omitting it (or leaving it empty) serves that catalog unchanged. Each entry defaults its unset fields from the discovered model of the same id. `modelOverrides` reshapes individual discovered models without that cost: each key is a discovered model id, each value the same fields a `models` entry takes with the id living in the key, and the rest of the catalog keeps serving untouched. An override naming a model the discovered catalog does not describe is refused rather than skipped (only when discovery answered — without it there is no catalog to name a miss against).

Discovery is a configuration-time offer, never a runtime merge: fetching the listing offers candidates for adoption, but the running catalog does not follow the gateway's listing on its own — the configured `models`/`modelOverrides` (or the fallback to the discovered set at resolution time) decide what a route serves, and the wire protocol still comes from the routing order below.

### Protocol routing

Every model speaks exactly one wire protocol. The route resolves it in this order:

1. `modelApiOverrides` — a dict of regex source → protocol; the first regular expression matching the model id wins (for example `'^deepseek-v4-': openai-completions`). An invalid regular expression fails loud at resolution.
2. The route's `api` field.
3. The discovered `supported_endpoint_types`: `openai` → `openai-completions`, `anthropic` → `anthropic-messages`.

A model none of these routes fails resolution naming the route and model, so an unserviceable profile is refused **where it is written** — `settings.mutate` answers `settings-rejected` — rather than being stored and then quietly disabling every route in the namespace. `api` accepts the three protocols in `SUPPORTED_PROTOCOLS` (`openai-completions`, `openai-responses`, `anthropic-messages`); the serializer implements `openai-completions` and `anthropic-messages`, so a route naming `openai-responses` fails resolution as unsupported by this package.

## Wire format

Both routes stream only: OpenAI chat completions with `stream_options.include_usage` always on, Anthropic messages with `stream: true` and the `anthropic-version: 2023-06-01` header. The OpenAI side reads `content`, `reasoning_content`, `tool_calls`, and `usage` deltas; the Anthropic side reads `message_start`, `content_block_*`, `message_delta`, and `message_stop` events. Both defer `block-end`s, `usage`, and `finish` to their terminal event, so no chunk follows `finish` — the OpenAI translator emits `usage` at the `[DONE]` sentinel (covering both finish-attached and trailing usage-only shapes), and the Anthropic translator at `message_stop`. A terminal `stop` whose message opened no content block maps to a `finish {kind: 'error'}` with code `EMPTY_RESPONSE` (retried by default policy) instead of a successful empty message.

Usage is normalized to the harness disjoint convention: OpenAI-compatible relays report cache hits inside `prompt_tokens`, so cache reads are subtracted out of `inputTokens`; Anthropic reports them disjoint, so no subtraction is needed. Reasoning tokens cross as their own count when the wire reports them. Tool-call arguments are raw JSON strings on the harness side and re-stringified on the wire; on the Anthropic wire they are parsed into the object `input` field, and an unparseable argument refuses the request with `INVALID_ARGS`.

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `RATE_LIMIT` (other 429s), `SERVER` (5xx), `INVALID_REQUEST` (other statuses). A pre-response transport failure (DNS, refused connection, TLS) throws `TRANSPORT` naming the configured endpoint; caller aborts throw `ABORTED`, and the loop's cancellation signal remains authoritative. A stream ending without its terminal event throws `STREAM_CLOSED`; a malformed JSON payload throws `MALFORMED_RESPONSE`. `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION`.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()`, merged into the provider request with a configured `headers` entry losing a collision. See [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts).

## Model Experience

### Provider request

#### What the model sees

The selected model receives the harness system prompt, message history, tool schemas, and sampling fields. This package adds no prompt prose; the system prompt crosses as `role: "system"` unless the model's compat block accepts the `developer` role. Reasoning content from prior assistant turns has no replay channel on either wire, so it is dropped from history.

#### Token effect

Provider tokenization governs exact input. Dropped reasoning avoids paying those tokens again; cache-read usage is reported when the wire reports it.

#### KV Cache effect

An unchanged assembled prefix is eligible for the upstream's cache reuse, which the adapter reports in usage. A model-route change or any upstream prompt, schema, prefix, or history change may prevent reuse from the first changed token.

### Provider response

#### What the model sees

Reasoning, text, and tool-call deltas become harness chunks for the loop to log and assemble; parsed tool arguments cross as raw JSON strings.

#### Token effect

Generated tokens follow the request's logged reasoning effort and output cap; only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- **`openai-responses` routes are refused** — the protocol is declared in `SUPPORTED_PROTOCOLS` for routing and listing purposes, but the serializer implements only `openai-completions` and `anthropic-messages`. A model routed onto `openai-responses` fails resolution with the route and model named.
- **`GenerateOptions.stop` is unsupported** — the adapter rejects the field with `UNSUPPORTED_OPTION`.
- **No cost calculation** — New API gateways do not disclose upstream cost in the model listing, so no pricing rides the catalog or discovery.
- **No image input** — image-capable models are refused with `UNSUPPORTED_CONTENT` before the request goes out: both wire routes are text-only, and image input additionally requires the durable attachment service.
- **One wire protocol per model** — the route resolves each model's protocol independently, but a single model speaks exactly one; there is no per-request protocol fallback.
- **A route with no models is refused** — a New API gateway's models are never guessable, so a route whose gateway disclosed none and whose configuration lists none fails resolution.
- **Discovery reads only the OpenAI-compatible listing shape** — `GET /v1/models` with bearer auth is the one dialect New API speaks; endpoints that do not provide it fall back to hand-entered models.
- **`headers` can carry a credential the redactor never sees** — the profile's `headers` dict is plain strings, so `Authorization` or `api-key` set there is returned verbatim by a redacted `describe()` and rendered by any configuration UI. Store credentials as `apiKeyEnv` references.
- **Retry policy is provider-owned, not an SDK retry** — each provider profile may configure nested `retryPolicy`, which `dsh-llm-retry` executes at the agent failed-step extension point; the adapter makes exactly one provider request per `stream()` call, and direct `ctx.llm.stream()` calls remain single-attempt.
