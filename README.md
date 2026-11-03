# CCB Auto

B 站视频页的香港／海外 CDN 节点优选，基于 [CCB 2.1.0](https://github.com/Kanda-Akihito-kun/ccb)。

- 每看几个视频，或播放卡顿时，测当前节点的延迟和吞吐；不达标时在香港／海外节点里找最快的 3 个。
- 点“改走 … 并刷新”才换源，不会自动刷新页面。
- 标题旁的胶囊显示实时加载速度，点开是“驿程”浮层。

## 安装

1. 装好 [Tampermonkey](https://www.tampermonkey.net/)。Chrome / Edge 还要在扩展详情里打开“允许用户脚本”。
2. 关闭旧版 CCB 和其他会改播放源的脚本。
3. 打开 [安装链接](https://raw.githubusercontent.com/Simohara/ccb-auto/main/dist/ccb-auto.user.js)，在 Tampermonkey 弹出的页面点“安装”。以后有新版本会自动更新。
4. 刷新 B 站视频页，标题旁出现状态胶囊就说明装好了。

默认值、测速规则和界面说明见 [README.zh-CN.md](README.zh-CN.md)。

## 构建与测试

```bash
git clone https://github.com/Kanda-Akihito-kun/ccb.git upstream
git -C upstream checkout 2534fd087338047a5938d12c9fe0448b4a9b2bf7
node scripts/build.cjs   # 输出 dist/ccb-auto.user.js
node tests/run.cjs       # 主流程，47 条
node tests/ui.cjs        # 界面，16 条
```

构建会校验上游 `ccb.js` 的 SHA-256，上游一改就停下，需要重新核对锚点。测试用 Playwright 驱动系统 Chrome。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 新增代码：测速核心、浮层、遥测、卡顿检测、Worker 基址修正 |
| `scripts/build.cjs` | 把 `src/` 按锚点拼进上游脚本 |
| `tests/` | 本地模拟页面上的测试 |
| `dist/` | 构建好的用户脚本和测试截图 |
| `android/` | 粉版 9.16.1 的手动测速换源补丁 |
| `android-external/` | 轻舟：不改官方 APK、用本地 VPN 换节点的独立 App |
| `airbridge/` | 把 Windows 指定应用的声音推到 HomePod（与 CCB 无关） |
| `analysis/` | 审查报告、修复日志和分析资料 |
| `design/` | 界面构想稿 |
