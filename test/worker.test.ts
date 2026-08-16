// 集成测试(@cloudflare/vitest-pool-workers):通过 SELF 以真实 HTTP 打到 Worker,
// DO(SQLite)在隔离存储里跑完整状态机。协议断言与 Rust 版 17 项集成测试同源。
/// <reference types="@cloudflare/vitest-pool-workers" />
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Registry } from "../src/registry";
import { accessHeaderValue } from "../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    REGISTRY: DurableObjectNamespace<Registry>;
    JWT_SECRET: string;
    ADMIN_KEY: string;
    TUNNEL_HOST: string;
  }
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SECRET = "a".repeat(40);

function genCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function genHostCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function baseHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function startPairing(code = genCode(), device = "test-phone") {
  const resp = await SELF.fetch("https://example.com/pair/start", {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ code, secret: SECRET, device }),
  });
  return { resp, body: await resp.json() as { pairing_id: string; expires_at: number } };
}

async function adminClaim(code: string, hostCode = genHostCode(), key = "test-admin-key-0123456789abcdef") {
  const resp = await SELF.fetch("https://example.com/admin/pair/claim", {
    method: "POST",
    headers: { ...baseHeaders(), authorization: `Bearer ${key}` },
    body: JSON.stringify({ code, host_code: hostCode, host_label: "mac-mini", tunnel_host: "mac1.example.com" }),
  });
  return { resp, body: await resp.json() as { claim_id: string; device: string } };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const s = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(s + "=".repeat((4 - (s.length % 4)) % 4)));
}

describe("healthz 与落地页", () => {
  it("accessHeaderValue 容错:剥掉控制台整行复制的前缀,只留值", () => {
    expect(accessHeaderValue("CF-Access-Client-Secret: abcd1234")).toBe("abcd1234");
    expect(accessHeaderValue("CF-Access-Client-Id: id5678")).toBe("id5678");
    expect(accessHeaderValue("cf-access-client-secret: abcd1234")).toBe("abcd1234");
    expect(accessHeaderValue("  abcd1234  ")).toBe("abcd1234");
    expect(accessHeaderValue("abcd1234")).toBe("abcd1234");
  });

  it("healthz 上报 ok + max_upload_bytes 能力", async () => {
    const resp = await SELF.fetch("https://example.com/healthz");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.max_upload_bytes).toBe(16);
    expect(typeof body.upstream).toBe("boolean");
  });

  it("扫码落地页为静态 HTML", async () => {
    const resp = await SELF.fetch("https://example.com/pair");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain("配对码");
  });

  it("CORS 预检 204", async () => {
    const resp = await SELF.fetch("https://example.com/pair/start", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("配对全流程(与 Rust 版状态机同构)", () => {
  it("start → claim → poll offers → confirm 出令牌", async () => {
    const code = genCode();
    const { resp: startResp, body: start } = await startPairing(code, "pixel-9");
    expect(startResp.status).toBe(200);
    expect(start.pairing_id).toBeTruthy();
    expect(start.expires_at).toBeGreaterThan(Date.now() / 1000);

    const hostCode = genHostCode();
    const { resp: claimResp, body: claim } = await adminClaim(code, hostCode);
    expect(claimResp.status).toBe(200);
    expect(claim.device).toBe("pixel-9");

    const poll = await (
      await SELF.fetch("https://example.com/pair/poll", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET }),
      })
    ).json() as { status: string; offers: Array<Record<string, unknown>> };
    expect(poll.status).toBe("offers");
    expect(poll.offers).toHaveLength(1);
    expect(poll.offers[0].host_code).toBe(hostCode);
    expect(poll.offers[0].host_label).toBe("mac-mini");
    expect(poll.offers[0].tunnel_host).toBe("mac1.example.com");

    const confirmResp = await SELF.fetch("https://example.com/pair/confirm", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        pairing_id: start.pairing_id,
        secret: SECRET,
        claim_id: claim.claim_id,
        host_code: `${hostCode.slice(0, 3)}-${hostCode.slice(3)}`, // 大小写/连字符宽容
      }),
    });
    expect(confirmResp.status).toBe(200);
    const confirm = await confirmResp.json() as { token: string; expires_at: number; host_label: string };
    expect(confirm.host_label).toBe("mac-mini");
    const claims = decodeJwtPayload(confirm.token);
    expect(claims.sub).toBe("dsh-client");
    expect(claims.device).toBe("pixel-9");
    expect((claims.exp as number) - (claims.iat as number)).toBe(30 * 86400);

    // 再 poll:confirmed。
    const poll2 = await (
      await SELF.fetch("https://example.com/pair/poll", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET }),
      })
    ).json() as { status: string };
    expect(poll2.status).toBe("confirmed");

    // 令牌可用于设备清单。
    const devices = await (
      await SELF.fetch("https://example.com/auth/devices", { headers: baseHeaders(confirm.token) })
    ).json() as Array<Record<string, unknown>>;
    expect(devices).toHaveLength(1);
    expect(devices[0].device).toBe("pixel-9");
    expect(devices[0].tunnel_host).toBe("mac1.example.com");
    expect(devices[0].revoked).toBe(false);
    return confirm.token;
  });

  it("poll 秘密不对 → 401;未知 pairing → 404", async () => {
    const { body: start } = await startPairing();
    const wrong = await SELF.fetch("https://example.com/pair/poll", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: start.pairing_id, secret: "b".repeat(40) }),
    });
    expect(wrong.status).toBe(401);
    const unknown = await SELF.fetch("https://example.com/pair/poll", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: "nope", secret: SECRET }),
    });
    expect(unknown.status).toBe(404);
  });

  it("同码存活 pending 唯一:后到者 409(防抄码抢注)", async () => {
    const code = genCode();
    const first = await startPairing(code);
    expect(first.resp.status).toBe(200);
    const second = await startPairing(code);
    expect(second.resp.status).toBe(409);
    expect((second.body as Record<string, unknown>).error).toContain("already in use");
  });

  it("主机码比对不一致 → 400;claim 单次消费 → 409", async () => {
    const code = genCode();
    const { body: start } = await startPairing(code);
    const hostCode = genHostCode();
    const { body: claim } = await adminClaim(code, hostCode);

    const mismatch = await SELF.fetch("https://example.com/pair/confirm", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: genHostCode() }),
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json() as Record<string, unknown>).error).toContain("host code mismatch");

    const ok = await SELF.fetch("https://example.com/pair/confirm", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
    });
    expect(ok.status).toBe(200);

    const replay = await SELF.fetch("https://example.com/pair/confirm", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
    });
    // 与 Rust 版语义一致:pairing 已 confirmed → 先命中 400「不再活跃」;
    // 409「claim 已消费」是并发竞态保护,顺序调用不可达(下方直接对 DO 验证)。
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Record<string, unknown>).error).toContain("no longer active");
  });

  it("claim 单次消费原子性(DO 直调):第二次 consume 返回 false", async () => {
    const stub = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
    await stub.pairingInsert("pid-1", "ABCDEFGHIJ", SECRET, "dev", 600);
    await stub.claimInsert("cid-1", "ABCDEFGHIJ", "ABCDEF", "mac", "mac1.example.com", 300);
    expect(await stub.claimConsume("cid-1")).toBe(true);
    expect(await stub.claimConsume("cid-1")).toBe(false);
  });

  it("配对限速:同 IP 超过 20 次 start → 409", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const resp = await SELF.fetch("https://example.com/pair/start", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ code: genCode(), secret: SECRET }),
      });
      last = resp.status;
    }
    expect(last).toBe(409);
  });
});

describe("管理面(ADMIN_KEY 信任根)", () => {
  it("无 key → 401;错 key → 401;对 key → 正常", async () => {
    const code = genCode();
    await startPairing(code);
    const no = await SELF.fetch("https://example.com/admin/pair/claim", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ code, host_code: genHostCode() }),
    });
    expect(no.status).toBe(401);
    const wrong = await adminClaim(code, genHostCode(), "wrong-key");
    expect(wrong.resp.status).toBe(401);
    const ok = await adminClaim(code);
    expect(ok.resp.status).toBe(200);
  });

  it("claim 要求有手机在等这个码(不建悬空 offer)", async () => {
    const { resp, body } = await adminClaim(genCode());
    expect(resp.status).toBe(404);
    expect((body as Record<string, unknown>).error).toContain("no phone waiting");
  });

  it("status/tokens/qr 正常;qr 输出半块 ANSI", async () => {
    const code = genCode();
    const { body: start } = await startPairing(code, "iphone-17");
    const hostCode = genHostCode();
    const { body: claim } = await adminClaim(code, hostCode);

    await SELF.fetch("https://example.com/pair/confirm", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
    });

    const status = await (
      await SELF.fetch(`https://example.com/admin/pair/status?code=${code}`, {
        headers: { authorization: `Bearer test-admin-key-0123456789abcdef` },
      })
    ).json() as Record<string, unknown>;
    expect(status.confirmed).toBe(true);
    expect((status.token as Record<string, unknown>).device).toBe("iphone-17");

    const tokens = await (
      await SELF.fetch("https://example.com/admin/pair/tokens", {
        headers: { authorization: `Bearer test-admin-key-0123456789abcdef` },
      })
    ).json() as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);

    const qr = await SELF.fetch("https://example.com/admin/pair/qr", {
      method: "POST",
      headers: { authorization: `Bearer test-admin-key-0123456789abcdef`, "content-type": "application/json" },
      body: JSON.stringify({ text: "https://gw.example.com/pair#c=ABCDEFGHJK&h=ABCDEF" }),
    });
    expect(qr.status).toBe(200);
    const qrBody = await qr.json() as { modules: number; qr: string };
    expect(qrBody.modules).toBeGreaterThan(20);
    expect(qrBody.qr).toContain("\u001b[30;47m");
    expect(qrBody.qr).toContain("█");
  });
});

describe("鉴权与中转", () => {
  it("遗留 /auth/login 恒 403 指路配对(密码登录已从两版移除)", async () => {
    const resp = await SELF.fetch("https://example.com/auth/login", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ password: "x", device: "d" }),
    });
    expect(resp.status).toBe(403);
  });

  it("无令牌中转 → 401;伪造令牌 → 401", async () => {
    const no = await SELF.fetch("https://example.com/api/sessions");
    expect(no.status).toBe(401);
    const fake = await SELF.fetch("https://example.com/api/sessions", { headers: baseHeaders("fake.token.here") });
    expect(fake.status).toBe(401);
  });

  it("有效令牌但上游不可达 → 502(而非 401)", async () => {
    const code = genCode();
    const { body: start } = await startPairing(code);
    const hostCode = genHostCode();
    const { body: claim } = await adminClaim(code, hostCode, undefined);
    const confirm = await (
      await SELF.fetch("https://example.com/pair/confirm", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
      })
    ).json() as { token: string };

    const resp = await SELF.fetch("https://example.com/api/sessions", { headers: baseHeaders(confirm.token) });
    expect(resp.status).toBeGreaterThanOrEqual(500);
    expect(resp.status).toBeLessThanOrEqual(502);
  });

  it("声明超限的 content-length → 413 友好错误(不透传给上游)", async () => {
    const code = genCode();
    const { body: start } = await startPairing(code);
    const hostCode = genHostCode();
    const { body: claim } = await adminClaim(code, hostCode);
    const confirm = await (
      await SELF.fetch("https://example.com/pair/confirm", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
      })
    ).json() as { token: string };

    const resp = await SELF.fetch("https://example.com/api/sessions", {
      method: "POST",
      headers: baseHeaders(confirm.token),
      body: "x".repeat(32), // 测试环境 MAX_UPLOAD_BYTES=16
    });
    expect(resp.status).toBe(413);
    expect(((await resp.json()) as Record<string, unknown>).error).toContain("exceeds gateway limit");
  });

  it("吊销后令牌即刻失效", async () => {
    const code = genCode();
    const { body: start } = await startPairing(code);
    const hostCode = genHostCode();
    const { body: claim } = await adminClaim(code, hostCode);
    const confirm = await (
      await SELF.fetch("https://example.com/pair/confirm", {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ pairing_id: start.pairing_id, secret: SECRET, claim_id: claim.claim_id, host_code: hostCode }),
      })
    ).json() as { token: string };

    const jti = decodeJwtPayload(confirm.token).jti as string;
    await SELF.fetch("https://example.com/auth/revoke", {
      method: "POST",
      headers: baseHeaders(confirm.token),
      body: JSON.stringify({ jti }),
    });
    const after = await SELF.fetch("https://example.com/auth/devices", { headers: baseHeaders(confirm.token) });
    expect(after.status).toBe(401);
  });
});
