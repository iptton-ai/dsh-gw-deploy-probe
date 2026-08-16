# dsh-gateway-worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iptton-ai/dsh-gateway-worker)

DeepSeek Harness 移动接入网关的 **Cloudflare Workers 部署形态**:没有服务器、只有
域名 + CF 账号,也能给自己的 singleman App 搭一条安全中转。协议与
[Rust 版 dsh-mobile-gateway](https://github.com/iptton-ai/dsh-mobile-gateway)
逐字段同构(配对鉴权 + HTTP 流式/WS 中转),手机 App **零改动**直连;两版并存,
按自己有什么基础设施选。

配套:

- 移动客户端(Flutter):[DeepseekHarnessApp](https://github.com/iptton-ai/DeepseekHarnessApp)
- Mac 侧 dsh 插件(隧道 + 配对 UI):[dsh-mobile](https://github.com/iptton-ai/dsh-mobile)
- 自建服务器形态(Rust + nginx + SSH 隧道):[dsh-mobile-gateway](https://github.com/iptton-ai/dsh-mobile-gateway)

## 架构

```
手机 App ─https/wss→ CF Worker(本仓库:配对+令牌+中转)
                        │ fetch(可选注入 Access service token)
                        ▼
              隧道主机名 mac.example.com ←── cloudflared 出站隧道 ── Mac(dsh web)
                                    (--http-host-header 127.0.0.1:<端口>)
```

- **鉴权**:仅配对(双向亮码防抢注,令牌 30 天、可吊销);密码登录已从两版移除,
  Workers 形态对遗留的 `/auth/login` 恒回 403 指路配对。
- **中转**:HTTP 流式透传 + WebSocket 101 直通(events.mux 逐帧不耗 Worker CPU);
  dsh↔LLM 供应商流量不经 Cloudflare。
- **存储**:单个 Durable Object(SQLite 后端,免费档即可用),持有令牌/配对/限速
  三张表;无需 D1/KV 等账号级资源 —— 这是能一键部署的前提。
- **管理面**:Rust 版绑定服务器 loopback(信任根 = ssh 权限);Workers 形态凭
  `ADMIN_KEY`(信任根 = 密钥),Mac 侧 `scripts/pair.mjs` 零依赖、全程免 ssh。
- **多机**:每台 Mac 一条 cloudflared 隧道(各自主机名);claim 时传 `tunnel_host`
  可覆盖默认值,令牌绑定来源主机。

## 一键部署

1. 点上面的 **Deploy to Cloudflare** 按钮(CF 会把本仓库克隆进你的账号并接好 CI,
   push 即自动重部署);
2. 部署界面填变量(密钥项来自 `.dev.vars.example`,配置项来自 `wrangler.jsonc`;
   也可部署后在 Settings 补填):

   | 变量 | 类型 | 说明 |
   |---|---|---|
   | `JWT_SECRET` | secret | 令牌签名密钥,`openssl rand -hex 32`,必填 |
   | `ADMIN_KEY` | secret | 管理密钥(Mac 侧配对凭它),`openssl rand -hex 32`,必填 |
   | `CF_ACCESS_CLIENT_SECRET` | secret | 可选;Access service token 的 SECRET 半对 |
   | `TUNNEL_HOST` | var | cloudflared 隧道公网主机名,如 `mac.example.com`,必填 |
   | `CF_ACCESS_CLIENT_ID` | var | 可选;Access service token 的 ID 半对 |
   | `MAX_UPLOAD_BYTES` | var | 单请求体积上限,默认 100MiB(见下方「限制」) |

3. 绑自定义域名:Dashboard → Worker → Settings → Domains & Routes → 添加
   `gw.你的域名`(workers.dev 在部分网络不可达,自定义域名必做);
4. Mac 侧起隧道(见下);
5. 配对(见下)。

## Mac 侧:cloudflared 隧道

在 [Zero Trust → Networks → Tunnels](https://one.dash.cloudflare.com/) 创建
cloudflared 隧道,Public Hostname 指向本机 dsh:

- Subdomain/Domain:`mac.example.com`(与 `TUNNEL_HOST` 一致)
- Service:`http://localhost:<dsh web 端口>`
- **Additional application settings → HTTP Settings → HTTP Host Header** 填
  `127.0.0.1:<dsh web 端口>` —— 对应 Rust 版的 `DSH_GATEWAY_UPSTREAM_HOST`:
  dsh 信任围栏按 Host 判定 loopback,cloudflared 的来源连接本就是本机回环,
  Host 改写后 dsh 视之与桌面同机客户端无异。

Mac 上安装:`cloudflared service install <隧道 token>`(或用
[dsh-mobile](https://github.com/iptton-ai/dsh-mobile) 插件托管隧道生命周期)。

## 可选加固:用 Cloudflare Access 保护隧道主机名

隧道主机名(如 `mac.example.com`)是公开 URL——谁知道域名谁就能**绕过网关直连
dsh**,且 cloudflared 的本机回环连接恰好满足 dsh 信任围栏,等于拿到完整本地特权。
默认仅靠「长随机子域名不可猜测」防护;建议用 Access(Zero Trust 免费档)上锁,
让全世界只有本 Worker 能访问隧道:

1. 打开 [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) →
   **Access → Service Tokens → Create Service Token**;
2. 复制 **Client ID** 与 **Client Secret**(Secret 只显示这一次)——即部署时的
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` 两个变量;
3. **Access → Applications → Add a self-hosted application**,域名填隧道主机名
   (与 `TUNNEL_HOST` 相同);
4. 给该 Application 加 Policy:Action = **Service Auth**,Include = 刚创建的
   Service Token,保存。

效果:Worker 每次上游请求自动带凭证通过;其他任何来源(无凭证的 curl/浏览器)
都会被 302 到 Access 登录页,止步于边缘。轮换:新建 token → 更新 Worker 两个
变量 → 删旧 token。

## Mac 侧:配对

```bash
GW=https://gw.example.com ADMIN_KEY=<部署时填的> \
  node scripts/pair.mjs <手机 App 上显示的 10 位配对码> --label mac-mini
```

终端大字显示 6 位主机码 + 邀请二维码 → 手机扫码(或手输码)→ App 里核对主机码
点选 → 完成,设备获得 30 天令牌。设备不对劲时:

```bash
node scripts/revoke.mjs --list    # 令牌清单
node scripts/revoke.mjs <jti>     # 吊销
```

## 限制与注意事项(部署前必读)

| 事项 | 说明 |
|---|---|
| **单请求体积上限** | Cloudflare 代理按账户计划硬顶:Free/Pro **100MB**、Business 200MB、Enterprise 500MB+。聚合大量图片 base64 的请求可能触顶被 413(该 413 由 CF 边缘直接返回,Worker 拦不到);本 Worker 会按 `MAX_UPLOAD_BYTES` 提前给出友好 413,`/healthz` 也上报该值供 App 预检。**经常传大附件请用 Rust 版自建网关。** |
| DO 免费额度 | SQLite 后端 Durable Object 免费档:10 万请求/天、500 万行读/天、5GB 存储。个人网关绰绰有余。 |
| WS 空闲超时 | 长连 WebSocket 若长时间无流量,可能被边缘断开;dsh 事件流自带心跳,正常使用不受影响,异常环境请实测。 |
| 隧道主机名暴露 | 默认仅靠主机名不可猜测性;建议用 Cloudflare Access(service token)保护 `TUNNEL_HOST`,把 token 填进 Worker 变量。 |
| 信任根差异 | 管理面信任根从「服务器 ssh 权限」变为「ADMIN_KEY 密钥」;请用强随机值,泄漏即等于交出配对权(可换 key 后重启配对)。 |
| 上游升级 | Deploy Button 克隆进你账号的是独立副本;本仓库更新后需自行 `git pull` 触发重部署。 |

## 与 Rust 版对比

| | dsh-gateway-worker(本仓库) | [dsh-mobile-gateway](https://github.com/iptton-ai/dsh-mobile-gateway)(Rust) |
|---|---|---|
| 前置条件 | CF 账号 + 域名(免费档可用) | 一台服务器(nginx + systemd) |
| 部署 | Deploy Button 一键 + cloudflared | docker compose / systemd |
| Mac 侧隧道 | cloudflared(出站) | SSH 反向隧道 |
| 请求体上限 | 100/200MB(账户计划) | 自定(默认对齐 dsh 160MiB) |
| 大陆访问质量 | 取决于域名与边缘调度 | 服务器在哪就在哪 |
| 适合 | 无服务器个人用户、海外链路 | 自有 VPS、大附件、完全自控 |

## 开发

```bash
pnpm install        # 或 npm install
pnpm test           # 17 项集成测试(vitest-pool-workers,DO 真实运行;配置见 wrangler.test.jsonc)
pnpm typecheck
cp .dev.vars.example .dev.vars && vi .dev.vars   # 本地开发密钥
npx wrangler dev    # 本地起 Worker(:8787)
```

MIT License.
