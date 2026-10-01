# Changelog

## 0.2.0 - 2026-10-01

- Target DSH Desktop `0.2.0-rc.2`.
- Align peer and development dependencies with `@deepseek-ai/dsh-llm` `0.2.0-rc.2` and Cordis `~4.0.4`.
- Keep the repetition detector and bounded retry behavior unchanged; the 0.2 runtime retains the plugin event contracts used here.

## 0.1.1 — 2026-09-29

- 停止写入未被旧版 DSH 识别的自定义会话事件，避免历史重新加载失败。
- 保留标准 `assistant/attempt`、`llm/retry` 和 `llm/retry-started` 作为可回放状态。
- 增加持久化冷读、旧诊断事件修复和写锁竞态测试。
- 整理为可通过 DSH profile 插件命令安装的公开包布局。

## 0.1.0

- 首个本地验证版：流式复读检测、异常尝试隔离、有限自动重试和空完成保护。
- 仅对 agent loop 请求生效，不扫描或修改既有历史会话。
