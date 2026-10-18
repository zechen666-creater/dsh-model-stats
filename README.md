# dsh-model-stats 按模型用量

在 DSH 对话界面**输入框那一排**（宿主统计条旁）加一个小面板：
按 **提供方 / 模型** 分列显示 —— **总 token、缓存读、未缓存输入、输出、缓存命中率、输出速率(tok/s)**。

一个对话里换过几个模型时，宿主自带的统计只给**整会话汇总**，不按模型拆；本插件补上这个缺口。

## 面板长什么样

输入框那排的宿主统计条旁，多出一颗「N 个模型 · X 输出」药丸：

![stats bar](docs/screenshots/stats-bar.png)

点药丸展开，按提供方/模型分列（截图已脱敏，提供方列遮挡）：

![panel](docs/screenshots/panel.png)

表格列：

| 提供方 / 模型 | 总 token | 缓存读 | 未缓存输入 | 输出 | 命中率 | 输出速率 |
|---|---|---|---|---|---|---|
| mimo-v2.6-flash | 41.1M | 40.0M | 933K | 180K | 97.7% | 58 tok/s |
| deepseek-v4.1-flash | 21.3M | 20.8M | 273K | 208K | 98.7% | 223 tok/s |

## 口径（与宿主一致，不是自创）

| 指标 | 算法 | 对齐的宿主口径 |
|---|---|---|
| 缓存命中率 | 缓存读 ÷（缓存读 + 未缓存输入） | `ui-chat` 的 `formatCacheHitPercent(cacheReadTokens, totalTokens - outputTokens)` |
| 输出速率 | 输出 token ÷ 解码耗时 | `dsh-session-stats` 的 `decodeTokens / decodeMs`，其中解码耗时 = 消息完成时刻 − 首个流式帧时刻 |
| 模型归属 | `assistant/message` 事件的 `data.message.source.model` | 实测全量覆盖 |

## 架构

- **宿主半** `lib/index.js`：注册只读路由
  `GET /plugins/dsh-model-stats/stats?sessionId=…`，读
  `DSH_HOME/sessions/**/<sessionId>/session.v4.jsonl.zstd`，解 zstd 帧后折叠。
  按 `(mtime, size)` 缓存折叠结果，5 秒轮询不会反复解压。
  纯读：不改会话日志、不调用模型、不写盘。
- **客户端半** `lib/client.js`：往 `conversation.composer.dock`
  （`kind:list, scope:session`）注入面板，`inject: (sessionId) => ({ sessionId })`
  直接拿到当前会话 ID，每 5 秒拉一次路由。

**安全**：路由带回环守卫（`Host` + `Origin` 都必须是回环地址），与
`dsh-workbuddy-bridge` 的 credit 路由同一口径，防 DNS 重绑定。

## 运行时要求

- **Node ≥ 24**（`zlib.zstdDecompressSync`）。DSH 自带的 node 满足；
  若系统全局 node 低于 24 则**没有 zstd** —— 别拿它跑。

## 卸载

```
dsh plugin --profile desktop remove dsh-model-stats
```

（跑之前确认 DSH 桌面端已完全退出。）

## 已知限制

- 面板只统计**已写盘**的用量，不是实时流；每 5 秒刷新一次。
- 解压/折叠只在会话文件 `(mtime,size)` 变化时重算。
- 面板渲染在 composer dock，紧凑模式的宿主统计条仍然并排存在 —— 不隐藏宿主任何东西。

## 开关（两种，分工不同）

| 想干嘛 | 在哪 | 效果 | 生效方式 |
|---|---|---|---|
| **只隐藏面板**（数据不丢） | 输入框那排按模型统计条，点右侧 **⏸** | 面板消失、**停止 5 秒轮询**；宿主路由仍在但只是按 (mtime,size) 缓存读 | **即时**，localStorage 持久，跨会话跨刷新记住 |
| **彻底停用整个插件** | 侧栏 → **插件** → 已安装 → `dsh-model-stats` 组合包开关 | 往 `cordis.patch.yml` 写 `disabled: true`，宿主路由 + 客户端面板**都停** | 热重载；若提示 `restart-required` 则重启一次 |

重新打开面板：点 **「按模型统计 · 已关 ▶」**；或控制台执行 `dshModelStats.on()` / `dshModelStats.off()`（即时生效，不用重启）。

> DSH 自带的 `设置 → 插件列表` 是**只读**的（“查看插件，而不改变其配置”），开关在**侧栏的「插件」页**（`remote.pluginManager.setBundleEnabled` / `setPluginEnabled`，写完 patch 会热重载）。

### 改代码后必须重装

`dsh-manifest` 是 `file:` 依赖，pnpm 是**拷贝**不是软链——改了 `lib\client.js` 或 `lib\index.js` 后必须：

```
dsh plugin --profile desktop remove dsh-model-stats
dsh plugin --profile desktop add file:../../plugins/dsh-model-stats
```

（cwd = `$DSH_HOME/profiles/desktop`，env 要带 `DSH_HOME` 指向你的 DSH 主目录，否则报「profile 未初始化」）

## 历史

- 2026-10-15 0.1：初版。**客户端没导出 `exports.inject` → 崩了 DSH 前端**（web boot: 1 entry did not activate）。已修（`inject = ["slots"]` + `apply` 全 try/catch）。
- 2026-10-15 0.2：加面板级开关（localStorage + ⏸ 按钮 + DevTools 手柄）。

## 风格：对齐宿主 StatsPills（0.3.0 重写）

第一版布局不对（⏸ 掉到第二行、硬编码灰色药丸），0.3.0 改成照抄宿主：

| 维度 | 宿主 `StatsPills.module.css` | 本插件 |
|---|---|---|
| 根容器 | `display:flex`（**横向**）+ `gap:12px` | 同 |
| 字号/行高 | `calc(var(--dsh-content-font-size-secondary,13px) - 1px)` / `calc(20px + …delta)` | 同 |
| 药丸 | `border:none;background:none;border-radius:999px;padding:1px 8px;gap:6px` + `tabular-nums` | 同 |
| 药丸配色 | 默认 `--dsw-alias-label-tertiary`，hover 才上 `--dsw-alias-interactive-bg-hover` | 同（**不再写死 rgba 灰**） |
| 展开面板 | `stat-dialog`：`--dsw-specific-menu` + `radius-lg` + `elevation-prominent` + `padding:16px` | 同 |
| 表格线 | `--dsw-alias-border-l1`（行）/ `--dsw-alias-border-l2`（标题分隔线） | 同 |
| 图标 | `ui-primitives`（Gauge=速率、Database=用量） | 同款，另加 Chevron 展开 / Pause 关闭 |
| 错误色 | — | `--dsw-alias-state-error-primary` |

**主题自动适配**：颜色全走 `--dsw-alias-*` 变量，浅色/深色主题不用改代码。

**图标库是可选增强**：`require("@deepseek-ai/dsh-client-ui-primitives")` 包在 try/catch 里，拿不到就退回 `▶ ⏸ ▲ ▼` 字符字形——**绝不会因缺图标导致激活失败**（上次崩就崩在这类没兜底的假设上）。

包已声明：`dsh.client.inject` 增列 `@deepseek-ai/dsh-client-ui-primitives`，`peerDependencies` 同步。

## 0.4.0：对齐宿主弹层行为（三条反馈）

| 反馈 | 改法 |
|---|---|
| 风格仍对不上 | 弹层改用**宿主 stat-dialog 规格**：`position:fixed` + `--dsw-specific-menu` + `radius-lg` + `elevation-prominent` + **`elevation-stroke-color`** + `max-width:440px`（原来我开了 660px 且漏了描边色，看着就不一样）|
| 暂停键不用出现 | **删掉 ⏸**；关闭入口移到**弹层页脚「关闭面板」**（只在展开时可见），重开点药丸 |
| 点其他地方要自动关 | 照抄宿主 `useStatDialog`：`pointerdown` **捕获阶段**判 `root`/`panel` 都不含 target → 关（`useDismissOnOutsidePointer` 同语义）+ **Escape 关**；弹层 **portal 到 body**，首帧 `MEASURE_STYLE{visibility:hidden}` 占位，交给 `useAnchoredPosition` 测量定位（side=top / gap=8 / margin=12，滚动·缩放·面板尺寸变化都重算并夹视口）|

> 锚定与图标 hook 在**模块级**探测（`HAS_ANCHOR`）后再**无条件**调用——React 规定 hook 每轮顺序必须一致，条件式调用会打乱。

### 弹层列数

5 列（模型 / 总 token / 输出 / 命中率 / 输出速率），**缓存读与未缓存输入放在模型名的 title 提示里**——为的是守住宿主 440px 的弹层宽度上限，列数硬塞会撑破。悬停模型名即可看全量明细。
## 0.5.0：接上 composer-glass 的状态胶囊（反馈：「玻璃动效没应用在你这版」）

**他的判断对**：`dsh-composer-glass` 的「状态胶囊」组是按 **`[data-composer-stats]`** 选中宿主 StatsPills 根节点的（源码注释原话：「Both pills already share one root, and that root carries the stable `data-composer-stats` attribute, so a single rule puts BOTH in one chip」），给它套 `width:max-content; padding:2px 10px; gap:8px; border-radius:999px` + 毛玻璃 + `--dsh-glass-chip-halo`。

我原来用的是自造属性 `data-dsh-model-stats` → **选择器根本没命中 → 玻璃不作用**，于是那颗药丸是裸的，和旁边带玻璃的宿主胶囊不统一。

改法：

1. 根节点挂上 **`data-composer-stats: true`**（另存 `data-dsh-model-stats` 供自己调试）—— 已确认全工程**没有任何 `querySelector('[data-composer-stats]')`** 的单例假设，复用安全；
2. 结构改成 **`wrap → root(玻璃胶囊) → panel(兄弟节点)`**：玻璃规则带 `overflow:hidden`（用来裁药丸 hover 底色），弹层若作为 root 子节点会被裁掉，所以挂到 wrap 上（或门户到 body）；
3. **刻意不写 `background`/`padding`/`border-radius`**：我的样式表注入更晚、与玻璃规则同优先级会**盖掉玻璃**；宿主 StatsPills 本身也不写这些（只写度量）。

> 结果：玻璃开 → 我这颗也有胶囊；玻璃关 → 我这颗也裸。**同进同出，这才叫风格一致。**
## 0.5.1

按反馈**去掉触发器右侧的小箭头（Chevron）**——展开/收起已有 `aria-expanded` 与弹层自身表达，箭头冗余。触发器现在是「Gauge 图标 + 标签」两件，和宿主药丸一致。

## 0.5.2

弹层**整行页脚删除**（反馈：「觉得这一段没必要出现」）：「缓存读 · 命中」与表内列重复，「关闭面板」与点外部 / ESC / 再点药丸重复；宿主 stat-dialog 本身也没有页脚。弹层现在只剩「标题 + 分隔线 + 表格」。

> 彻底停用插件：侧栏 → 插件 → `dsh-model-stats`，或控制台 `dshModelStats.off()`（`on()` 打开面板）。

## 0.7.0：补「提供方」（反馈：只显示了模型没显示提供方）

- 宿主半：原聚合键只有 `model`，**没取 provider** → 改为按 `message.source.provider + model` 折叠，行里新增 `provider` 字段（同 model 来自不同提供方时各成一行）。实测多提供方环境下同名模型正确拆行。
- 客户端：表头 `提供方 / 模型` 拆成 **提供方 | 模型** 两列；提供方单元格只放**首字母大写**（`X` / `W` / `D`），完整值进 `title` 悬停可见；模型列 `title` 改为 `provider / model`。
- 腾宽度：`.dshms_th/.dshms_td` 内边距 `6px → 4px`，模型列 `max-width 170 → 150px`，新增 `.dshms_prov`（26px、居中、tertiary 色）—— 守住宿主 `440px` 弹层上限不破。

## 0.8.0：提供方缩写表

默认表**只收常见官方套餐 / coding plan**（中转站、私有 provider 不进默认表）：

| 提供方全名 | 缩写 |
|---|---|
| `deepseek`、`deepseek-account`、`deepseek-official` | **ds** |
| `zai`（智谱） | **z** |
| `glm-coding`（智谱编码套餐） | **glm** |
| `kimi`、`moonshot`（月之暗面） | **km** |
| `xiaomi-plan`（小米 token plan） | **xmt** |
| `xiaomi`（小米 api） | **xm** |
| `minimax` | **mm** |
| `qwen`（通义） | **qw** |
| 未登记的其他提供方 | 首字母小写（兜底） |

实现：客户端 `DEFAULT_PROV_ABBR` 表 + `provAbbr(p)`；单元格显示缩写，`title` 悬停显示「缩写 · 全名」。
列宽 `26px → 38px`（3 字母码要放得下），去掉 `letter-spacing`。**全表估算 ≤ 宿主 440px 上限的内容宽 408px** ✅

**本机自定义（不进默认表）**：中转站等私有提供方，控制台执行一行即可覆盖/追加（localStorage 持久，刷新生效）：

```js
localStorage.setItem("dsh-model-stats:provAbbr", JSON.stringify({"my-relay":"mr","my-backup":"mb"}))
```
