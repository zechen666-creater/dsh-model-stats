/**
 * dsh-model-stats 宿主半
 *
 * 职责只有一条：注册 GET /plugins/dsh-model-stats/stats?sessionId=...
 * 读该会话的 session.v4.jsonl.zstd，按 assistant/message 折叠出
 * 每模型的 输入/缓存读/输出/总 token、缓存命中率、输出速率(tok/s)。
 *
 * 数据源事实（已实测）：
 *  - usage 恒为 { inputTokens, outputTokens, totalTokens, cacheReadTokens }
 *    且 totalTokens === input + cacheRead + output（本机样例 6671+10240+180=17091）
 *  - 模型在 data.message.source.model，本机 232/232 全覆盖
 *  - 输出速率：data.stream 各帧的最早时间 → 事件 time（完成），与
 *    客户端 deriveStats 的 decodeMs = completedTime - firstTokenTime 同口径
 *
 * 纯读：不改会话、不调用模型、不写盘。
 */
import zlib from "node:zlib";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const name = "dsh-model-stats";
export const inject = ["webServer"];

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 定位某 sessionId 的会话文件：两种命名都试。 */
function locateSessionFile(sessionId) {
  if (!process.env.DSH_HOME) return null;
  const root = join(process.env.DSH_HOME, "sessions");
  if (!existsSync(root)) return null;
  const candidates = [sessionId, "session-" + sessionId];
  for (const cwd of readdirSync(root)) {
    let stat; try { stat = statSync(join(root, cwd)); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const c of candidates) {
      const f = join(root, cwd, c, "session.v4.jsonl.zstd");
      if (existsSync(f)) return f;
    }
    // 第三层：会话目录里再嵌一层
    try {
      for (const sub of readdirSync(join(root, cwd))) {
        for (const c of candidates) {
          const f = join(root, cwd, sub, c, "session.v4.jsonl.zstd");
          if (existsSync(f)) return f;
        }
      }
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 解开全部 zstd 帧并返回事件数组。 */
function parseEvents(buf) {
  const out = [];
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 4); }
  const push = (text) => {
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  };
  if (!starts.length) { try { push(zlib.zstdDecompressSync(buf).toString("utf8")); } catch {} return out; }
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8")); } catch {}
  }
  return out;
}

/**
 * 把事件折叠成每模型统计。
 * hitRate = cacheRead / (cacheRead + input)，与客户端
 * formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens) 同口径。
 */
export function foldModelUsage(events) {
  const map = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== "assistant/message") continue;
    const d = ev.data || {};
    const usage = d.usage;
    if (!usage) continue;
    const model = (d.message && d.message.source && d.message.source.model)
      || (d.route && d.route.model) || "未知模型";
    /* 提供方在 message.source.provider（本机实测 xiaomi-plan / deepseek-account）；
       同一 model 若来自不同提供方应各成一行 → 以 provider+model 为键。 */
    const provider = (d.message && d.message.source && d.message.source.provider)
      || (d.route && d.route.provider) || "";
    const key = provider + "\u0000" + model;
    let acc = map.get(key);
    if (!acc) { acc = { provider, model, steps: 0, input: 0, cacheRead: 0, output: 0, total: 0, decodeMs: 0 }; map.set(key, acc); }
    acc.steps += 1;
    acc.input += usage.inputTokens || 0;
    acc.cacheRead += usage.cacheReadTokens || 0;
    acc.output += usage.outputTokens || 0;
    acc.total += usage.totalTokens || 0;
    // 解码耗时：stream 里最早的一帧 → 事件完成时刻
    let first = null;
    const frames = d.stream;
    if (Array.isArray(frames)) {
      for (const f of frames) {
        const t = typeof f.time0 === "number" ? f.time0 : (typeof f.time === "number" ? f.time : null);
        if (t != null && (first === null || t < first)) first = t;
      }
    }
    const done = typeof ev.time === "number" ? ev.time : null;
    if (first !== null && done !== null && done > first) acc.decodeMs += done - first;
  }
  const rows = [...map.values()].map((a) => {
    const promptSide = a.cacheRead + a.input;
    return {
      provider: a.provider,     // 空串 = 日志未记，客户端显示为 —
      model: a.model,
      steps: a.steps,
      input: a.input,
      cacheRead: a.cacheRead,
      output: a.output,
      total: a.total,
      hitRate: promptSide > 0 ? Math.round((a.cacheRead / promptSide) * 1000) / 10 : null,
      tps: a.decodeMs > 0 ? Math.round((a.output / (a.decodeMs / 1000)) * 10) / 10 : null,
      decodeMs: a.decodeMs,
    };
  });
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

/** 文件缓存：按 (mtime,size) 复用折叠结果，避免每次轮询都解压。 */
const cache = new Map();

export function statsFor(sessionId) {
  const file = locateSessionFile(sessionId);
  if (!file) return { sessionId, file: null, models: [], updatedAt: Date.now() };
  let st; try { st = statSync(file); } catch { return { sessionId, file, models: [], updatedAt: Date.now() }; }
  const key = file;
  const hit = cache.get(key);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.payload;
  const models = foldModelUsage(parseEvents(readFileSync(file)));
  const payload = { sessionId, file: file.replace(/\\/g, "/"), mtime: st.mtimeMs, size: st.size, models, updatedAt: Date.now() };
  cache.set(key, { mtime: st.mtimeMs, size: st.size, payload });
  return payload;
}

/** 回环守卫：与 workbuddy bridge 同口径（防 DNS 重绑定）。 */
function loopbackRequest(req) {
  const host = String(req.headers.host || "");
  const origin = req.headers.origin;
  const isLb = (h) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
  if (!isLb(host)) return false;
  if (origin === undefined) return true;       // 同源 fetch 无 Origin
  try { return isLb(new URL(origin).host); } catch { return false; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: "/plugins/dsh-model-stats/stats",
      handler(req, res) {
        if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return; }
        if (!loopbackRequest(req)) { json(res, 403, { error: "request-not-trusted" }); return; }
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) { json(res, 400, { error: "missing sessionId" }); return; }
          json(res, 200, statsFor(sessionId));
        } catch (error) {
          json(res, 500, { error: String(error && error.message || error) });
        }
      },
    });
    return () => dispose();
  }, "dsh-model-stats: stats route");
}

export default { name, inject, apply };
