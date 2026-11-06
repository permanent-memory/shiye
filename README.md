# 拾页 · 本地小说阅读器

一个跑在本机的网页阅读器：界面、服务端和书源规则全部留在本地，浏览器只负责渲染。

> 本项目仅供个人学习与技术研究使用。仓库不托管、不分发任何书籍内容；`sources/` 中的规则只描述页面结构，使用者应自行确保对所访问的内容拥有合法访问权限，并遵守相应站点的使用条款。

Node.js 18+，CommonJS，唯一运行依赖 cheerio。

```powershell
npm install
npm start
```

打开 http://127.0.0.1:3000 。服务仅监听回环地址。

支持聚合搜索、详情与完整目录、章节阅读、左右键翻章、浅色/护眼/深色主题、localStorage 书架、封面代理。轻小说搜索通过本地 Edge（找不到时使用 Chrome）与 Node 内置 CDP/WebSocket 完成，需要 Node.js 24+；无需安装浏览器自动化 npm 依赖。浏览器首次搜索时懒启动，复用至空闲 60 秒后回收，服务正常退出时关闭。上游不提供的章节会明确报错，也可在首页粘贴书籍详情链接直接打开。

书源文件位于 sources/，规则使用 CSS 选择器@属性，支持 text/href/src/html 和自身 @text。搜索关键字进行 URL 编码，目录模板提取书籍 id。目录按原顺序去重。修改 JSON 后重启即可。HTTP 请求每次超时 15 秒，失败重试一次，按 Content-Type 解码（含 GBK）。搜索缓存一分钟以缓解站点限流。

接口：GET /api/sources；/api/search?q=&source=；/api/book?source=&url=；/api/chapter?source=&url=；/api/image?url=。搜索返回 {results, errors}，单源错误隔离。图片代理仅接受已配置书源域名。

浏览器书源配置：`search.needsBrowser: true`，`readyCookie` 声明站点初始化 Cookie，`blockedUrls` 仅屏蔽拖住 load 的统计请求。动态探测空闲调试端口，通过 /json/version 获取 CDP 地址和版本 UA，等待首页 complete 与 Cookie 后 POST，空响应最多重试一次，总时限 15 秒。临时浏览器用户目录与日常浏览器隔离。

Edge 启动器可能先于真正浏览器退出；浏览器存活以 CDP /json/version 和 WebSocket 为准。回收使用 Browser.close，等待真实浏览器退出及文件释放后清理临时 profile，不使用启动器 PID 杀进程。


## 多源自动回退

章节 API 可传 `bookTitle`、`chapterIndex`（从 0 开始）和可选 `chapterTitle`。当前源无法提供正文时，最多尝试 3 个其他书源，每个源最多取 3 本匹配书籍；优先匹配章节标题，再使用目录下标。总请求时限 28 秒（小于任务要求的 60 秒上限）。返回 `switchedFrom`、新源信息、`resolvedBook` 和新章节下标，网页会提示换源并继续使用新目录。成功结果缓存 5 分钟、详情目录缓存 1 分钟，缓存命中不再请求上游。全部失败返回原始错误及各源原因。

## 桌面版

```powershell
npm run desktop
npm run desktop:pack
```

桌面版会启动自己的本地服务器，从 3000 到 3009 选择可用端口。默认窗口 1280×860，最小 900×600；尺寸和位置保存在用户数据目录的 window.json 中。启用单实例、contextIsolation、sandbox，关闭 nodeIntegration。关窗后关闭服务器和 headless 浏览器。

打包生成 dist/Shiye-1.0.0-portable.exe，可直接运行。只有 electron 和 electron-builder 两项新增开发依赖。

下载与打包代理配置：

```powershell
npm config set proxy http://127.0.0.1:7890
npm config set https-proxy http://127.0.0.1:7890
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:ELECTRON_GET_USE_PROXY='1'
npm run desktop:pack
```
