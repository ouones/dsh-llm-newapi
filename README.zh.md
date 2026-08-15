# @deepseek-ai/dsh-llm-newapi

[English](README.md) | 中文

harness LLM（大语言模型）seam 的 LLM 适配器，直接与自托管 [New API](https://newapi-docs.vercel.app/) 网关——例如 `https://gateway.example.com` 这类 OpenAI/Anthropic 兼容中转——通过纯 `fetch` + SSE（由 `eventsource-parser` 分帧）通信。一个插件实例拥有一份以路由为键的提供方 profile 字典，每条路由点名一个网关；请求使用 `GenerateOptions.provider` 选择路由，并针对该路由的 catalog 解析 `GenerateOptions.model`。

本包存在的原因是 `llm-pi-ai` 适配器会误判自定义网关 URL：对任何未被其 URL 检测归类为「非标准」的端点，pi-ai 都会猜测 `compat.supportsDeveloperRole: true`，于是推理模型会把系统提示以 `role: "developer"` 发送——而大多数 New API 上游会以 HTTP 400 拒绝。llm-newapi 对每个模型**强制**注入安全 compat（`supportsDeveloperRole: false`、`supportsStore: false`、`maxTokensField: 'max_tokens'`），因此同一网关无需改代码或改配置即可工作；只有部署确定自己的上游接受更多时，才显式选择加入。

包根入口导出 Cordis 插件约定、`NewApiAdapter` 与 `Config`；profile 解析、catalog 物化、协议序列化、SSE 解析与分片转换保留在包内部。

## 与 dsh-llm-pi-ai 的差异

| | `dsh-llm-pi-ai` | `dsh-llm-newapi` |
| --- | --- | --- |
| 协议层 | pi-ai SDK（`@earendil-works/pi-ai`），内置提供方 catalog | 直接 `fetch` + SSE 实现 OpenAI chat completions 与 Anthropic messages；不依赖 pi-ai |
| `supportsDeveloperRole` | 按端点 URL 猜测（对无法识别的网关为 true——HTTP 400 的根源） | 对每个模型强制 `false`；仅在模型级或路由级显式覆盖 |
| `supportsStore` / `maxTokensField` | pi-ai 自动检测 | 强制 `false` / `'max_tokens'`；`maxTokensField` 可覆盖为 `max_completion_tokens` |
| 模型 catalog | 每个提供方一份已安装 pi-ai catalog | 每条路由经网关 `/v1/models` 发现，外加配置的 `models` / `modelOverrides` |
| 协议路由 | 每个 pi-ai 提供方一种协议 | 按模型：`modelApiOverrides` 正则 → 路由 `api` → 发现的 `supported_endpoint_types` |
| 成本计算 | pi-ai catalog 条目可携带定价 | 无；New API 中转不在模型列表中公布上游成本 |
| `GenerateOptions.stop` | 拒绝（`UNSUPPORTED_OPTION`） | 拒绝（`UNSUPPORTED_OPTION`） |

两个适配器面向同一 seam，可以并排挂载：各自拥有自己的提供方路由，从两个适配器注册同一路由会以 `LlmError('DUPLICATE_ADAPTER')` 失败。

## 安装

适配器是普通的 dsh 插件，因此插件行能挂载的地方它都能挂载。要在本地源码检出中试用，把它加进一个 Web overlay 并以该 patch 启动：

```yaml
# scratch-plugin/cordis.yml
- insert:
    - id: llm-newapi
      name: '/absolute/path/to/deepseek-harness/packages/llm/llm-newapi'
      config:
        providers:
          my-gateway:
            apiKeyEnv: NEWAPI_TEST_TOKEN
            baseURL: https://gateway.example.com
            api: openai-completions
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

GitHub 发布仓库以 profile bundle 安装，并自动挂载适配器行：

```sh
dsh plugin --profile newapi add github:<owner>/dsh-newapi#<commit>
dsh --profile newapi --dump-config
```

将 `<commit>` 固定为已审核的提交。发布提交包含预构建 `lib/`，且不声明 `prepare` 脚本，因此 pnpm 不需要 `allowBuilds` 条目。插件从 bundle patch 添加的 `cordis.yml` 条目应用默认值。

## 配置

按提供方配置凭据、模型 catalog 与部署特定传输设置，并以提供方路由本身为键。`apiKeyEnv` 是按请求解析的凭据*引用*，因此机密不进入该文件。省略它会让该路由处于未认证状态；已配置却解析不出任何值的引用则相反，会让请求以 `MISSING_CREDENTIAL` 失败，因为放行下去就会用环境里恰好持有的某个无关密钥完成认证。一条凭据服务该路由下的全部模型。

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-newapi'
  config:
    providers:
      # 公布 `supported_endpoint_types` 的网关，不命名 `api` 也能按模型路由协议。
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
      # 网关未公布端点类型的路由：每个模型都必须显式路由，这里在路由上点名协议。
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example
        # 不能指望网关猜对的协议事实。三个强制默认值无需写出；这里只写覆盖。
        compat:
          supportsDeveloperRole: true   # 仅当上游确实接受时
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
            # 模型级开关胜出路由级。
            compat:
              maxTokensField: max_completion_tokens
```

字典形状使重复路由无法表示。`providers` 也可以为空或整体省略：适配器将以**休眠**姿态挂载——零路由——一旦 `llm-newapi:` settings 分节提供了 profile 就即时注册路由，分节清空时随之撤销。向 `ctx.llm` 注册具有原子性：如果与另一适配器已拥有的任何提供方路由冲突，插件会加载失败，不注册剩余路由。配置点名了某路由、却没有描述其模型时，会在发起任何提供方请求前以 `LlmError('UNKNOWN_MODEL')` 失败。

受支持的 profile 字段是 `apiKeyEnv`、`displayName`、`api`、`baseURL`、`models`、`modelOverrides`、`modelApiOverrides`、`compat`、`defaultContextWindow`、`defaultMaxTokens`、`defaultInput`、`headers`、`reasoning`、`thinkingBudgets`、`timeoutMs`、`streamIdleTimeoutMs` 和 `retryPolicy`。每个 profile 的可选重试策略都会与该提供方路由一同捕获；省略时使用有界的常规默认值。若已配置标头中有同名项，则以 Harness 应用归因为准。

## Web UI 配置

挂载插件后打开 **Settings → Models**。页面按每条已配置路由显示一张 **NewAPI** 卡片（经由 `registerConfigurableProviders`）；只在 `cordis.yml` 中配置的路由同样显示为卡片，因此可在页面上编辑和删除。表单由插件校验所用的同一份 `Config` schema 渲染：

1. 在 `baseURL` 字段中填写网关的**基础 URL**（例如 `https://gateway.example.com`）。
2. 在**凭据**字段中填写 API 密钥。页面把它存入 credentials 服务，只把 `apiKeyEnv` 引用写进 settings——字面密钥绝不进入 `settings.yaml`。
3. 从发现结果中选择该路由应服务的模型，或手工填写。
4. 选择 **Fetch available models** 查询表单当前显示的端点。回复来自网关的 `GET /v1/models` 列表，作为候选供采纳；保存前什么都不存储，`settings.yaml` 始终是唯一决定路由服务什么的东西。已存凭据的路由会解析其 `apiKeyEnv` 用于探测；表单中键入的密钥优先，因为那正是被测试的那一把。

保存写入 `llm-newapi:` settings 分节；下一次请求即生效，无需重启。

## Compat 语义

catalog 对每个物化模型**强制**三个 compat 默认值，并允许配置逐字段覆盖其中每一个。模型级开关胜出路由级；路由级默认值作用于该路由上的每个模型。这些都是不能指望网关猜对的协议事实，而且与 pi-ai 不同，本包自己决定每个 compat 字段——绝不依赖端点 URL。

- **`supportsDeveloperRole`**（默认 `false`）——端点是否接受系统提示的 OpenAI `developer` 角色。New API 中转的上游绝大多数只接受 `user|assistant|tool`，而 pi-ai 的 URL 猜测（对任何未被归类为「非标准」的 URL 都是 true）会在推理模型上发送 `role: "developer"`，被这些上游以 HTTP 400 拒绝。强制默认值改为以 `role: "system"` 发送系统提示。只有部署确认自己的上游确实接受 `developer` 角色时，才显式设 `true`。
- **`supportsStore`**（默认 `false`）——端点是否接受 OpenAI 的 `store` 参数。New API 不接受，因此该参数从不发送。
- **`maxTokensField`**（默认 `'max_tokens'`）——OpenAI 请求中的输出 token 字段名。New API 及其中转使用 `max_tokens`；`max_completion_tokens` 是少数上游透传的 o 系列拼写，部署需要时显式选择。

其余 compat 字段——`thinkingFormat`（默认是普通 OpenAI `reasoning_effort` 方言，另接受 `deepseek`、`qwen`、`zai`、`openrouter`、`together`、`ant-ling` 与 `string-thinking`）与 `supportsReasoningEffort`——在路由和模型级都可选，`supportsLongCacheRetention` 则控制 messages 路由上的 Anthropic 缓存保留。

### 推理（reasoning）

`reasoningEfforts` 声明模型可选的思考级别：每个键是选择器提供的一个档位，其值是分派在协议中发送的拼写，因此 `high: high` 原样透传规范名称，而 `max: ultra` 则为使用自有词汇的网关改名。键取自共享档位集合（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）；未声明的档位不会被提供。`off` 是唯一可以留空值的档位——「支持，但什么也不发送」——因为对大多数提供方而言，不思考就是该参数的缺席。省略该字段会保留发现条目的能力；`false` 声明一个不具备推理能力的模型。空声明、或除 `off` 外不提供任何档位的声明，会被拒绝而不是去猜。

条目与发现都没有给出尺寸的模型，会采用该路由的 `defaultContextWindow`（262,144）与 `defaultMaxTokens`（32,768）；两个回退值都是路由字段，部署更正一次即可，而不是埋在适配器里的常量。请求模态的解析顺序是：条目的 `input` → 发现条目 → 路由的 `defaultInput`（默认 `[text]`），而 `[text]` 是「尚未声明」，而不是对端点的猜测。

## 模型发现

路由的 catalog 来自两个来源：网关自身的列表与配置。适配器在 `llm-newapi` settings namespace 上注册模型发现，它读取带 bearer 认证的 `GET {baseURL}/v1/models`——这是 New API 会说的唯一列表方言，也是网关模型的唯一权威，因为本包不附带任何注册表。`baseURL` 按前缀而非待解析 URL 处理，因此 `https://gateway.example/openai/v1` 这类部署路径会保留其路径段。

发现会读取（列表提供时）：`name`/`display_name` 标签、`supported_endpoint_types`（即下面的路由输入）、`context_window`/`context_length`、`max_output_tokens`/`max_tokens`，以及 `input_modalities`（任何接受 `image` 的条目都会被同时提供 text 与 image）。没有可用 id 的条目会被跳过而不是让整份列表失败，回复在十兆字节上限下读取，且上限落在实际收到的字节上。端点不可达、凭据被拒、响应非 JSON、以及响应没有 `data` 数组，都会以 `DISCOVERY_FAILED` 失败；仅当 401 或 403 时才点名凭据。

配置的 `models` 列表是*替换*发现到的 catalog，而不是扩充它；省略它（或留空）则原样服务该 catalog。每个条目都会从同 `id` 的发现模型继承自身未设置的字段。`modelOverrides` 无需这份代价就能就地重塑单个发现模型：每个键是一个发现模型 id，每个值可写 `models` 条目接受的同一批字段，只是 id 落在键上，而 catalog 的其余部分原样继续服务。点名了发现 catalog 未描述模型的一条覆盖会被拒绝而非跳过（仅在发现已作答时——没有它，就无从点名错处）。

发现是配置期的候选采纳，绝不是运行时合并：拉取列表只是提供候选供采纳，运行中的 catalog 不会自行跟随网关列表——由配置的 `models`/`modelOverrides`（或解析时对发现集的回退）决定路由服务什么，而 wire 协议仍来自下面的路由顺序。

### 协议路由

每个模型恰好说一种协议格式。路由按此顺序解析：

1. `modelApiOverrides`——正则源 → 协议的字典；第一个匹配模型 id 的正则胜出（例如 `'^deepseek-v4-': openai-completions`）。无效正则在解析时即响亮失败。
2. 路由的 `api` 字段。
3. 发现的 `supported_endpoint_types`：`openai` → `openai-completions`，`anthropic` → `anthropic-messages`。

三者都路由不到的模型会在解析时点名路由与模型失败，因此无法服务的 profile 会在**写入之处**被拒绝——`settings.mutate` 以 `settings-rejected` 回答——而不是先存下来、再悄悄让该 namespace 下每条路由失效。`api` 接受 `SUPPORTED_PROTOCOLS` 中的三种协议（`openai-completions`、`openai-responses`、`anthropic-messages`）；序列化器实现了 `openai-completions` 与 `anthropic-messages`，因此点名 `openai-responses` 的路由会作为本包不支持而解析失败。

## 协议格式

两条路由都只走流式：OpenAI chat completions 始终开启 `stream_options.include_usage`，Anthropic messages 使用 `stream: true` 与 `anthropic-version: 2023-06-01` 标头。OpenAI 侧读取 `content`、`reasoning_content`、`tool_calls` 与 `usage` delta；Anthropic 侧读取 `message_start`、`content_block_*`、`message_delta` 与 `message_stop` 事件。两者都把 `block-end`、`usage` 与 `finish` 延迟到各自的终止事件，因此 `finish` 之后不再有分片——OpenAI 翻译器在 `[DONE]` 哨兵处发出 `usage`（同时覆盖随 finish 附带与尾部单独 usage 两种形态），Anthropic 翻译器在 `message_stop` 处发出。终止时 `stop` 若未打开任何内容块，则映射为 `finish {kind: 'error'}`，code 为 `EMPTY_RESPONSE`（默认策略会重试），而非成功空消息。

usage 会规范化为 harness 的不相交（disjoint）约定：OpenAI 兼容中转把缓存命中报告在 `prompt_tokens` 内，因此缓存读取会从 `inputTokens` 中减去；Anthropic 单独报告，无需减法。协议报告时，推理 token 作为独立计数跨越。工具调用参数在 harness 侧是原始 JSON 字符串，协议上重新字符串化；在 Anthropic 协议上则解析为对象 `input` 字段，无法解析的参数会以 `INVALID_ARGS` 拒绝请求。

非 2xx 响应抛出带稳定 code 的 `LlmError`：`AUTH`（401/403）、`RATE_LIMIT`（其他 429）、`SERVER`（5xx）、`INVALID_REQUEST`（其他状态码）。响应前传输失败（DNS、连接被拒、TLS）抛出点名已配置端点的 `TRANSPORT`；调用方 abort 抛出 `ABORTED`，loop 的取消信号保持权威。流未以其终止事件结束抛出 `STREAM_CLOSED`；JSON 负载格式错误抛出 `MALFORMED_RESPONSE`。`GenerateOptions.stop` 以 `UNSUPPORTED_OPTION` 被拒绝。

## 应用归因

每个请求都携带 dsh-llm `attributionHeaders()` 的共享归因标头，并入提供方请求；与已配置 `headers` 条目冲突时，配置方让位。详见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)。

## 模型体验

### 提供方请求

#### 模型看到的内容

所选模型会收到 harness 系统提示、消息历史、工具 schema 与采样字段。本包不添加提示词文本；系统提示以 `role: "system"` 跨越，除非模型 compat 块接受 `developer` 角色。先前 assistant 轮次的推理内容在两条协议上都没有回放通道，因此会从历史中丢弃。

#### Token 影响

精确输入取决于提供方 tokenization。丢弃推理可避免再次支付这些 token；协议报告时，缓存读取 usage 会被上报。

#### KV Cache 影响

未变更的组装前缀有资格获得上游缓存复用，适配器会在 usage 中上报。模型路由变更或任何上游 prompt、schema、前缀、历史变更，都可能使复用从首个变更 token 起失效。

### 提供方响应

#### 模型看到的内容

推理、文本与工具调用 delta 会变为 harness 分片，供 loop 记录与组装；解析后的工具参数以原始 JSON 字符串跨越。

#### Token 影响

生成 token 遵循请求中已记录的推理档位与输出上限；只有 loop 保留的块才会影响后续输入。

#### KV Cache 影响

loop 保留的响应块会追加到下一个请求，并保留其较早可复用前缀；被丢弃的块没有后续缓存影响。更换提供方或模型会选定不同的缓存域。

## 已知限制与暂缓事项

- **拒绝 `openai-responses` 路由**——该协议在 `SUPPORTED_PROTOCOLS` 中声明，用于路由与列表目的，但序列化器只实现了 `openai-completions` 与 `anthropic-messages`。路由到 `openai-responses` 的模型会以点名路由与模型的方式解析失败。
- **不支持 `GenerateOptions.stop`**——适配器以 `UNSUPPORTED_OPTION` 拒绝该字段。
- **无成本计算**——New API 网关不在模型列表中公布上游成本，因此没有定价搭乘 catalog 或发现。
- **无图片输入**——支持图片的模型会在请求发出之前以 `UNSUPPORTED_CONTENT` 被拒绝：两条协议路由都只走文本，且图片输入额外需要持久化 attachment 服务。
- **每个模型只有一种协议格式**——路由独立解析每个模型的协议，但单个模型恰好只说一种；没有按请求的协议回退。
- **没有模型的路由会被拒绝**——New API 网关的模型永远不可猜测，因此网关未公布、配置也未列出的路由会解析失败。
- **发现只读 OpenAI 兼容列表形态**——带 bearer 认证的 `GET /v1/models` 是 New API 会说的唯一方言；不提供它的端点回退到手工填写模型。
- **`headers` 可能承载一条脱敏器看不见的凭据**——profile 的 `headers` 是纯字符串字典，因此设在其中的 `Authorization` 或 `api-key` 会被脱敏后的 `describe()` 原样返回，并被任何配置 UI 渲染出来。请把凭据存为 `apiKeyEnv` 引用。
- **重试策略由提供方持有，而不是 SDK 重试**——每个提供方 profile 都可以配置嵌套的 `retryPolicy`，由 `dsh-llm-retry` 在 agent 的失败步骤扩展点上执行；适配器每次 `stream()` 调用恰好发起一次提供方请求，直接 `ctx.llm.stream()` 调用仍只尝试一次。
