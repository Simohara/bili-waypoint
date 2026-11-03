# bili-waypoint

**驿程**：B 站视频页的香港／海外 CDN 节点优选脚本，从 [CCB 2.1.0](https://github.com/Kanda-Akihito-kun/ccb) 分出，只有节点列表仍取自上游。

- 每看几个视频或卡顿时测速，在香港／海外节点里挑最快的 3 个；点“改走 … 并刷新”才换源。
- 标题旁的胶囊显示实时加载速度，点开是“驿程”浮层。

## 安装

1. 装好 [Tampermonkey](https://www.tampermonkey.net/)。Chrome / Edge 还要在扩展详情里打开“允许用户脚本”。
2. 关闭旧版 CCB 和其他会改播放源的脚本。
3. 打开 [安装链接](https://raw.githubusercontent.com/Simohara/bili-waypoint/main/dist/yicheng.user.js)，点“安装”。以后有新版本会自动更新。
4. 刷新 B 站视频页，标题旁出现状态胶囊就装好了。

默认值、测速规则和界面说明见 [README.zh-CN.md](README.zh-CN.md)。

## 构建

```bash
node scripts/update-nodes.cjs   # 可选：从上游刷新 data/ 里的节点列表
node scripts/build.cjs          # 输出 dist/yicheng.user.js
node tests/run.cjs              # 主流程
node tests/ui.cjs               # 界面
```

`vendor/ccb.js` 是收进来的 CCB 2.1.0 原版，构建按锚点把 `src/` 拼进去。测试用 Playwright 驱动系统 Chrome。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/`、`scripts/`、`tests/` | 脚本源码、构建、测试 |
| `vendor/ccb.js` | CCB 2.1.0 原版脚本 |
| `data/` | 节点列表快照，来自上游 |
| `dist/` | 构建好的脚本和测试截图 |
