/**
 * dsh-model-stats 客户端半（浏览器）0.4.0
 *
 * 往 conversation.composer.dock（kind:list, scope:session）注入一个面板：
 * 按模型列出 输出速率(tok/s) / 缓存命中率 / 总 token。
 *
 * 风格与行为完全对齐宿主（照抄 ui-chat/StatsPills + stat-dialog + TurnUsagePanel）：
 *   · 药丸：StatsPills.module.css 的 .pill —— 无背景无边框，hover/展开才上底色
 *   · 弹层：stat-dialog.module.css —— --dsw-specific-menu + radius-lg
 *     + elevation-prominent + elevation-stroke-color，position:fixed，max 440px
 *   · 锚定：ui-primitives 的 useAnchoredPosition（top/gap 8/margin 12，
 *     滚动·缩放·面板尺寸变化都会重算，并夹在视口内）
 *   · 关闭：useDismissOnOutsidePointer 同款语义 —— **点面板/药丸以外任意处关闭**，
 *     外加 Escape 关闭（宿主 useStatDialog 就是这两条）
 *   · 未测量首帧用 MEASURE_STYLE {visibility:hidden, left:0, top:0} 占位
 *   · 没有 ⏸、没有触发器小箭头、没有弹层页脚（按用户逐条反馈）
 *     —— 关闭同宿主弹层：点面板/药丸以外任意处、或按 ESC、或再点药丸；
 *   · 颜色全走 --dsw-alias-* 主题变量，浅色/深色自动适配
 *
 * 防崩（2026-10-15 事故的教训）：
 *   · exports 三件套 apply / inject=["slots"] / name —— 缺 inject = fiber 不等依赖就绪 = 前端崩
 *   · 图标库与定位 hook 都在模块级 try 探测，缺失就退化，绝不让激活失败
 *   · apply 全程 try/catch
 */
window.__ModuleLoader__.load({
	id: "dsh-model-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		var H = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		/* react-dom / 图标库 / 锚定 hook：能拿就用，拿不到退化，不炸激活 */
		var reactDom = null;
		try { reactDom = require("react-dom"); } catch (e) { reactDom = null; }
		var primitives = null;
		try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { primitives = null; }

		function icon(name, fallback) {
			var C = primitives && primitives[name];
			return C ? H(C, {}) : H("span", { "aria-hidden": "true" }, fallback);
		}

		/* 模块级判定（只判一次）：保证 hook 每次渲染调用顺序一致 ——
		   条件式调用真实 hook 会打乱顺序，所以取引用后无条件调用。 */
		var HAS_ANCHOR = !!(primitives && typeof primitives.useAnchoredPosition === "function");
		var useAnchor = HAS_ANCHOR ? primitives.useAnchoredPosition : function () { return null; };

		var PANEL_GAP = 8;      // 同宿主 stat-dialog
		var PANEL_MARGIN = 12;
		var MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };   // 同宿主

		var ROUTE = "/plugins/dsh-model-stats/stats";
		var POLL_MS = 5000;
		var LS_KEY = "dsh-model-stats:enabled";
		var EVT_KEY = "dsh-model-stats:enabled";
		var NS = "dsh-model-stats";
		var CSS_ID = NS + "/stats.css";

		/* ── 样式：照抄宿主 StatsPills（药丸）+ stat-dialog（弹层）────────── */
		var CSS = [
			/* 包裹层：定位锚点放这，玻璃胶囊的 overflow:hidden 就裁不到弹层 */
			".dshms_wrap{position:relative;min-width:0;display:flex;align-items:center;}",
			/* 根：同 .iq1doa_root —— **只声明度量**；
			   padding/圆角/背景/halo 交给 dsh-composer-glass 的 [data-composer-stats] 规则
			   （状态胶囊组），这样它开/关、调参都跟着宿主走。gap 用 8 与玻璃规则一致。 */
			".dshms_root{box-sizing:border-box;min-width:0;max-width:100%;",
			" display:flex;align-items:center;justify-content:center;gap:8px;",
			" font:var(--dsw-font-xxs-12);",
			" line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}",
			/* 刻意不写 background/padding/border-radius：
			   它们归 [data-composer-stats]（composer-glass 状态胶囊组），
			   我的样式表加载更晚、同优先级会盖掉玻璃 —— 宿主没装玻璃时也是裸字，
			   同进同出才叫风格一致。 */
			/* 药丸：同 .iq1doa_pill（无背景无边框，hover/展开上底色，tabular-nums） */
			".dshms_pill{box-sizing:border-box;max-width:100%;display:inline-flex;align-items:center;gap:6px;",
			" padding:1px 8px;font:inherit;white-space:nowrap;border:none;background:none;",
			" border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-tertiary);",
			" font-variant-numeric:tabular-nums;line-height:inherit;}",
			".dshms_pill svg{flex:none;width:14px;height:14px;}",
			".dshms_pill:hover,.dshms_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);",
			" color:var(--dsw-alias-label-secondary);}",
			".dshms_label{min-width:0;overflow:hidden;text-overflow:ellipsis;}",
			/* 弹层：同 .Xt1eiG_panel（含宿主漏掉的 stroke-color 变量），门户到 body 时 fixed */
			".dshms_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);",
			" background:var(--dsw-specific-menu);width:max-content;",
			" min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);",
			" backdrop-filter:var(--dsw-menu-backdrop-filter);",
			" --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);",
			" box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);",
			" cursor:default;border:0;padding:16px;font:var(--dsw-font-xxs-12);position:fixed;}",
			/* 退化路径：没锚定 hook 时挂回药丸上方（不门户） */
			".dshms_panelLocal{position:absolute;left:0;bottom:calc(100% + 8px);}",
			".dshms_title{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;",
			" font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary);}",
			".dshms_title svg{flex:none;width:14px;height:14px;}",
			".dshms_titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0;}",
			".dshms_titleValue{font-variant-numeric:tabular-nums;}",
			".dshms_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px;}",
			".dshms_table{width:100%;border-collapse:collapse;}",
			".dshms_th{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-strong-12);text-align:right;",
			" padding:2px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;}",
			".dshms_th.dshms_left,.dshms_td.dshms_left{text-align:left;}",
			".dshms_td{padding:5px 4px;text-align:right;white-space:nowrap;",
			" border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;}",
			".dshms_td.dshms_name{max-width:150px;overflow:hidden;text-overflow:ellipsis;}",
			/* 提供方列：只放一个首字母，窄而稳；全名靠 title 悬停 */
			".dshms_td.dshms_prov{max-width:38px;overflow:hidden;text-overflow:ellipsis;",
			" color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:center;}",
			".dshms_tr:last-child .dshms_td{border-bottom:none;}",
			".dshms_err{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);}",
			".dshms_empty{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);}",
		].join("");

		function ensureCss() {
			try {
				if (typeof document === "undefined") return;
				if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return;
				var tag = document.createElement("style");
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = CSS_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			} catch (e) { /* 样式挂不上不影响功能 */ }
		}

		/* ── 提供方缩写默认表：只收常见官方套餐 / coding plan ──────
		   未登记的兜底＝首字母小写（悬停可看全名）。
		   个人中转站 / 私有 provider 不进默认表；想给自己加（只影响本机）：
		   localStorage.setItem("dsh-model-stats:provAbbr", JSON.stringify({"my-relay":"mr"})) 后刷新。 */
		var DEFAULT_PROV_ABBR = {
			"deepseek": "ds",
			"deepseek-account": "ds",
			"deepseek-official": "ds",
			"zai": "z",
			"glm-coding": "glm",
			"kimi": "km",
			"moonshot": "km",
			"xiaomi": "xm",
			"xiaomi-plan": "xmt",
			"minimax": "mm",
			"qwen": "qw"
		};
		var PROV_ABBR = DEFAULT_PROV_ABBR;
		try {
			var extraAbbr = JSON.parse(localStorage.getItem("dsh-model-stats:provAbbr") || "null");
			if (extraAbbr && typeof extraAbbr === "object") PROV_ABBR = Object.assign({}, DEFAULT_PROV_ABBR, extraAbbr);
		} catch (e) { /* 本地配置坏了就退回默认表 */ }
		function provAbbr(p) {
			if (!p) return "—";
			var k = String(p).toLowerCase();
			return PROV_ABBR[k] || k.slice(0, 1);
		}

		/* ── 数值格式 ─────────────────────────────────────── */
		function fmtTokens(n) {
			if (n == null) return "—";
			if (n >= 1e6) return (Math.round(n / 1e5) / 10) + "M";
			if (n >= 1e4) return (Math.round(n / 1e2) / 10) + "K";
			return String(n);
		}
		function fmtHit(v) { return v == null ? "—" : v.toFixed(1) + "%"; }
		function fmtTps(v) { return v == null ? "—" : Math.round(v) + " tok/s"; }

		/* ── 开关：localStorage 持久 + 广播事件 ──────────────────── */
		function readEnabled() {
			try { return window.localStorage.getItem(LS_KEY) !== "0"; } catch (e) { return true; }
		}
		function writeEnabled(v) {
			try { window.localStorage.setItem(LS_KEY, v ? "1" : "0"); } catch (e) {}
		}
		function emitEnabled() {
			try { window.dispatchEvent(new Event(EVT_KEY)); } catch (e) {}
		}

		/* ── 面板 ──────────────────────────────────────────── */
		function ModelStatsPanel(props) {
			var sessionId = props && props.sessionId;
			var openState = useState(false);
			var isOpen = openState[0], setOpen = openState[1];
			var data = useState(null);
			var rows = data[0], setRows = data[1];
			var err = useState(null);
			var errMsg = err[0], setErrMsg = err[1];
			var en = useState(readEnabled);
			var enabled = en[0], setEnabled = en[1];
			var rootRef = useRef(null);
			var panelRef = useRef(null);

			/* 锚定：同宿主 useStatDialog —— top 面板、gap 8、margin 12，
			   滚动/缩放/面板尺寸变化时重算并夹在视口内。 */
			var pos = useAnchor({
				open: isOpen && enabled,
				anchorRef: rootRef,
				panelRef: panelRef,
				side: "top",
				gap: PANEL_GAP,
				margin: PANEL_MARGIN,
			});

			useEffect(function () { ensureCss(); }, []);

			/* 开关广播 */
			useEffect(function () {
				function onChange() { setEnabled(readEnabled()); }
				try { window.addEventListener(EVT_KEY, onChange); } catch (e) {}
				return function () { try { window.removeEventListener(EVT_KEY, onChange); } catch (e) {} };
			}, []);

			/* 点外部关闭（同宿主 useDismissOnOutsidePointer）+ Escape 关闭 */
			useEffect(function () {
				if (!isOpen) return undefined;
				function onPointerDown(event) {
					try {
						if (!(event.target instanceof Node)) return;
						if (rootRef.current && rootRef.current.contains(event.target)) return;
						if (panelRef.current && panelRef.current.contains(event.target)) return;
						setOpen(false);
					} catch (e) { setOpen(false); }
				}
				function onKeyDown(event) { if (event.key === "Escape") setOpen(false); }
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [isOpen]);

			/* 轮询 */
			useEffect(function () {
				if (!sessionId || !enabled) return undefined;
				var alive = true;
				function load() {
					fetch(ROUTE + "?sessionId=" + encodeURIComponent(sessionId), { credentials: "same-origin" })
						.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
						.then(function (j) { if (!alive) return; setRows((j && j.models) || []); setErrMsg(null); })
						.catch(function (e) { if (!alive) return; setErrMsg(String((e && e.message) || e)); });
				}
				load();
				var id = setInterval(load, POLL_MS);
				return function () { alive = false; clearInterval(id); };
			}, [sessionId, enabled]);

			var totals = useMemo(function () {
				if (!rows || !rows.length) return null;
				var out = 0, side = 0, cr = 0;
				for (var i = 0; i < rows.length; i++) {
					out += rows[i].output; cr += rows[i].cacheRead; side += rows[i].cacheRead + rows[i].input;
				}
				return { out: out, cr: cr, hit: side > 0 ? (cr / side) * 100 : null };
			}, [rows]);

			if (!sessionId) return null;

			/* 关闭态：只留一个能点回来的药丸（⏸ 已按要求去掉） */
			if (!enabled) {
				return H("div", { className: "dshms_wrap" },
					H("div", { className: "dshms_root", ref: rootRef, "data-dsh-model-stats": "off",
						"data-composer-stats": true },
						H("button", {
							type: "button", className: "dshms_pill",
							title: "按模型统计已关闭 · 点击重新启用（即时，无需重启）",
							onClick: function () { writeEnabled(true); emitEnabled(); },
						}, icon("IconPlayOutlineRegular", "▶"),
							H("span", { className: "dshms_label" }, "按模型统计 · 已关")))
				);
			}

			var label = rows && rows.length
				? (rows.length + " 个模型 · " + (totals ? fmtTokens(totals.out) + " 输出" : ""))
				: (errMsg ? "按模型统计（读取失败）" : "按模型统计…");

			var trigger = H("button", {
				type: "button", className: "dshms_pill",
				"aria-expanded": isOpen ? "true" : "false",
				"aria-haspopup": "dialog",
				title: "本会话按模型统计：输出速率 / 缓存命中率 / 总 token（每 " + (POLL_MS / 1000) + " 秒刷新）",
				onClick: function () { setOpen(!isOpen); },
			}, icon("IconGaugeOutlineRegular", ""),
				H("span", { className: "dshms_label" }, label));   // 小箭头按反馈去掉：展开/收起已有 aria-expanded + 面板自身可见性表达，箭头是冗余的

			var panel = null;
			if (isOpen) {
				var body = [];
				if (errMsg) {
					body.push(H("div", { key: "e", className: "dshms_err" }, "读取失败：" + errMsg));
				} else if (!rows || !rows.length) {
					body.push(H("div", { key: "n", className: "dshms_empty" }, "暂无用量数据…"));
				} else {
					var head = H("thead", { key: "h" }, H("tr", {},
						H("th", { className: "dshms_th dshms_left" }, "提供方"),
						H("th", { className: "dshms_th dshms_left" }, "模型"),
						H("th", { className: "dshms_th" }, "总 token"),
						H("th", { className: "dshms_th" }, "输出"),
						H("th", { className: "dshms_th" }, "命中率"),
						H("th", { className: "dshms_th" }, "输出速率")
					));
					var bodyRows = [];
					for (var k = 0; k < rows.length; k++) {
						var r = rows[k];
						/* 明细放 title：省两列宽度，让弹层守住宿主 440px */
						var tip = (r.provider ? r.provider + " / " : "") + r.model + "\n"
							+ "缓存读 " + fmtTokens(r.cacheRead) + " · 未缓存输入 " + fmtTokens(r.input)
							+ " · 输出 " + fmtTokens(r.output) + " · 总 " + fmtTokens(r.total)
							+ " · 命中率 " + fmtHit(r.hitRate) + " · 速率 " + fmtTps(r.tps);
						bodyRows.push(H("tr", { key: (r.provider || "") + "/" + r.model, className: "dshms_tr" },
							/* 提供方只放首字母（位置不够就取第一个字母），全名进 title 悬停可见 */
							H("td", { className: "dshms_td dshms_left dshms_prov",
								title: r.provider ? provAbbr(r.provider) + " · " + r.provider : "（日志未记录提供方）" },
								provAbbr(r.provider)),
							H("td", { className: "dshms_td dshms_left dshms_name", title: tip }, r.model),
							H("td", { className: "dshms_td" }, fmtTokens(r.total)),
							H("td", { className: "dshms_td" }, fmtTokens(r.output)),
							H("td", { className: "dshms_td" }, fmtHit(r.hitRate)),
							H("td", { className: "dshms_td" }, fmtTps(r.tps))
						));
					}
					body.push(H("table", { key: "t", className: "dshms_table" }, head, H("tbody", {}, bodyRows)));
				}
				/* 页脚整行已按反馈删除（0.5.2）：「缓存读 · 命中」与表内列重复，
				   「关闭面板」与点外部 / ESC / 再点药丸重复 —— 宿主 stat-dialog 本身也没有页脚。
				   要彻底停用插件：侧栏 → 插件 → dsh-model-stats，或控制台 dshModelStats.off()。 */

				panel = H("div", {
					key: "panel", ref: panelRef,
					className: "dshms_panel" + (HAS_ANCHOR ? "" : " dshms_panelLocal"),
					role: "dialog", "aria-label": "本会话按模型统计",
					style: HAS_ANCHOR ? (pos || MEASURE_STYLE) : undefined,
				},
					H("div", { className: "dshms_title" },
						H("span", { className: "dshms_titleLabel" },
							icon("IconDatabaseOutlineRegular", ""), "本会话 · 按模型统计"),
						H("span", { className: "dshms_titleValue" },
							totals ? fmtTokens(totals.out) + " tok" : "—")),
					H("div", { className: "dshms_rule", "aria-hidden": "true" }),
					body);
			}

			/* 根挂 data-composer-stats：dsh-composer-glass 的「状态胶囊」组就认这个
			   稳定属性（宿主 StatsPills 也带它），玻璃胶囊/光晕自动套上来。 */
			var wrapKids = [
				H("div", {
					key: "root", className: "dshms_root", ref: rootRef,
					"data-dsh-model-stats": "1", "data-composer-stats": true,
				}, trigger),
			];
			if (panel) {
				/* 门户到 body：摆脱容器裁剪，视口夹取才有效；
				   没门户时它是 wrap 的兄弟节点，也不在玻璃胶囊内 → 不会被 overflow:hidden 裁掉。 */
				if (reactDom && reactDom.createPortal && typeof document !== "undefined") {
					wrapKids.push(reactDom.createPortal(panel, document.body));
				} else {
					wrapKids.push(panel);
				}
			}
			return H("div", { className: "dshms_wrap" }, wrapKids);
		}

		function apply(ctx) {
			try {
				ensureCss();
				ctx.slots.inject("conversation.composer.dock", function () {
					return ctx.slots.register({
						name: "conversation.composer.dock",
						id: "model-stats",
						order: 10,                      // 排在宿主统计条(id:stats,order:0)之后
						inject: function (sessionId) { return { sessionId: sessionId }; },
					}, ModelStatsPanel);
				});
			} catch (error) {
				// 面板挂不上也不能拖垮整个前端。2026-10-15 崩溃的教训。
				if (typeof console !== "undefined") console.warn("[dsh-model-stats] 面板注册失败：", error);
			}
		}

		/* DevTools：dshModelStats.on() / .off() 即时切换，不用重启。 */
		if (typeof window !== "undefined") {
			try {
				window.dshModelStats = {
					off: function () { writeEnabled(false); emitEnabled(); },
					on: function () { writeEnabled(true); emitEnabled(); },
					isEnabled: readEnabled,
					hasAnchor: HAS_ANCHOR,
					pollMs: POLL_MS,
					version: "0.4.0",
				};
			} catch (e) { /* 冻结窗口之类：忽略 */ }
		}

		exports.apply = apply;
		/* 关键：声明依赖的服务，fiber 会等到 slots 就绪再激活。
		   缺 inject 就会在 slots 未就绪时跑 apply → ctx.slots 未定义 → 激活失败（2026-10-15 崩溃根因）。 */
		exports.inject = ["slots"];
		exports.name = "dsh-model-stats";
		exports.ModelStatsPanel = ModelStatsPanel;
		return module.exports;
	},
});
