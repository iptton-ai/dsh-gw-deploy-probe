// dsh-gateway-worker —— dsh 移动接入网关的 Cloudflare Workers 形态。
// 公开 API 与 Rust 版(dsh-mobile-gateway)逐字段同构,手机 App 零改动:
//   POST /pair/start|poll|confirm   配对三接口(双向亮码防抢注)
//   GET  /pair                      扫码落地页(静态,fragment 不出浏览器)
//   POST /auth/login                CF 形态恒 403(仅配对,无密码兜底)
//   GET  /healthz                   上游探测 + max_upload_bytes 能力上报
//   GET/POST /auth/devices|revoke   设备管理(Bearer)
//   /*    (Bearer)                  HTTP 流式透传 + WS 101 直通(events.mux 等)
// 管理面:Rust 版仅绑服务器 loopback(信任根=ssh);这里凭 ADMIN_KEY 经公网
// 调用同构端点(信任根=密钥),Mac 侧 scripts/pair.mjs 零依赖。
// 上游:cloudflared 隧道公网主机名(Host 改写由 cloudflared --http-host-header
// 完成,对应 Rust 版的 DSH_GATEWAY_UPSTREAM_HOST)。
import { Registry } from "./registry";
import type { PairingRow, ClaimRow } from "./registry";
import { signJwt, verifyJwt } from "./jwt";
import { renderTerminalQr } from "./qr";

export { Registry };

interface Env {
  REGISTRY: DurableObjectNamespace<Registry>;
  JWT_SECRET: string;
  ADMIN_KEY: string;
  TUNNEL_HOST: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  MAX_UPLOAD_BYTES?: string;
  TOKEN_TTL_DAYS?: string;
}

/** pending 配对存活期(手机亮码等人来输)。 */
const PAIRING_TTL_SECS = 600;
/** offer 存活期(亮码后一直没人确认就作废)。 */
const CLAIM_TTL_SECS = 300;
/** 手机亮码字符集(Crockford 风格,去易混字符;10 字符 ≈ 50bit)。 */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

// ── 通用小工具 ──────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
}

function err(status: number, message: string): Response {
  return json({ error: message }, status);
}

function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global"));
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-\s:]/g, "");
}

function validCodeD(code: string): boolean {
  return (
    code.length === 10 && [...code].every((c) => CODE_CHARS.includes(c))
  );
}

function validHostCode(code: string): boolean {
  const c = code.startsWith("-") ? code.slice(1) : code;
  return (c.length === 6 || c.length === 7) && [...c].every((ch) => CODE_CHARS.includes(ch));
}

function validSecret(s: string): boolean {
  return s.length >= 32 && s.length <= 128 && /^[a-zA-Z0-9]+$/.test(s);
}

function validHostname(host: string): boolean {
  return (
    /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) &&
    host.includes(".") &&
    !host.includes("..")
  );
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // Workers 的 crypto.subtle 扩展;长度已对齐。
  const enc = new TextEncoder();
  return (
    crypto as unknown as {
      subtle: { timingSafeEqual(x: ArrayBuffer, y: ArrayBuffer): boolean };
    }
  ).subtle.timingSafeEqual(enc.encode(a), enc.encode(b));
}

// ── 配对面(公开)──────────────────────────────────────────────────────

interface PairStartRequest {
  code: string;
  secret: string;
  device?: string;
}

async function pairStart(request: Request, env: Env): Promise<Response> {
  if (!env.JWT_SECRET) return err(500, "JWT_SECRET not configured");
  if (!(await registry(env).rateAllow("pair", clientIp(request), 20, 300))) {
    return err(409, "too many pairing attempts, retry later");
  }
  const body = await readJson<PairStartRequest>(request);
  if (!body) return err(400, "invalid JSON body");
  const code = normalizeCode(body.code ?? "");
  if (!validCodeD(code)) {
    return err(400, "code must be 10 chars (A-Z minus I,L,O + 2-9)");
  }
  if (!validSecret(body.secret ?? "")) {
    return err(400, "secret must be 32-128 alphanumerics");
  }
  const id = crypto.randomUUID();
  const inserted = await registry(env).pairingInsert(
    id,
    code,
    body.secret,
    body.device ?? "",
    PAIRING_TTL_SECS,
  );
  if (!inserted) return err(409, "code already in use; generate a new one");
  return json({ pairing_id: id, expires_at: nowSec() + PAIRING_TTL_SECS });
}

interface PairPollRequest {
  pairing_id: string;
  secret: string;
}

async function pairPoll(request: Request, env: Env): Promise<Response> {
  const body = await readJson<PairPollRequest>(request);
  if (!body) return err(400, "invalid JSON body");
  const p = await registry(env).pairingGet(body.pairing_id ?? "");
  if (!p) return err(404, "unknown pairing");
  if (p.secret !== body.secret) return err(401, "Unauthorized");
  if (p.status === "expired" || p.expires_at < nowSec()) {
    return json({ status: "expired", offers: [] });
  }
  if (p.status === "confirmed") return json({ status: "confirmed", offers: [] });
  const offers = (await registry(env).claimsFor(p.code_d)).map((c: ClaimRow) => ({
    claim_id: c.id,
    host_code: c.host_code,
    host_label: c.host_label,
    upstream_port: null,
    tunnel_host: c.tunnel_host,
    expires_at: c.expires_at,
  }));
  return json({ status: offers.length ? "offers" : "waiting", offers });
}

interface PairConfirmRequest {
  pairing_id: string;
  secret: string;
  claim_id: string;
  host_code: string;
}

async function pairConfirm(request: Request, env: Env): Promise<Response> {
  if (!env.JWT_SECRET) return err(500, "JWT_SECRET not configured");
  if (!(await registry(env).rateAllow("pair", clientIp(request), 20, 300))) {
    return err(409, "too many attempts, retry later");
  }
  const body = await readJson<PairConfirmRequest>(request);
  if (!body) return err(400, "invalid JSON body");
  const p: PairingRow | null = await registry(env).pairingGet(body.pairing_id ?? "");
  if (!p) return err(404, "unknown pairing");
  if (p.secret !== body.secret) return err(401, "Unauthorized");
  if (p.status !== "pending" || p.expires_at < nowSec()) {
    return err(400, "pairing no longer active");
  }
  const claim = await registry(env).claimGet(body.claim_id ?? "");
  if (!claim) return err(404, "unknown claim");
  if (claim.pairing_code !== p.code_d || claim.status !== "offered") {
    return err(400, "claim not applicable");
  }
  if (claim.expires_at < nowSec()) return err(400, "claim expired");
  const echo = normalizeCode(body.host_code ?? "");
  if (echo !== claim.host_code) return err(400, "host code mismatch");
  if (!(await registry(env).claimConsume(claim.id))) {
    return err(409, "claim already consumed");
  }
  const jti = crypto.randomUUID();
  await registry(env).pairingSetStatus(p.id, "confirmed");
  await registry(env).pairingSetToken(p.id, jti);
  const now = nowSec();
  const ttlDays = parseInt(env.TOKEN_TTL_DAYS || "30", 10) || 30;
  const exp = now + ttlDays * 86400;
  const token = await signJwt({ sub: "dsh-client", jti, device: p.device, iat: now, exp }, env.JWT_SECRET);
  await registry(env).tokenInsert(jti, p.device, claim.tunnel_host, claim.host_label);
  return json({ token, expires_at: exp, host_label: claim.host_label });
}

// ── 管理面(ADMIN_KEY;Rust 版为服务器 loopback + ssh)─────────────────

async function adminAuthed(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  const bearer = request.headers.get("Authorization")?.startsWith("Bearer ")
    ? request.headers.get("Authorization")!.slice(7)
    : request.headers.get("X-Admin-Key");
  return !!bearer && timingSafeEqual(bearer, env.ADMIN_KEY);
}

interface AdminClaimRequest {
  code: string;
  host_code: string;
  host_label?: string;
  tunnel_host?: string;
}

async function adminClaim(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_KEY) return err(500, "ADMIN_KEY not configured");
  if (!(await adminAuthed(request, env))) return err(401, "Unauthorized");
  const body = await readJson<AdminClaimRequest>(request);
  if (!body) return err(400, "invalid JSON body");
  const code = normalizeCode(body.code ?? "");
  if (!validCodeD(code)) return err(400, "code must be 10 chars");
  const hostCode = normalizeCode(body.host_code ?? "");
  if (!validHostCode(hostCode)) return err(400, "host_code must be 6-7 chars");
  const tunnelHost = (body.tunnel_host ?? "").trim() || (env.TUNNEL_HOST || "").trim();
  if (!tunnelHost) {
    return err(400, "no tunnel host configured (set TUNNEL_HOST var or pass tunnel_host)");
  }
  if (!validHostname(tunnelHost)) return err(400, "invalid tunnel_host");
  // 必须有手机在等这个码(不创建悬空 offer)。
  const pending = await registry(env).pairingByCode(code);
  if (!pending) return err(404, "no phone waiting with this code");
  const id = crypto.randomUUID();
  const hostLabel = (body.host_label || "mac").slice(0, 32);
  await registry(env).claimInsert(id, code, hostCode, hostLabel, tunnelHost, CLAIM_TTL_SECS);
  return json({
    claim_id: id,
    device: pending.device,
    host_code: hostCode,
    tunnel_host: tunnelHost,
    expires_at: nowSec() + CLAIM_TTL_SECS,
  });
}

async function adminStatus(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthed(request, env))) return err(401, "Unauthorized");
  const code = normalizeCode(new URL(request.url).searchParams.get("code") ?? "");
  if (!code) return err(400, "code required");
  const found = await registry(env).pairingStatusWithToken(code);
  if (!found) return err(404, "no pairing with this code");
  const { pairing, token } = found;
  return json({
    status: pairing.status,
    device: pairing.device,
    confirmed: pairing.status === "confirmed",
    token: token
      ? {
          jti: token.jti,
          device: token.device,
          host_label: token.host_label,
          upstream_port: token.upstream_port,
          tunnel_host: token.tunnel_host,
          revoked: token.revoked,
          created_at: token.created_at,
        }
      : null,
  });
}

async function adminRevokeToken(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthed(request, env))) return err(401, "Unauthorized");
  const body = await readJson<{ jti: string }>(request);
  if (!body) return err(400, "invalid JSON body");
  const revoked = await registry(env).revoke(body.jti ?? "");
  return json({ revoked });
}

async function adminTokens(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthed(request, env))) return err(401, "Unauthorized");
  return json(await registry(env).tokens());
}

async function adminQr(request: Request, env: Env): Promise<Response> {
  if (!(await adminAuthed(request, env))) return err(401, "Unauthorized");
  const body = await readJson<{ text: string }>(request);
  const text = (body?.text ?? "").trim();
  if (!text || text.length > 512) return err(400, "text must be 1-512 bytes");
  try {
    return json(renderTerminalQr(text));
  } catch {
    return err(400, "qr encode failed");
  }
}

// ── 鉴权(中转与设备管理共用)──────────────────────────────────────────

interface AuthedDevice {
  jti: string;
  device: string;
  tunnelHost: string | null;
}

async function authenticate(request: Request, env: Env): Promise<AuthedDevice | Response> {
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return err(401, "Unauthorized");
  const claims = await verifyJwt(token, env.JWT_SECRET || "");
  if (!claims) return err(401, "Unauthorized");
  const route = await registry(env).tokenRoute(claims.jti);
  if (!route.valid) return err(401, "Unauthorized");
  return { jti: claims.jti, device: claims.device, tunnelHost: route.tunnelHost };
}

// ── 中转(上游 = cloudflared 隧道主机名)───────────────────────────────

/** 转发时丢弃的头:hop-by-hop + 来源标记 + CF 注入的连接层头。 */
const REQUEST_DROP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "accept-encoding", "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
  "cdn-loop",
]);
const RESPONSE_DROP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
]);

function forwardableHeaders(source: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  for (const [name, value] of source.entries()) {
    if (drop.has(name.toLowerCase())) continue;
    if (name.toLowerCase().startsWith("cf-")) continue; // cf-connecting-ip 等
    out.set(name, value);
  }
  return out;
}

/** CF 控制台复制 service token 时给的是整行头(`CF-Access-Client-Secret: xxx`),
 *  用户容易连前缀一起粘贴 —— 这里容错剥掉,只留值。 */
export function accessHeaderValue(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^CF-Access-Client-(?:Id|Secret):\s*(.+)$/i);
  return m ? m[1].trim() : trimmed;
}

function upstreamHeaders(env: Env, base: Headers): Headers {
  const headers = new Headers(base);
  headers.delete("authorization"); // 网关令牌不下传给 dsh
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers.set("cf-access-client-id", accessHeaderValue(env.CF_ACCESS_CLIENT_ID));
    headers.set("cf-access-client-secret", accessHeaderValue(env.CF_ACCESS_CLIENT_SECRET));
  }
  return headers;
}

function maxUploadBytes(env: Env): number {
  return parseInt(env.MAX_UPLOAD_BYTES || "104857600", 10) || 104857600;
}

function isWebSocketUpgrade(request: Request): boolean {
  const conn = request.headers.get("connection")?.toLowerCase() ?? "";
  return conn.includes("upgrade") && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function relay(request: Request, env: Env, device: AuthedDevice): Promise<Response> {
  const upstreamHost = device.tunnelHost || (env.TUNNEL_HOST || "").trim();
  if (!upstreamHost) {
    return err(502, "no tunnel host configured for this token");
  }
  const url = new URL(request.url);
  const upstreamUrl = `https://${upstreamHost}${url.pathname}${url.search}`;

  if (isWebSocketUpgrade(request)) {
    // WS 直通:出站握手成功后把 socket 原样交还平台,逐帧不经过本 Worker。
    const handshake = new Headers({ upgrade: "websocket", connection: "Upgrade" });
    const protocol = request.headers.get("sec-websocket-protocol");
    if (protocol) handshake.set("sec-websocket-protocol", protocol);
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: Object.fromEntries(upstreamHeaders(env, handshake).entries()),
        redirect: "manual",
      });
      if (upstream.webSocket) {
        return new Response(null, { status: 101, webSocket: upstream.webSocket });
      }
      // 非 101(如 dsh 围栏 403):原样把状态带给下游。
      return withCors(
        new Response(upstream.body, {
          status: upstream.status,
          headers: forwardableHeaders(upstream.headers, RESPONSE_DROP_HEADERS),
        }),
      );
    } catch {
      return err(502, "upstream websocket connect failed");
    }
  }

  // 普通 HTTP 流式转发(请求/响应体都不落地)。
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > maxUploadBytes(env)) {
    return err(
      413,
      `request body ${declared}B exceeds gateway limit ${maxUploadBytes(env)}B (Cloudflare plan cap: Free/Pro 100MB, Business 200MB)`,
    );
  }
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: Object.fromEntries(upstreamHeaders(env, forwardableHeaders(request.headers, REQUEST_DROP_HEADERS)).entries()),
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
    return withCors(
      new Response(upstream.body, {
        status: upstream.status,
        headers: forwardableHeaders(upstream.headers, RESPONSE_DROP_HEADERS),
      }),
    );
  } catch {
    return err(502, "upstream request failed");
  }
}

// ── healthz(上游探测 + 能力上报)───────────────────────────────────────

async function healthz(_request: Request, env: Env): Promise<Response> {
  const host = (env.TUNNEL_HOST || "").trim();
  let upstreamOk = false;
  if (host) {
    try {
      const probe = await fetch(`https://${host}/`, {
        method: "HEAD",
        headers: Object.fromEntries(upstreamHeaders(env, new Headers()).entries()),
        redirect: "manual",
        signal: AbortSignal.timeout(2500),
      });
      // 隧道挂了 cloudflared 会回 530/52x;任何 <500(含 404)都说明链路通。
      upstreamOk = probe.status < 500;
    } catch {
      upstreamOk = false;
    }
  }
  return json({ ok: true, upstream: upstreamOk, max_upload_bytes: maxUploadBytes(env) });
}

// ── 扫码落地页(与 Rust 版逐字节一致)──────────────────────────────────

function pairPage(): Response {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 配对</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;max-width:480px;margin:0 auto;padding:24px 16px;text-align:center}
 .code{font-size:38px;font-weight:700;letter-spacing:4px;margin:8px 0;font-family:ui-monospace,monospace}
 .host{font-size:26px;letter-spacing:3px;color:#7fd38a;font-family:ui-monospace,monospace}
 .card{background:#1d1d1f;border-radius:14px;padding:18px;margin:14px 0}
 button{width:100%;padding:14px;font-size:16px;border:none;border-radius:12px;background:#2f6fed;color:#fff}
 .hint{color:#999;font-size:13px;line-height:1.7}
</style></head><body>
<div id="app" class="card">正在读取邀请信息…</div>
<div class="hint">此页由网关静态提供,邀请信息只在本机浏览器解析,不上传服务器。</div>
<script>
const q=new URLSearchParams(location.hash.startsWith('#')?location.hash.slice(1):location.hash);
const norm=s=>(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
const c=norm(q.get('c')),h=norm(q.get('h'));
const l=(q.get('l')||'').replace(/[^A-Za-z0-9 _.\\-]/g,'').slice(0,32);
const app=document.getElementById('app');
if(c.length!==10){app.innerHTML='邀请链接无效或已损坏。<br>请回 Mac 终端重新运行 pair.mjs 后再扫。';}
else{
 const fmt=c.slice(0,5)+'-'+c.slice(5);
 const hh=h.length>=6?h.slice(0,3)+'-'+h.slice(3,6):'';
 app.innerHTML='<div class="hint">配对码</div><div class="code">'+fmt+'</div>'+
  (hh?'<div class="hint">锚定主机码</div><div class="host">'+hh+'</div>':'')+
  (l?'<div class="hint">'+l+'</div>':'')+
  '</div><button id="cp">复制配对信息,回到 singleman 粘贴</button>'+
  '<div class="hint" style="margin-top:14px">打开 singleman App → 配对页 → 点地址栏右侧粘贴按钮</div>';
 document.getElementById('cp').onclick=()=>navigator.clipboard.writeText(location.href)
  .then(()=>{document.getElementById('cp').textContent='✅ 已复制,请回到 singleman 粘贴';});
}
</script></body></html>`;
  return withCors(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
  );
}

// ── 路由 ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    const url = new URL(request.url);
    const path = url.pathname;

    // 完全公开:配对三接口 + 扫码落地页 + 健康探测。
    if (request.method === "POST" && path === "/pair/start") return pairStart(request, env);
    if (request.method === "POST" && path === "/pair/poll") return pairPoll(request, env);
    if (request.method === "POST" && path === "/pair/confirm") return pairConfirm(request, env);
    if (request.method === "GET" && path === "/pair") return pairPage();
    if (request.method === "GET" && path === "/healthz") return healthz(request, env);
    if (request.method === "POST" && path === "/auth/login") {
      // 密码登录已从两版移除(仅配对);保留端点只为给老客户端一个明确的 403 指路。
      return err(403, "password login disabled; use pairing");
    }

    // 管理面:凭 ADMIN_KEY(等价于 Rust 版「有服务器 ssh 权限」的信任根)。
    if (path.startsWith("/admin/pair/")) {
      if (request.method === "POST" && path === "/admin/pair/claim") return adminClaim(request, env);
      if (request.method === "GET" && path === "/admin/pair/status") return adminStatus(request, env);
      if (request.method === "POST" && path === "/admin/pair/revoke-token") return adminRevokeToken(request, env);
      if (request.method === "GET" && path === "/admin/pair/tokens") return adminTokens(request, env);
      if (request.method === "POST" && path === "/admin/pair/qr") return adminQr(request, env);
      return err(404, "Not Found: /admin/pair/*");
    }

    // 鉴权面:设备管理 + 全量中转。
    const authed = await authenticate(request, env);
    if (authed instanceof Response) return authed;
    if (request.method === "GET" && path === "/auth/devices") {
      return json(await registry(env).tokens());
    }
    if (request.method === "POST" && path === "/auth/revoke") {
      const body = await readJson<{ jti: string }>(request);
      if (!body) return err(400, "invalid JSON body");
      await registry(env).revoke(body.jti ?? "");
      return json({ revoked: true });
    }
    return relay(request, env, authed);
  },
};
