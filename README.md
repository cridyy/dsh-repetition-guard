# dsh-repetition-guard

DSH Web 的流式复读守卫：检测 reasoning/text 流中的持续复读，循环思考，思维链死循环，隔离失败尝试，并在有限次数内从干净上下文自动重试。

> Community plugin；不隶属于 DeepSeek。检测是启发式，不能保证零误报或覆盖所有模型退化模式。

## 解决什么问题

有些模型会长时间输出类似以下内容，而不是完成任务：

```text
Writing. OK. Let me write. Go. Writing. Now.
```

插件会在流式生成期间检查 reasoning 和正文，发现持续复读后：

- 关闭当前上游流，避免继续消耗请求；
- 将失败尝试保存为 DSH 标准 `assistant/attempt`，不放进下一次模型可见历史；
- 默认等待 1 秒，最多自动重试 1 次；
- 第二次仍失败时停止，不进入无限重试；
- 如果关闭流和用户取消发生竞态，只隔离本次新生成的异常消息；
- 不扫描、不清理、不重写既有历史会话。

插件只拦截 agent-loop 请求；标题、摘要等其他 LLM 调用不由它接管。

## 安装

发布到 npm 后，推荐使用 DSH 官方 profile 插件命令：

```powershell
dsh plugin --profile web add dsh-repetition-guard
```

然后重启 `dsh web`。

从本地 tarball 测试时：

```powershell
dsh plugin --profile web add ./dsh-repetition-guard-0.1.1.tgz
```

卸载：

```powershell
dsh plugin --profile web remove dsh-repetition-guard
```

> 不要把源码仓库里的 `tools/install-web.ps1` 当成公开用户的首选安装方式。它是早期本机安装/回滚工具，依赖特定的 dsh 运行时布局；公开包通过 profile 插件命令安装。

## 默认配置

包内的 `cordis.patch.yml` 只加入这一项：

```yaml
- insert:
    - id: repetition-guard
      name: dsh-repetition-guard
      config:
        maxRetries: 1
        retryDelayMs: 1000
```

主要默认值：

- `enabled: true`
- `maxRetries: 1`（不含第一次请求，最多总计 2 次调用）
- `retryDelayMs: 1000`
- `minReasoningChars: 2048`
- `minTextChars: 4096`
- `guardText: true`
- `rejectEmptyCompletion: true`

需要自定义时，在自己的 profile patch 中覆盖 `repetition-guard` 的 `config`。不建议直接编辑已安装包内的 `cordis.patch.yml`。

## 与其他守卫插件共存

公开包不会自动禁用用户的其他插件。如果同时启用了其他 reasoning/assistant-output 复读守卫，可能重复拦截或重复重试；建议只保留一个负责 assistant 输出复读检测的插件，同时保留独立的工具调用循环保护。

## 安全边界

- 不修改 DSH 核心包。
- 不上传请求正文、reasoning 文本或凭证。
- 诊断信息写入运行日志；失败状态使用 DSH 已知事件类型。
- 不对旧会话做批量清洗。
- 自动重试可能增加模型调用次数和费用；`maxRetries` 可设为 `0` 关闭重试。
- 检测阈值过低可能误报，阈值过高可能来不及拦截短循环。

## 兼容性

当前公开包以以下环境为验证基线：

- DSH `0.1.5-rc.2`
- Node.js `>=22.15`（开发验证使用 Node 24）
- DSH Web profile

没有对所有未来 DSH 版本作兼容承诺。升级 DSH 后，建议先在测试 profile 中验证，再更新生产 profile。

## 开发与验证

源码仓库保留测试、日志只读分析器和旧会话修复工具；这些维护工具不包含在 npm 运行包中。

```powershell
npm test
npm pack --dry-run
```

完整测试覆盖：

- 流式复读检测和分片边界；
- 失败尝试隔离与下一请求历史；
- 有限重试、取消竞态和插件卸载；
- 工具调用不重复执行；
- 与其他重试策略共存；
- 持久化写入、冷读和旧诊断事件兼容性。

## 旧版 0.1.0 会话

0.1.0 曾写入缺少 `ignorable: true` 的自定义诊断事件，可能导致旧会话重新加载失败。0.1.1 已停止写入该事件。源码仓库中的 `tools/repair-diagnostic-event.mjs` 只用于对用户明确指定的单个日志做备份后修复，不会被公开运行包自动执行。

## License

MIT，见 [`LICENSE`](./LICENSE)。
