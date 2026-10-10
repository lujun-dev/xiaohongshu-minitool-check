# 规则依据与版本

本仓库是**规则的重述 + 自动化实现**，不是官方文档的转载。判定一律以官方原文为准。

## 来源

小红书官方「小工具 ZIP 构建指南」（agent skill 形态，`minitool-zip-builder`）：

```
https://fe-static.xhscdn.com/mini-tool/<版本>/minitool-zip-builder.zip
```

| 项 | 值 |
| --- | --- |
| 本次对应版本 | **1.2.0** |
| 该版本构建时间 | 2026-07-03（HTTP `Last-Modified`） |
| 本次核对日期 | 2026-10-10 |
| 包内文件 | `SKILL.md` + `references/zip-artifact-spec.md` + `references/device-capabilities.md` + `references/cross-platform-h5.md` |

**别猜 URL**：实测 1.0.0 / 1.1.0 / 1.5.0 / 1.7.0 / 2.0.0 / latest 全部 404，只有当时有效的那个版本号能被访问。入口请从小红书创作者中心的文档进。

## 三份 reference 各自管什么

| 文档 | 覆盖 |
| --- | --- |
| `zip-artifact-spec.md` | 目录结构与打包方式、允许的文件类型、资源加载规则（容器 CSP）、路径与引用规则、`index.html` 模板、打包前自检清单、体积建议 |
| `device-capabilities.md` | 可用能力、不可用 Web API 清单及替代写法、不可用行为、WebGL/图形计算边界、常见交互实现方式、改写扫描清单 |
| `cross-platform-h5.md` | 触摸、滚动、安全区、布局与媒体、PC 模拟器与真机差异、跨端自检 |

## 本工具把哪些条款变成了检查项

**覆盖到的**（对应 `src/rules.mjs`）：

- 允许的文件类型白名单；禁止出现在包内的开发垃圾（`node_modules` / `.git` / `.DS_Store` / `*.map` / 构建配置）
- 入口 `index.html` 在包根目录；单页（不允许多个 html）
- 容器 CSP 约束：脚本必须外置（禁内联 `<script>`、行内事件、`javascript:`、`eval`、`new Function`、WASM）；禁外部域名脚本/样式/图片/字体/媒体；禁 `<iframe>` / `<object>`；禁自建 CSP meta
- 路径规则：相对路径、禁绝对路径、禁 `<base href>`
- 禁用的 Web API 与行为（网络请求、定位、剪贴板、传感器、Worker、WebRTC、全屏、`window.open/prompt`、`<a download>`、`target="_blank"`、`<form>` 跳转提交、`location` 跳转等）
- 图片可用包内/`data:`/`blob:`，音视频与字体只能用包内文件
- 体积建议（总包 < 2MB、单图 < 500KB）
- 跨端建议（不写死像素宽、安全区 `env()`）

**没覆盖的**（静态分析做不到，或不适合自动化）：

- 代码运行时的实际行为（某段被禁 API 是否真的会被执行到）——工具对打包产物会降级为「提示」，最终以真机实测为准
- 相机/麦克风是否「用户手势触发 + 授权」——需要人看交互设计
- 业务逻辑改写是否正确（事件有没有绑、依赖的 DOM 是否存在）
- 视觉与手感

## 文档本身的两处矛盾（按严的那条实现）

1. **音频**：允许文件类型表没列任何音频格式，但资源加载表写 `<video>/<audio>` 可用「包内媒体文件」。→ 工具按「不在白名单」报错，并提示改用 Web Audio 程序化合成。
2. **图标/字体子集**：字体允许 `.woff`/`.woff2` 包内文件，但 CJK 字体子集化后动辄上百个文件——文档没有明确上限，实际按体积建议（总包 < 2MB）自行控制。
