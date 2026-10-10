# xiaohongshu-minitool-check

小红书小工具离线包**上传前自查**工具。零依赖，一条命令扫完，直接告诉你「能传 / 不能传 + 为什么」。

```bash
node bin/cli.mjs ./dist          # 扫目录
node bin/cli.mjs tool.zip        # 扫 zip（真的解 zip，不是看目录）
```

退出码：`0` 可以上传，`1` 有必须修的问题，`2` 用法/读取错误。

## 为什么需要它

小工具是**纯离线 H5 沙箱**：zip 上传 → 容器（PC 模拟器 / 真机 WebView）加载。踩坑的代价很高——传上去发现白屏、样式丢、脚本不执行，往往要来回好几轮。

而头号踩坑来源是**用 AI 生成页面**：AI 默认产出的单文件 HTML，几乎必然带内联 `<script>`、CDN 外链、行内 `onclick`——这三样在容器里**全部不可用**。

这个工具把官方规范里「必须满足」的条款逐条变成可执行的检查，包括几个静态 grep 查不出来的：

- **运行时才拼出来的外链**：AI 生成的页面常把字体/贴图 URL 在运行期塞进 `<head>`，源码里 grep `https://` 一个都找不到。用 `--runtime` 起真实浏览器读资源表才能抓到。
- **zip 多套一层**：`zip -r tool.zip dist` 而不是 `cd dist && zip -r ../tool.zip .`，解压后 `index.html` 变成 `dist/index.html`，容器直接加载不了。工具会把 zip 拆开看入口到底在不在根。
- **音频格式**：官方允许类型清单里**没有任何音频格式**，但另一节又写包内媒体可用（文档自相矛盾）。工具会专门提示这件事，并指向 Web Audio 程序化合成这条零文件的路。

## 检查项

**包结构**：入口 `index.html` 在根目录 / 没有多套一层 / 文件类型白名单 / 混进 `node_modules`·`*.map`·构建配置·`.env` / 多余的 html 文件

**index.html**：`<!DOCTYPE>` / `lang="zh-CN"` / `charset=UTF-8` / viewport 三项（`device-width`、`initial-scale`、`viewport-fit=cover`）/ 内联 `<script>` / 行内事件 / `javascript:` / `<base>` / `<iframe>`·`<object>` / 自建 CSP meta / `target="_blank"` / `<a download>` / 绝对路径 / 外部地址 / **引用的资源是否真的在包里**

**JS / CSS**：被禁 Web API 全表（网络请求、定位、剪贴板、传感器、Worker、WebRTC、`eval`、`new Function`、WASM……）/ CSS 外部资源 / `@font-face` 用 `data:` / 写死像素宽度

**体积**：总包 > 2MB、单图 > 500KB

**运行时（`--runtime`，可选）**：起本地服务用无头浏览器真打开一次，读 `performance` 资源表证明零外链、抓页面异常、看 rAF 是否在跑、报告 WebGL 是否可用

## 关于误报

`--runtime` 之外全是静态分析，所以专门做了精度处理：

- **先剥注释和字符串再扫**：注释里写「别用 `fetch()`」不会误报，字符串文案里的 `fetch` 也不会。
- **打包产物降级**：文件体积大或单行超长（典型是 bundler 产物、three.js 这类库），命中会降成「提示」而不是「必须修」——库里的 `fetch`/`OffscreenCanvas` 很可能在永远不会执行到的代码路径上，工具无权据此拦你上传。
- **命名空间过滤**：`http://www.w3.org/1999/xhtml` 这类是 XML 命名空间，不是资源地址。
- **`min-width` 不算写死宽度**。

自测 `node test/run-tests.mjs`：32 条断言，覆盖「该挂的挂、不该误报的不误报」。

## 已知限制

- 静态分析无法判断一段代码会不会真的被执行；能判断的部分是「写法是否合规」。
- 不支持 zip64（小工具包不会到 2GB）。
- `--runtime` 需要 `playwright-core`（可选依赖）。没装时会跳过并说明，不会报错。已经装了 playwright 的话可以用环境变量指路：

  ```bash
  XHS_CHECK_PLAYWRIGHT=/path/to/playwright-core node bin/cli.mjs ./dist --runtime
  ```

## 给 AI agent 用

仓库里的 `SKILL.md` 是按 agent skill 规范写的，装上之后 agent 就知道「改完小工具要先跑这个自查」。

## 依据

规则来自小红书官方「小工具 ZIP 构建指南」（`minitool-zip-builder` **1.2.0**，发布于 2026-07，本次核对日期 2026-10-10）。
规范原文与版本说明见 `docs/spec-notes.md`；实测踩坑清单见 `docs/pitfalls.md`。

**规范会变**：官方清单或限制一调整，这里的规则就要跟着改。用之前请核对版本。

## License

MIT
