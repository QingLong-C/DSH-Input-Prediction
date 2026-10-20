# 面向插件作者：DSH 插件的开发回路（隔离实例 + 构建身份自证）

> **状态：草稿，尚未发出，也无回复。** 计划投递位置：`awesome-dsh-plugin` 的 issue 区（先提议，由维护者
> 决定落点），或 `contributing.md` 的一小节。不在本仓维护，也不代表本仓的插件列表。
>
> **本文明确区分**：标注「实测」的都有本机日志或源码行号支撑；标注「未验」的**在 live 环境跑通前
> 不应对外发布**。该站点对投稿的核对标准是"描述必须属实，会拿代码核对"，本文按同一标准自我约束。

## 一、要解决的普遍问题

插件开发者普遍在等一次重启：宿主层代码改了，不重启不生效；而重启会打断正在跑的会话。于是
"改完 → 等重启 → 验证 → 发现验的是旧代码 → 再来一轮"。这条回路里有三个各自独立的原因，
分开治才有效。

## 二、三条约定（与具体插件无关）

### 1. 让进程自己报告"我加载的是哪份构建"　【实测】

宿主加载的是**入库产物**（`package.json` 的 `main` 指向 `lib/`，多数字如此），不是 `src/`。
"src 改完了"和"进程跑的是旧字节"可以同时成立且**无法从外部区分**。本插件的解法是在 `apply()`
入口打一行：

```
[<你的插件标记>][ops-trace] apply called; artifact mtime=<lib/index.js 的 mtime>
```

mtime 在模块顶层求值（记的是**这次加载读到的文件**，不是之后盘上的版本）。每次挂载一行，
boot 与热重载各一行；比较时间戳即可判定"这轮观察算不算数"。

> 前置事实【实测，源码定位】：健康运行的进程里 `ctx.logger` **不落任何地方** —— 全局只有一个
> exporter（`@deepseek-ai/dsh-app-boot` 的 `boot()` 内唯一一个；`levels:{default:2}` 挡掉 debug，
> 回调只收 warn/error 所以 info 也丢），而它攒的 `startupLogs` 只在**启动失败**时由
> `@deepseek-ai/dsh/lib/bin.js:158` 写盘。运行期唯一可见面是 `console.log` → stdout → 宿主 tee 的日志。
> 因此这类留痕既不能用 logger，也不能被当成"调试噪声"清掉——建议用固定标记区分语义留痕与噪声。

### 2. 第二实例必须做两层隔离　【实测】

- `DSH_HOME` 独立 → `sessions`/`storages`/`logs` 全进沙箱目录。`dsh-home-paths/lib/index.js:73-84`
  的 `resolveDshHome()` 确实读这个环境变量。会话目录**惰性创建**，所以"沙箱里暂时没有
  `sessions/`"不等于共享，别据此判定隔离失败。
- **插件产物也要独立**：把 `<profile>/node_modules/<你的包>` 指向一份私有副本（其余依赖逐条软链，
  不跑 install）。否则你放进沙箱的未验证构建，会污染 live 宿主下次重启真正加载的那份 `lib/`。

`--port` 只管主 GUI 端口。profile 里被别的插件钉死的监听端口（本机遇到的是 `dsh-host-webserver`
的 `port: 3081`）必须绕开：不绕开的后果不是报错而是**服务缺失 → 实例在跑第一个 agent 回合时
静默退出**，极易误判成别的原因。

### 3. 热重载要显式开启，且默认配置对 `link:` 插件不友好　【实测】

`@deepseek-ai/dsh-hmr` 的 README 写明 base bundle 用 `root: []` 启用它，而 `root` 为 `[]` 时
「只保留 explicit configuration watches」= 只监听 profile 的配置文件，不监听任何模块源码。
更隐蔽的一层：默认 `ignored` 是 `["**/node_modules", "**/.*", "cache", "data"]`，而开发期插件是
`link:` 挂在 `profiles/<p>/node_modules/<包名>` 下的 —— **即使把 root 配成 `["."]` 也监听不到它**。
可用配置（范围要窄，别让 chokidar 去遍历整个 node_modules）：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - node_modules/<你的包名>/lib
    ignored: []
    debounce: 100
```

两个实测细节：① 只 `touch` 换 mtime **不触发**，要真改内容；② **依赖"在 `apply()` 期建立的异步
上下文"才能工作的东西不能用热重载验证**（例：见下条），这类必须整进程重启。

## 三、顺带会撞上的两条内核语义（与插件写法有关）【实测】

1. **在 `settings/document-updated` 回调链上发起的 settings 写入会被拒**：
   `@deepseek-ai/dsh-hmr` 用 `AsyncLocalStorage` 建事务（`executing.run(true, …)`）、判据是 `executing.getStore()`；
   `dsh-settings/lib/index.js:509-510` 的 `write()` 在 `configEditor.edit()` 回调内调 `describe()`，
   而 `:435` 的 `emit("settings/document-updated")` 就在 `describe()` 里同步发出。ALS 沿
   `await`/microtask/**事务内创建的 timer** 传播，所以"推迟一个 tick"不逃逸。实测五种写上下文的结论：
   **只有 `apply()` 期建立的定时器/interval 在事务外**（写入 OK），handler 的 await 续体内写 1ms 即被拒。
   受影响最深的是"消费后清空 `_ops`"这类回写：它会**永久失败**，于是载荷长期滞留，**新实例一启动
   就重放上一进程遗留的 op**（实测：没有任何客户端连接时，新实例消费了一条遗留 `complete`）。
2. **`ctx.settings.update()` 不传第三个参数时内核跳过冲突校验**：
   `dsh-settings/lib/index.js:511` 的判据是 `expected !== void 0`。本仓所有 `update()` 调用点都没传，
   所以那条写"必然成功"，包括**被拒时也一样**（客户端只看 Promise 态的话就是假 OK）。

## 四、适用范围（本机扫描，别当成普遍结论）

| 谁需要 | 本机命中 |
|---|---|
| `lib/` 入库 → 会遇"重启验旧字节" | 5 个仓 |
| 有 `.volatile()` 配置 → 载荷会落进 profile 并被新实例重放 | 4 个仓 |
| 事件回调里写 settings → 会撞 nested transaction | 2 个仓 |
| 只改 client 侧 | 刷新页面即可，上面这些都不需要（browser 模块图是独立加载机制） |

## 五、未验清单（发布前必须补齐）

- [ ] live 宿主重启后确认幽灵在真实环境出现（目前只在**隔离实例**端到端跑通）
- [ ] `hmr` 配置能否被热接受（文档写的是 "before launching"，未证实）
- [ ] 上面 5 仓/4 仓的扫描是本机现状，不代表社区插件总体分布
