#!/usr/bin/env node
// revoke.mjs —— 吊销一个设备令牌(配合 pair.mjs 完成时的提示)。
// 用法: GW=https://gw.example.com ADMIN_KEY=xxx node scripts/revoke.mjs <jti>
// 清单(找 jti):GW=... ADMIN_KEY=xxx node scripts/revoke.mjs --list
const gw = (process.env.GW ?? process.env.DSHGW_URL ?? "").replace(/\/+$/, "");
const adminKey = process.env.ADMIN_KEY ?? process.env.DSHGW_ADMIN_KEY;
const jti = process.argv[2];

if (!gw || !adminKey || !jti) {
  console.error("用法: GW=https://gw.example.com ADMIN_KEY=xxx node scripts/revoke.mjs <jti | --list>");
  process.exit(1);
}

const resp = await fetch(
  jti === "--list" ? `${gw}/admin/pair/tokens` : `${gw}/admin/pair/revoke-token`,
  jti === "--list"
    ? { headers: { authorization: `Bearer ${adminKey}` } }
    : {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
        body: JSON.stringify({ jti }),
      },
);
const body = await resp.json().catch(() => ({}));
if (!resp.ok) {
  console.error(`失败: ${resp.status} ${body.error ?? resp.statusText}`);
  process.exit(1);
}
if (jti === "--list") {
  for (const t of body) {
    console.log(
      `${t.revoked ? "☠ 已吊销  " : "✅ 生效中 "}${t.jti}  ${t.device || "未命名"} @ ${t.host_label || "?"}  ${new Date(t.created_at * 1000).toLocaleString()}`,
    );
  }
} else {
  console.log(body.revoked ? `已吊销 ${jti}` : `无变更(未知 jti 或已吊销): ${jti}`);
}
