#!/usr/bin/env node
// pair.mjs —— dsh-gateway-worker(Cloudflare 形态)的 Mac 侧配对工具,零依赖(Node 18+)。
// 与 Rust 版 server/remote/pair.sh 同一交互模型:手机亮 10 位码 → 本工具应约亮 6 位
// 主机码 → 手机端人工比对点选 → 30 天设备令牌(绑定本机隧道主机名)。
//
// 用法:
//   GW=https://gw.example.com ADMIN_KEY=<部署时填的管理密钥> \
//     node scripts/pair.mjs ABCDEFGHJK [--host mac.example.com] [--label mac-mini]
//
// 也可用环境变量 DSHGW_URL / DSHGW_ADMIN_KEY;--host 覆盖默认 TUNNEL_HOST(多机时)。
import { randomInt } from "node:crypto";

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIR_TTL_SECS = 600;

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[name] ?? fallback;
}

const gw = (arg("GW") || arg("DSHGW_URL") || "").replace(/\/+$/, "");
const adminKey = arg("ADMIN_KEY") || arg("DSHGW_ADMIN_KEY");
const tunnelHost = arg("host");
const label = arg("label", "");

const rawCode = process.argv[2] ?? "";
const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");

if (!gw || !adminKey || !/^[A-Z0-9]{10}$/.test(code)) {
  console.error(
    "用法: GW=https://gw.example.com ADMIN_KEY=xxx node scripts/pair.mjs <10位配对码> [--host 隧道主机名] [--label 机器名]\n" +
      "配对码在手机 singleman App「配对连接」页生成(10 位大写)。",
  );
  process.exit(1);
}
if (code !== rawCode) {
  console.error(`配对码已归一化为 ${code};手机端输入的也是这个码。`);
}

const api = async (path, init = {}) => {
  const resp = await fetch(`${gw}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${resp.status} ${body.error ?? resp.statusText}`);
  return body;
};

// 1. 生成 6 位主机码(本机生成,服务器不产生 —— 手机端人工比对的凭证)。
const hostCode = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

// 2. 应约(claim)。
const claim = await api("/admin/pair/claim", {
  method: "POST",
  body: JSON.stringify({
    code,
    host_code: hostCode,
    host_label: label || undefined,
    tunnel_host: tunnelHost || undefined,
  }),
}).catch((e) => {
  console.error(`应约失败: ${e.message}`);
  process.exit(1);
});

// 3. 大字亮主机码 + 邀请二维码(手机相机直扫进落地页)。
const fmt = `${hostCode.slice(0, 3)}-${hostCode.slice(3)}`;
console.log(`\n  ┌─────────────────────────────┐`);
console.log(`  │  主机码:${fmt}            │`);
console.log(`  │  请在手机上核对一致后再确认  │`);
console.log(`  └─────────────────────────────┘\n`);
console.log(`等待手机确认(配对码 ${code.slice(0, 5)}-${code.slice(5)},设备「${claim.device || "未知"}」)…\n`);

try {
  const invite = `${gw}/pair#c=${code}&h=${hostCode}${label ? `&l=${label}` : ""}`;
  const { qr } = await api("/admin/pair/qr", { method: "POST", body: JSON.stringify({ text: invite }) });
  console.log(qr);
  console.log(`(不能扫码时,把配对码 ${code.slice(0, 5)}-${code.slice(5)} 抄给手机手动输入)\n`);
} catch {
  console.log("(二维码渲染失败,不影响配对;手机端可手输配对码)\n");
}

// 4. 轮询直到手机确认(最多等满配对存活期)。
const deadline = Date.now() + PAIR_TTL_SECS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  let s;
  try {
    s = await api(`/admin/pair/status?code=${code}`);
  } catch {
    continue;
  }
  if (s.status === "confirmed" && s.token) {
    console.log(`✅ 配对完成:设备「${s.token.device || "未命名"}」已获得 30 天令牌。`);
    console.log(`   如设备不对劲,立即吊销:`);
    console.log(`   GW=${gw} ADMIN_KEY=*** node scripts/revoke.mjs ${s.token.jti}`);
    process.exit(0);
  }
}
console.error("超时:手机一直未确认(配对码已过期)。请手机端换码重试。");
process.exit(1);
