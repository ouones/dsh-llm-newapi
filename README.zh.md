# New API DSH 插件

让 DeepSeek Harness（DSH）通过 New API 网关使用模型，并在支持的模型上选择思考深度。

## 它能做什么

- 将 New API 网关中的模型添加到 DSH。
- 在模型支持时选择思考深度，例如低、中、高。
- 通过 DSH 的设置页面保存网关地址、API 密钥和模型选择。

## 安装

先确认电脑已经安装 DSH，且终端可以执行：

```sh
dsh --version
```

将插件安装到你平时使用的 DSH profile。以下命令以 `web` profile 为例：

```sh
dsh plugin --profile web add github:ouones/dsh-llm-newapi
```

安装过程不需要额外执行构建命令，也不需要修改 pnpm 设置。

如果你使用的是其他 profile，请把命令中的 `web` 替换为对应名称。

## 验证

执行：

```sh
dsh --profile web --dump-config
```

输出中包含 `id: llm-newapi`，表示插件已经启用。

## 配置

1. 启动 DSH：

   ```sh
   dsh --profile web
   ```

2. 打开 **Settings → Models**。
3. 添加 **NewAPI** 提供方。
4. 填写 New API 网关的基础 URL，例如 `https://your-newapi.example`。
5. 填写 API 密钥。
6. 获取或手动添加可用模型，选择你要使用的模型后保存。

API 密钥由 DSH 的凭据功能保存，不会直接写入 profile 设置。

## 使用思考深度

在模型选择界面选择已配置的 NewAPI 模型。模型提供思考深度选项时，选择所需等级后再发起对话即可。

可用等级由网关和模型决定。若没有看到思考深度选项，说明当前模型或网关没有提供该能力。

## 常见问题

### 安装后找不到 NewAPI

先运行 `dsh --profile web --dump-config`，确认输出包含 `id: llm-newapi`。如果你安装到了其他 profile，请用相同的 profile 启动 DSH。

### 看不到模型

检查网关基础 URL 是否正确、API 密钥是否有效，并在 **Settings → Models** 中重新获取模型列表。部分网关需要手动添加模型。

### 请求被网关拒绝

确认所选模型已在网关中启用，API 密钥有权限访问该模型，且网关地址填写的是基础 URL。

### 没有思考深度选项

这是模型能力限制，不表示插件安装失败。更换支持思考能力的模型后再试。

## 使用范围

插件用于文本对话和工具调用场景。图片输入与部分网关协议暂不支持。
