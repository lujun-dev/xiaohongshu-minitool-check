# 实测踩坑清单

全部条目来自 2026-10 在真实小工具项目上的实测（不是读文档抄的）。每条标了证据等级。

---

## 1. AI 生成的「单文件 HTML」直接上传必然失败

**现象**：让 AI 写一个 H5 小游戏，产出通常是 `<script type="importmap">` + `<script type="module">` 从 CDN import three.js 的单文件 HTML。这个形态**三处违规**：内联脚本、外部域名、行内事件。

**怎么办**（实测可行的改造流程）：

1. 把 `<style>` 抽到 `dist/assets/style.css`，module 脚本抽到 `build/src/entry.js`
2. CDN 依赖改成本地包导入（`three/addons/x.js` → `three/examples/jsm/x.js`）
3. `npm i three esbuild`，然后
   `npx esbuild src/entry.js --bundle --minify --format=iife --target=es2019 --outfile=../dist/assets/app.js`
   —— 关键是要 **IIFE 而不是 ESM**：产物里一条 `import` 都不剩，正好对上官方要求的 `<script src>`
4. 手写 `dist/index.html`：doctype + `lang="zh-CN"` + charset + viewport(`viewport-fit=cover`) + `<link>` + 原来的 body DOM（**别漏 `<canvas>` 这类宿主元素**，漏了就是 `Cannot read properties of null`）+ `<script src="./assets/app.js">`
5. `cd dist && zip -r ../tool.zip .`

**证据等级**：实测（体积参考：three.js + 一个中等场景，bundle 后 ≈ 680KB，zip 后 ≈ 190KB）。

---

## 2. zip 必须压「目录内容」，不是「目录本身」

**现象**：`zip -r tool.zip dist` 传上去加载不出来。解压后看到的是 `dist/index.html`，而容器只认根目录的 `index.html`。

**记住这一条就够**：压缩的是**与 index.html 同级的那批文件**本身。

```bash
cd dist && zip -r ../tool.zip .   # ✅ index.html 在 zip 根
zip -r tool.zip dist              # ❌ 多套一层
```

**证据等级**：实测 + 官方规范明文（这是唯一硬性要求）。

---

## 3. 音频格式不在允许清单里，而且官方文档自相矛盾

**现象**：官方「支持的文件类型」表里列了 html/css/js/图片/woff/woff2/json，**一个音频格式都没有**。但同一份文档另一节又写 `<video>/<audio>` 可用「包内媒体文件」。

**怎么办**：音效走 **Web Audio API 程序化合成**（振荡器 + 包络 + 噪声），零文件、零体积、不受格式限制。BGM 同理。

**证据等级**：实测（官方文档两处条款对不上，这是文档问题，只能按严的那条设计）。

---

## 4. WebGL 可用，但纹理必须来自包内

**可以用**：Canvas 2D、WebGL/WebGL2、包内图片/Canvas/内存对象作纹理。

**不可以用**：外部域名图片作纹理（不联网）、依赖 WASM 的加速库（Draco / Basis / ONNX / 抠图算法）、`OffscreenCanvas` + Worker 的离屏渲染、`SharedArrayBuffer` 多线程。

**坑**：打包后的 three.js 里会有 `typeof OffscreenCanvas !== "undefined"` 这类**特性检测**，静态扫描会命中，但它是库内部逻辑、通常无影响——本工具会把它降级成提示，只要求你在真机上实测一次。

**证据等级**：规范 + 实测（three.js bundle 里确实存在该特性检测代码）。

---

## 5. 外部资源是「运行时拼出来」的，静态 grep 查不到

**现象**：AI 生成的页面里 grep `https://` 一个都找不到，但打开后网络请求里全是外链——它把字体/贴图的 URL 在运行期拼好塞进 `<head>`（典型来源：fontsource 这类字体包的 CSS，从 registry 拉）。

**怎么办**：必须跑真实浏览器，读运行时资源表：

```js
performance.getEntriesByType('resource')
  .map(e => e.name)
  .filter(n => !n.startsWith(location.origin))
```

非空就是外部资源，逐个内联或删掉。字体若来自 fontsource 之类的 CJK 包（一套 120+ 个 unicode-range 子集文件），**别整体下载**，先回退系统字体。

**证据等级**：实测（这条是静态扫描原理上查不出来的，只能靠运行时）。

---

## 6. 用后台标签页截图验证渲染 → 必然空白（假阴性）

**现象**：用自动化驱动浏览器打开页面后截图，图片全空，只有背景色，看起来像「渲染失败」。

**原因**：标签页在后台时 `document.hidden === true`，Chrome 对隐藏页不调度 `requestAnimationFrame`，WebGL 一帧都不渲染。**这是验证环境的问题，不是包的问题。**

**怎么办**：

- 用独立的、可见的浏览器实例验证，不要复用后台标签页
- 判「渲染成功」别只看截图，读代码自己加的标记（如 `canvas.className` 里有没有 ready class）
- 读 `window.onerror` 捕获表 + 控制台
- 想强制出一帧：在源码里把 renderer 挂到 `window` 上，再手动 `renderer.render(scene, camera)`

**证据等级**：实测（本次工具 `--runtime` 会把 `document.hidden` 单独报出来，就是为了不再被这条骗）。

---

## 7. 玩法/交互层怎么做出「确定性」验收

真等时间跑完一局是不可接受的（慢且不确定）。实测可行的做法：

1. **让页面自己暴露测试接口**（示例：`window.__test` 上挂 state / take / set / restart 等方法）
2. **别凭记忆写方法名**——先 grep 源码确认真名（踩过：以为叫 `addBill`，实际叫 `bill`）
3. **快进代替真等**：直接改状态把时间推到关键点（上客计时器清零立刻来客；把烹煮进度设在熟度窗内）
4. **断言要独立重算**：从日志里正则取出分数，在脚本里按公式**重算一遍**比对，而不是截图看着对
5. 结果：一整轮（示例 12 个交互对象）几秒跑完，12/12 与公式一致

**证据等级**：实测（这套方法跑通过整轮）。

---

## 8. 其它容易忽略的条文

| 条文 | 后果 |
| --- | --- |
| `localStorage` / `IndexedDB` / Cookie 可用，但**数据不保证永久持久化** | 别把核心玩法设计成强依赖长线存档 |
| 禁 `eval` / `new Function` / WASM | 依赖它们的库直接换掉 |
| 禁 `navigator.clipboard`、`document.execCommand('copy')` | 复制功能只能展示可选中文本、引导用户长按复制 |
| 禁 `requestFullscreen` | 视觉全屏用 CSS 布局（`100vh` + flex + 隐藏滚动）实现 |
| 禁 `window.open` / `target="_blank"` / `<a download>` | 多视图用单页 DOM 切换 |
| `<form>` 提交跳转会失效 | `addEventListener('submit', e => e.preventDefault())` 后自己处理 |
| 不写 `<base href>` | 会破坏真机路径 |
| `<input type="file">` 只能选图片和视频 | 无论 `accept` 怎么填 |
| 摄像头/麦克风要**用户手势触发 + 授权** | 不能自动调用 |

**证据等级**：官方规范条文（本次按其逐条实现为检查项）。

---

## 9. 官方规范包带版本号，别猜 URL

实测（2026-10-10）：`https://fe-static.xhscdn.com/mini-tool/<版本>/minitool-zip-builder.zip`

| 版本 | 结果 |
| --- | --- |
| 1.0.0 / 1.1.0 / 1.5.0 / 1.7.0 / 2.0.0 / latest | **全部 404** |
| **1.2.0** | 200，12KB，`Last-Modified: 2026-07-03` |

所以：只能从官方创作者文档给的链接进，不要凭「版本号加一」拼地址。本仓库的规则对应 1.2.0，用之前核对一遍是否还是这个版本。

**证据等级**：实测（HTTP HEAD 逐个试的）。
