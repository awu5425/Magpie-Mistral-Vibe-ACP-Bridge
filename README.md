# Magpie Mistral Vibe ACP Bridge

<img src="assets/icon.svg" width="72" height="72" alt="Mistral Vibe ACP Bridge">

让 Magpie 中的 OpenCode 等客户端通过本机官方 `vibe-acp` 调用 Mistral 托管的聊天模型。选中
**Mistral Vibe ACP** 下的模型后，Magpie 会把请求交给 Vibe，再把流式回复传回客户端。客户端工具由
调用方执行，工具结果通过 MCP 回到同一个 Vibe 回合。

插件提供 **Mistral Vibe ACP**，复用本机 Vibe 登录。聊天请求经 ACP 交给 Vibe，插件用
同一份凭据向 Mistral 查询模型目录和 Vibe Code 月度额度。

## 致谢

本项目源自 [songlairui/magpie-mistral-code](https://github.com/songlairui/magpie-mistral-code)。
感谢 [songlairui](https://github.com/songlairui) 和上游贡献者提供的 Magpie 与 OpenCode 接入代码，
本桥接仍沿用了其中的模型目录和额度解析逻辑。Vibe ACP Bridge 由本仓库独立维护。

感谢 OpenAI Codex 协助实现 ACP 桥接、验证模型与工具调用，并更新项目文档。

## 前置配置

1. **Magpie** 和 **官方 Mistral Vibe CLI** 安装在同一台机器、同一系统用户下。ACP 桥接使用
   Unix socket 和 POSIX 子进程。已在 macOS 上验证 Magpie `0.1.4526`、Vibe `3.1.3` 和 OpenCode
   `v2.3.1`。其他系统和版本尚未验证。[Magpie 安装](https://usemagpie.ai/docs/start) ·
   [官方 Vibe CLI 安装](https://docs.mistral.ai/vibe/code/cli/install-setup)
2. **先登录官方 Vibe**。运行 `vibe --setup`，完成浏览器登录，并在 Vibe 里用官方 Mistral 模型发条
   短消息。桥接复用该用户钥匙串里的 Vibe 登录。已配置环境变量的用户也可以让启动 Magpie 的进程
   继承 `MISTRAL_API_KEY`。如果 Vibe 把凭据保存在自己的 `.env` 文件中，请改用钥匙串或将该变量
   安全地传给 Magpie 进程。真实凭据留在本机的钥匙串或环境变量中。
   [Mistral 的密钥与登录说明](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles)
3. **让 Magpie 找得到 `vibe-acp`**。在用于启动 Magpie 的环境中运行下面两条命令。若终端能找到、
   Magpie 却找不到，请从包含 Vibe 安装目录的环境重新启动 Magpie。用官方安装器安装时，该目录
   通常是 `~/.local/bin`。

   ```sh
   command -v vibe-acp
   vibe-acp --version
   ```

## 安装与选模型

```sh
magpie plugin add github:gwx90/Magpie-Mistral-Vibe-ACP-Bridge
magpie plugin login mistral-vibe-acp api
```

也可以在 Magpie 中打开 **供应商 → Mistral Vibe ACP → 登录**，选择 **Connect to local Vibe**。
这一步会复用本机当前的 Vibe 登录，无需输入密钥或 `local-vibe`。已连接的账号可继续使用。
Magpie 只管理一个 Vibe 账号。要换账号，先在官方 Vibe CLI 中登录所需账号。如需重新连接，
在 Magpie 的供应商设置中选择 **重新登录**。
如果更新后旧连接仍显示 **API key**，点一次 **重新登录**即可更新为 **Vibe CLI**。

完成后，在 **供应商 → Mistral Vibe ACP** 的模型列表中选择所需型号。插件从当前账号的
[Mistral 模型目录](https://docs.mistral.ai/api/endpoint/models)同步未归档的聊天模型，包含可单独
选择的别名。目录暂时读不到时，使用上一次的结果或内置列表。若 Magpie 只展示部分模型，可在该
供应商的模型页启用其余型号。模型的调用权限、额度和计费以 Mistral 实际返回为准。

### 在 OpenCode 中使用

先让 [OpenCode 接入 Magpie](https://usemagpie.ai/docs/opencode-models)。刷新模型列表后，选择
`magpie/mistral-vibe-acp/` 下的型号。例如，用下面的命令验证 Large 4：

```sh
opencode reload
opencode run --model magpie/mistral-vibe-acp/mistral-large-4-0 "Reply with OK."
```

### 在 Magpie 查看用量

- **月度额度**。打开 Magpie 的 **用量**，在页面顶部找到 **Mistral Vibe ACP** 的 `Monthly Vibe Code`
  额度卡。这里显示 Mistral 返回的已用比例和重置时间。也可以在该供应商的账号卡片上查看。
- **Token 用量**。在 **用量 → 请求** 中找到供应商为 `mistral-vibe-acp` 的记录，查看输入、输出
  和缓存读取 token（如有）。图表和汇总可按日期范围、模型或账号查看。

也可以在终端查看额度和今日汇总，或导出最近 24 小时的逐条用量：

```sh
magpie quota mistral-vibe-acp
magpie usage today
magpie usage --csv --last 24h > magpie-usage.csv
```

在 CSV 中按 `provider` 列筛选 `mistral-vibe-acp`，查看 `input_tokens`、`output_tokens`
和 `cache_read_tokens`。含工具调用的回合在最后一次响应中记录整轮用量，避免重复计数。
历史请求沿用当时的记录。[Magpie 用量说明](https://usemagpie.ai/docs/usage)

### 当前支持范围

ACP 入口支持文本、流式输出和模型目录标明支持的函数工具。每个新聊天回合会创建隔离的 Vibe
会话，并传入调用方提供的文本历史。等待工具结果的状态保存在内存中。插件重启、请求取消或回合
超时后，需要重新发起该回合。图片输入、结构化输出和强制工具选择尚未接入。

## 开发测试

```sh
bun test
```
