// 规则表。来源：小红书「小工具 ZIP 构建指南」1.2.0 的 zip-artifact-spec.md 与 device-capabilities.md，
// 按本仓库的写法重述（不转载原文），版本与日期见 docs/spec-notes.md。

// 允许出现在包内的文件类型（规范 §2）
export const ALLOWED_EXT = new Set([
  'html', 'css', 'js',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'woff', 'woff2',
  'json',
]);

// 规范 §2 没列任何音频格式，但 §3 又写 `<video>/<audio>` 可用包内媒体——官方文档自相矛盾。
// 实测：AudioContext 在容器里可用，所以音效走 Web Audio 程序化合成最稳。见 docs/pitfalls.md。
export const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'oga', 'flac', 'opus', 'weba', 'mid', 'midi']);

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

// 禁止出现在包内的开发垃圾（规范 §1）
export const JUNK_PATTERNS = [
  { re: /(^|\/)node_modules\//, msg: 'node_modules 目录' },
  { re: /(^|\/)\.git\//, msg: '.git 目录' },
  { re: /(^|\/)\.DS_Store$/, msg: '.DS_Store' },
  { re: /\.map$/, msg: 'source map（*.map）' },
  { re: /(^|\/)(vite|webpack|rollup|esbuild|tsup)\.config\./, msg: '构建配置文件' },
  { re: /(^|\/)\.env($|\.)/, msg: '.env（可能含凭据，绝不能出现在包里）' },
  { re: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, msg: '包管理器锁文件' },
];

// 被禁 Web API / 行为（device-capabilities.md §6 扫描清单）
// kind: 'api' 直接命中即错；'soft' 需要人判断（可能出现在注释/字符串里，先剥注释再扫）
export const BANNED_IN_JS = [
  { re: /\bfetch\s*\(/, msg: 'fetch()：不联网，改用包内 .json 或写死数据' },
  { re: /\bXMLHttpRequest\b/, msg: 'XMLHttpRequest：不联网' },
  { re: /new\s+WebSocket\s*\(/, msg: 'WebSocket：不联网' },
  { re: /new\s+EventSource\s*\(/, msg: 'EventSource：不联网' },
  { re: /new\s+RTCPeerConnection\s*\(/, msg: 'RTCPeerConnection：不联网' },
  { re: /navigator\.geolocation\b/, msg: '定位：已禁用，移除' },
  { re: /navigator\.clipboard\b/, msg: '剪贴板 API：已禁用，改用可选中文本引导用户长按复制' },
  { re: /document\.execCommand\s*\(\s*['"](copy|cut|paste)['"]/, msg: "document.execCommand('copy'/'cut'/'paste')：已禁用" },
  { re: /navigator\.(bluetooth|usb|hid|serial)\b/, msg: '硬件连接 API：已禁用' },
  { re: /navigator\.getBattery\b/, msg: 'getBattery：已禁用' },
  { re: /navigator\.connection\b/, msg: 'navigator.connection：已禁用' },
  { re: /navigator\.credentials\b/, msg: 'WebAuthn / credentials：已禁用' },
  { re: /navigator\.locks\b/, msg: 'navigator.locks：已禁用' },
  { re: /navigator\.mediaDevices\.enumerateDevices\b/, msg: 'enumerateDevices：已禁用' },
  { re: /getDisplayMedia\b/, msg: '屏幕共享 getDisplayMedia：已禁用' },
  { re: /navigator\.storage\.persist\b/, msg: 'storage.persist：已禁用' },
  { re: /navigator\.serviceWorker\b/, msg: 'Service Worker：已禁用，逻辑放主线程' },
  { re: /new\s+(Worker|SharedWorker)\s*\(/, msg: 'Web Worker / SharedWorker：已禁用' },
  { re: /new\s+(Accelerometer|Gyroscope|Magnetometer)\s*\(/, msg: '传感器 API：已禁用，改用指针手势' },
  { re: /\bDevice(Motion|Orientation)Event\b/, msg: 'DeviceMotion / DeviceOrientation：已禁用' },
  { re: /['"]device(motion|orientation)['"]/, msg: "device(motion|orientation) 事件：已禁用" },
  { re: /\b(requestFullscreen|webkitRequestFullscreen|mozRequestFullScreen|msRequestFullscreen)\b/, msg: 'requestFullscreen：全屏由容器控制，改用 CSS 布局' },
  { re: /\beval\s*\(/, msg: 'eval()：已禁用' },
  { re: /new\s+Function\s*\(/, msg: 'new Function()：已禁用' },
  { re: /\bWebAssembly\b/, msg: 'WebAssembly：已禁用（依赖 WASM 的库跑不起来）' },
  { re: /window\.open\s*\(/, msg: 'window.open()：已禁用，改单页视图切换' },
  { re: /window\.prompt\s*\(/, msg: 'window.prompt()：已禁用，改页内 Modal' },
  { re: /location\s*\.\s*(href\s*=|assign\s*\(|replace\s*\()/, msg: '跳转站外 URL：已禁用，改单页视图切换' },
  { re: /\bPaymentRequest\b/, msg: 'PaymentRequest：移动端 WebView 不支持' },
  { re: /\bSharedArrayBuffer\b/, msg: 'SharedArrayBuffer：多线程不支持' },
  { re: /\bOffscreenCanvas\b(?=[\s\S]{0,80}?\.getContext|\s*\))/, msg: 'OffscreenCanvas：规范对「依赖 Worker 的离屏渲染」不支持。若只是库内部特性检测（typeof OffscreenCanvas !== "undefined"），通常无影响；但请务必在 PC 模拟器与真机上各跑一次', soft: true },
  { re: /\bcreateObjectURL\s*\(/, msg: 'URL.createObjectURL：仅用于选图/录音预览（blob 媒体文件不能给 <audio>/<video>）', soft: true },
];

// HTML 里逐条扫的写法
export const BANNED_HTML = [
  { re: /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i, msg: '内联 <script>：脚本必须外置，用 <script src="./...">', tag: 'inline-script' },
  { re: /<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i, msg: '脚本引用了外部地址：外部资源加载不到' },
  { re: /\son[a-z]+\s*=\s*["']/i, msg: '行内事件（onclick 等）：改用 addEventListener' },
  { re: /javascript:/i, msg: 'javascript: URI：已禁用' },
  { re: /<base\b/i, msg: '<base> 标签：破坏真机路径，不能用' },
  { re: /<iframe\b/i, msg: '<iframe>：禁止' },
  { re: /<object\b/i, msg: '<object>：禁止' },
  { re: /<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy/i, msg: '自建 CSP meta：安全策略由容器统一管理' },
  { re: /target\s*=\s*["']_blank["']/i, msg: 'target="_blank"：禁止打开新窗口' },
  { re: /<a\b[^>]*\sdownload(\s|=|>)/i, msg: '<a download>：禁止文件下载' },
  { re: /<form\b/i, msg: '<form> 提交跳转会失效：必须 addEventListener("submit", e => e.preventDefault()) 后用 JS 处理', soft: true },
];

// CSS 里的外部资源与写死宽度
export const CSS_CHECKS = [
  { re: /url\(\s*["']?\s*(https?:)?\/\//i, msg: 'CSS 引用了外部资源（url(http...)// )：改包内相对路径' },
  { re: /@import\s+(url\()?["']?(https?:)?\/\//i, msg: 'CSS @import 外部样式表：禁止' },
  { re: /url\(\s*["']?\s*(data:)/i, msg: 'CSS 里用 data: 内嵌资源：图片可以，字体不行（字体只允许包内文件）', soft: true },
  { re: /(^|[;{\s])width\s*:\s*\d{3,}px/i, msg: '写死像素宽度：跨端会变形，改用 % / flex / vw（跨端规范要求）', soft: true },
];

export const LIMITS = {
  totalBytesWarn: 2 * 1024 * 1024,   // 规范推荐总包 < 2MB
  imageBytesWarn: 500 * 1024,        // 单图 < 500KB
  bundleIfBytes: 300 * 1024,         // 超过这个体积或单行超长 → 视为打包产物/第三方库
  bundleIfLineLen: 2000,
};

// 这些地址是命名空间/规范编号，不是资源引用，命中必然误报
export const URL_IGNORE = /w3\.org|xmlns|schema\.org|json-schema\.org|purl\.org|ns\.adobe\.com|openxmlformats/i;
