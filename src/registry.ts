// Registry —— 单例 Durable Object(SQLite 后端):令牌/配对/应约登记 + 限速计数。
// 状态机语义逐条对齐 Rust 版 dsh-mobile-gateway/src/db.rs:
// - 同码存活 pending 唯一,且 30 分钟内用过的码不可复用(防抄码抢注);
// - claim 单次消费;offer/配对过期置 expired(惰性 sweep);
// - 令牌吊销后 is_valid=false;中转按令牌解析上游(端口 → 隧道主机名)。
// 差异:上游路由从「SSH 隧道端口 13100–13199」换成「cloudflared 隧道主机名」,
// tokens 表多一列 tunnel_host;upstream_port 恒为 0(客户端仅展示用,不参与路由)。
import { DurableObject } from "cloudflare:workers";

export interface PairingRow {
  id: string;
  code_d: string;
  secret: string;
  device: string;
  created_at: number;
  expires_at: number;
  status: string; // pending | confirmed | expired
  token_jti: string;
}

export interface ClaimRow {
  id: string;
  pairing_code: string;
  host_code: string;
  host_label: string;
  tunnel_host: string;
  created_at: number;
  expires_at: number;
  status: string; // offered | consumed | expired
}

export interface TokenRow {
  jti: string;
  device: string;
  created_at: number;
  last_used_at: number | null;
  revoked: boolean;
  upstream_port: number | null;
  host_label: string;
  tunnel_host: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  upstream_port INTEGER,
  host_label TEXT NOT NULL DEFAULT '',
  tunnel_host TEXT
);
CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  code_d TEXT NOT NULL,
  secret TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token_jti TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pairings_code ON pairings(code_d);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  pairing_code TEXT NOT NULL,
  host_code TEXT NOT NULL,
  host_label TEXT NOT NULL,
  tunnel_host TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered'
);
CREATE INDEX IF NOT EXISTS idx_claims_code ON claims(pairing_code);
CREATE TABLE IF NOT EXISTS rate_hits (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_hits(kind, key, ts);
`;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class Registry extends DurableObject {
  private ready = false;

  private migrate(): void {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA);
      this.ready = true;
    }
  }

  private sweep(): void {
    const t = nowSec();
    this.ctx.storage.sql.exec(
      `UPDATE pairings SET status='expired' WHERE status='pending' AND expires_at < ${t};
       UPDATE claims SET status='expired' WHERE status='offered' AND expires_at < ${t};`,
    );
  }

  private pairingRow(r: Record<string, unknown>): PairingRow {
    return {
      id: r.id as string,
      code_d: r.code_d as string,
      secret: r.secret as string,
      device: r.device as string,
      created_at: r.created_at as number,
      expires_at: r.expires_at as number,
      status: r.status as string,
      token_jti: (r.token_jti as string) ?? "",
    };
  }

  private claimRow(r: Record<string, unknown>): ClaimRow {
    return {
      id: r.id as string,
      pairing_code: r.pairing_code as string,
      host_code: r.host_code as string,
      host_label: r.host_label as string,
      tunnel_host: r.tunnel_host as string,
      created_at: r.created_at as number,
      expires_at: r.expires_at as number,
      status: r.status as string,
    };
  }

  private tokenRow(r: Record<string, unknown>): TokenRow {
    return {
      jti: r.jti as string,
      device: r.device as string,
      created_at: r.created_at as number,
      last_used_at: (r.last_used_at as number | null) ?? null,
      revoked: (r.revoked as number) !== 0,
      upstream_port: (r.upstream_port as number | null) ?? null,
      host_label: (r.host_label as string) ?? "",
      tunnel_host: (r.tunnel_host as string | null) ?? null,
    };
  }

  // ── 限速(每 IP 滑动窗口;登录 8/5min、配对 20/5min)──────────────────

  async rateAllow(kind: string, key: string, max: number, windowSecs: number): Promise<boolean> {
    this.migrate();
    const now = nowSec();
    this.ctx.storage.sql.exec(
      "DELETE FROM rate_hits WHERE kind = ?1 AND ts < ?2",
      kind,
      now - windowSecs,
    );
    const cursor = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS c FROM rate_hits WHERE kind = ?1 AND key = ?2",
      kind,
      key,
    );
    const count = Number(cursor.one().c);
    if (count >= max) return false;
    this.ctx.storage.sql.exec("INSERT INTO rate_hits (kind, key, ts) VALUES (?1, ?2, ?3)", kind, key, now);
    return true;
  }

  // ── pairings(手机侧)───────────────────────────────────────────────

  /** 注册 pending。false = 同码占用(存活 pending,或 30 分钟内用过)→ 409。
   *  注意:workers sqlite 的 rowsWritten 对 INSERT..SELECT 不可靠,以回读行判成败。 */
  async pairingInsert(
    id: string,
    code: string,
    secret: string,
    device: string,
    ttlSecs: number,
  ): Promise<boolean> {
    this.migrate();
    this.sweep();
    const now = nowSec();
    this.ctx.storage.sql.exec(
      `INSERT INTO pairings (id, code_d, secret, device, created_at, expires_at, status)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM pairings WHERE code_d = ?2
         AND (status = 'pending' OR created_at > ?7 - 1800)
       )`,
      id,
      code,
      secret,
      device,
      now,
      now + ttlSecs,
      now,
    );
    const inserted = this.ctx.storage.sql.exec("SELECT 1 FROM pairings WHERE id = ?1", id);
    for (const _row of inserted) return true;
    return false;
  }

  async pairingGet(id: string): Promise<PairingRow | null> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec("SELECT * FROM pairings WHERE id = ?1", id);
    for (const row of cursor) return this.pairingRow(row);
    return null;
  }

  async pairingByCode(code: string): Promise<PairingRow | null> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM pairings WHERE code_d = ?1 AND status = 'pending'",
      code,
    );
    for (const row of cursor) return this.pairingRow(row);
    return null;
  }

  async pairingSetStatus(id: string, status: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE pairings SET status = ?2 WHERE id = ?1", id, status);
  }

  async pairingSetToken(id: string, jti: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE pairings SET token_jti = ?2 WHERE id = ?1", id, jti);
  }

  async pairingStatusWithToken(
    code: string,
  ): Promise<{ pairing: PairingRow; token: TokenRow | null } | null> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM pairings WHERE code_d = ?1 ORDER BY created_at DESC LIMIT 1",
      code,
    );
    let pairing: PairingRow | null = null;
    for (const row of cursor) pairing = this.pairingRow(row);
    if (!pairing) return null;
    let token: TokenRow | null = null;
    if (pairing.token_jti) {
      const tc = this.ctx.storage.sql.exec("SELECT * FROM tokens WHERE jti = ?1", pairing.token_jti);
      for (const row of tc) token = this.tokenRow(row);
    }
    return { pairing, token };
  }

  // ── claims(Mac 侧)────────────────────────────────────────────────

  async claimInsert(
    id: string,
    pairingCode: string,
    hostCode: string,
    hostLabel: string,
    tunnelHost: string,
    ttlSecs: number,
  ): Promise<void> {
    this.migrate();
    const now = nowSec();
    this.ctx.storage.sql.exec(
      `INSERT INTO claims (id, pairing_code, host_code, host_label, tunnel_host, created_at, expires_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'offered')`,
      id,
      pairingCode,
      hostCode,
      hostLabel,
      tunnelHost,
      now,
      now + ttlSecs,
    );
  }

  async claimsFor(pairingCode: string): Promise<ClaimRow[]> {
    this.migrate();
    this.sweep();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM claims WHERE pairing_code = ?1 AND status = 'offered' ORDER BY created_at",
      pairingCode,
    );
    return cursor.toArray().map((r) => this.claimRow(r));
  }

  async claimGet(id: string): Promise<ClaimRow | null> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec("SELECT * FROM claims WHERE id = ?1", id);
    for (const row of cursor) return this.claimRow(row);
    return null;
  }

  /** 单次消费:仅当仍为 offered 时置 consumed(原子,RETURNING 判成败)。 */
  async claimConsume(id: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE claims SET status = 'consumed' WHERE id = ?1 AND status = 'offered' RETURNING id",
      id,
    );
    for (const _row of cursor) return true;
    return false;
  }

  // ── tokens ────────────────────────────────────────────────────────

  async tokenInsert(jti: string, device: string, tunnelHost: string, hostLabel: string): Promise<void> {
    this.migrate();
    this.ctx.storage.sql.exec(
      "INSERT INTO tokens (jti, device, created_at, tunnel_host, host_label) VALUES (?1, ?2, ?3, ?4, ?5)",
      jti,
      device,
      nowSec(),
      tunnelHost,
      hostLabel,
    );
  }

  async tokenValid(jti: string): Promise<boolean> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT revoked FROM tokens WHERE jti = ?1",
      jti,
    );
    for (const row of cursor) return (row.revoked as number) === 0;
    return false;
  }

  /** 中转热路径:一次往返完成 吊销检查 + touch + 上游解析。 */
  async tokenRoute(jti: string): Promise<{ valid: boolean; tunnelHost: string | null }> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE tokens SET last_used_at = ?2 WHERE jti = ?1 AND revoked = 0 RETURNING tunnel_host",
      jti,
      nowSec(),
    );
    for (const row of cursor) {
      return { valid: true, tunnelHost: (row.tunnel_host as string | null) ?? null };
    }
    return { valid: false, tunnelHost: null };
  }

  async tokens(): Promise<TokenRow[]> {
    this.migrate();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT * FROM tokens ORDER BY created_at DESC",
    );
    return cursor.toArray().map((r) => this.tokenRow(r));
  }

  async revoke(jti: string): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE tokens SET revoked = 1 WHERE jti = ?1 AND revoked = 0 RETURNING jti",
      jti,
    );
    for (const _row of cursor) return true;
    return false;
  }
}
