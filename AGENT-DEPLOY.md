# AGENT-DEPLOY.md —— 把这个文件发给你的 AI 代理,它替你完成全部部署

> **人类只需要做两件事**:① 在 Cloudflare 控制台创建一张 API Token(见「阶段 0」,
> 唯一无法命令化的一步,因为鸡蛋相生);② 把本文件内容粘给任何能执行命令的代理
> (Claude Code / ZCode / Codex …),并回答它向你确认的 3 个问题。

---

## 给代理的指令

你要在用户的 **Mac** 上端到端部署 `dsh-gateway-worker`(dsh 移动接入网关的
Cloudflare Workers 形态),目标拓扑:

```
手机 App ─https→ Worker(网关域名,如 dsh.example.com)
                 │ fetch + Access service token
                 ▼
        隧道域名(如 dsh-xxxx.example.com)←─ cloudflared ─ Mac 本机 dsh web
```

**安全红线(不可协商):**
- 密钥(`JWT_SECRET`/`ADMIN_KEY`/`CF_ACCESS_CLIENT_SECRET`/tunnel token)生成后
  只写入目标位置,**不要**打印到对话之外的地方;`client_secret` 与 tunnel token
  服务端只返回一次,拿不到就要重建,不存在「再查一次」;
- 一切写操作前先 GET 查重(同名 Worker/隧道/应用/DNS 记录**复用**,不重复创建);
- 每个阶段结束跑「验证」小节,失败先排查再前进,禁止跳过验证继续部署;
- 用户没有确认过的主机名不要自行猜测,按「阶段 0」的默认值向用户确认。

### 阶段 0:前置检查与参数收集

向用户确认/收集,然后写进 shell 环境(后续命令全部引用这些变量):

```bash
# 你需要用户提供:刚创建的 API Token(权限见下),export 后自检
export CLOUDFLARE_API_TOKEN=<用户提供>
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep '"success":true'

# 账户 ID(多账户时列出让用户选一个)
curl -s "https://api.cloudflare.com/client/v4/accounts" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | python3 -c "import json,sys; [print(x['id'], x['name']) for x in json.load(sys.stdin)['result']]"
export CLOUDFLARE_ACCOUNT_ID=<上面选中的>
```

**API Token 需要的权限**(引导用户在
dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom 创建):

| 范围 | 权限 | 用途 |
|---|---|---|
| Account | Workers Scripts | Edit | 部署 Worker |
| Account | Cloudflare Tunnel | Edit | 建隧道/取 token/ingress |
| Account | Access: Apps and Policies | Edit | 建 self-hosted 应用 |
| Account | Access: Service Tokens | Edit | 建 service token |
| Zone | DNS | Edit | 隧道/网关域名记录 |
| Zone | Workers Routes | Edit | 网关自定义域名 |

其余参数(逐项向用户确认,括号为默认值):

```bash
export CLOUDFLARE_ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?per_page=50" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | python3 -c "import json,sys; z=json.load(sys.stdin)['result']; \
print('\n'.join(f'{x[\"id\"]} {x[\"name\"]}' for x in z))")
# ↑ 列出 zone 让用户选一个,export CLOUDFLARE_ZONE_ID=<选中>,ZONE_NAME 同步取

export GW_HOST=<网关域名,默认 dsh.$ZONE_NAME>          # 手机连这个
export TUNNEL_HOST=<隧道域名,默认 dsh-$(openssl rand -hex 2).$ZONE_NAME>  # 越随机越好
export DSH_PORT=<dsh web 实际端口>    # Mac 上跑着 dsh web;查:lsof -nP -iTCP -sTCP:LISTEN | grep -i dsh
export WORKER_NAME=dsh-gateway-worker
export REPO=https://github.com/iptton-ai/dsh-gateway-worker
```

前置自检(任一失败,停下来告诉用户怎么补):

```bash
node --version            # ≥18
cloudflared --version     # 未装:brew install cloudflared
curl -s "http://127.0.0.1:$DSH_PORT/" -o /dev/null -w '%{http_code}\n'   # dsh 在跑(非 000 即可)
```

### 阶段 1:部署 Worker

```bash
git clone $REPO /tmp/dsh-gw && cd /tmp/dsh-gw
python3 - <<'EOF'   # 改写 wrangler.jsonc:名称唯一化 + 填入隧道域名 + 绑网关域名
import json,re
p='wrangler.jsonc'; s=open(p).read()
s=s.replace('"name": "dsh-gateway-worker"', f'"name": "{__import__("os").environ["WORKER_NAME"]}"')
s=re.sub(r'"TUNNEL_HOST": "[^"]*"', f'"TUNNEL_HOST": "{__import__("os").environ["TUNNEL_HOST"]}"', s)
s=s.replace('"observability"', f'"routes": [{{ "pattern": "{__import__("os").environ["GW_HOST"]}", "custom_domain": true }}],\n  "observability"', 1)
open(p,'w').write(s)
EOF
# 两个强随机密钥(生成后只进 secret,不落对话)
export JWT_SECRET=$(openssl rand -hex 32); export ADMIN_KEY=$(openssl rand -hex 32)
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET
echo "$ADMIN_KEY" | npx wrangler secret put ADMIN_KEY
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy
```

> wrangler 会用 `CLOUDFLARE_API_TOKEN` 环境变量鉴权,不需要 wrangler login。

**验证**:`curl -s https://$GW_HOST/healthz` → `{"ok":true,...}`(证书签发可能要等
1–2 分钟;DNS 报错先查 zone 权限)。

**必须留给用户**(部署完成后原样转述,这是他管理网关的钥匙):
`ADMIN_KEY=<值>`——建议用户存进密码管理器;泄露 = 任何人可配对,只能换 key 重配对。

### 阶段 2:cloudflared 隧道(纯 API)

```bash
# 1) 建远程管理隧道(重跑前先 GET /cfd_tunnel 列表查重名复用)
export TUNNEL_ID=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"dsh-gateway","config_src":"cloudflare"}' \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; print(r['id'])")
export TUNNEL_TOKEN=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")

# 2) ingress:隧道域名 → 本机 dsh;Host 改写是 dsh 信任围栏的硬要求
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"config\":{\"ingress\":[{\"hostname\":\"$TUNNEL_HOST\",\"service\":\"http://localhost:$DSH_PORT\",\"originRequest\":{\"httpHostHeader\":\"127.0.0.1:$DSH_PORT\"}},{\"service\":\"http_status:404\"}]}}" | grep '"success":true'

# 3) DNS(重跑前 GET /zones/$CLOUDFLARE_ZONE_ID/dns_records 查同名复用)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"type\":\"CNAME\",\"proxied\":true,\"name\":\"$TUNNEL_HOST\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\"}" | grep '"success":true'

# 4) Mac 上跑起来(sudo 装系统服务;不想 sudo 就 brew services start cloudflared + config)
sudo cloudflared service install "$TUNNEL_TOKEN"
```

**验证**:`curl -s -o /dev/null -w '%{http_code}\n' https://$TUNNEL_HOST/` → 任何
HTTP 状态码(404/405 都算通);`000`/超时 = 隧道没起,查 `cloudflared` 日志。

### 阶段 3:Access 加固(推荐,防止隧道域名泄漏后被直连)

```bash
# 1) service token(只此一次能看到 client_secret)
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_access_service_tokens" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"dsh-gateway-worker"}' > /tmp/svc.json
export AID=$(python3 -c "import json;print(json.load(open('/tmp/svc.json'))['result']['id'])")
export ACLIENT_ID=$(python3 -c "import json;print(json.load(open('/tmp/svc.json'))['result']['client_id'])")
export ACLIENT_SECRET=$(python3 -c "import json;print(json.load(open('/tmp/svc.json'))['result']['client_secret'])")
rm /tmp/svc.json   # 用完即删

# 2) self-hosted 应用 + 内联 Service Auth 策略(域名=隧道域名)
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"dsh-gateway tunnel\",\"type\":\"selfhosted\",\"domain\":\"$TUNNEL_HOST\",\"policies\":[{\"name\":\"allow-gateway-worker\",\"precedence\":1,\"decision\":\"service_auth\",\"include\":[{\"service_token\":{\"id\":\"$AID\"}}]}]}" | grep '"success":true'

# 3) 把凭证写回 Worker(secret 走 secret put;ID 半对写进 vars 重新部署)
echo "$ACLIENT_SECRET" | npx wrangler secret put CF_ACCESS_CLIENT_SECRET
python3 - <<'EOF'
import json,re,os
p='/tmp/dsh-gw/wrangler.jsonc'; s=open(p).read()
s=re.sub(r'"CF_ACCESS_CLIENT_ID": "[^"]*"', f'"CF_ACCESS_CLIENT_ID": "{os.environ["ACLIENT_ID"]}"', s)
open(p,'w').write(s)
EOF
CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN npx wrangler deploy
```

**验证**:
- `curl -sI https://$TUNNEL_HOST/ | head -1` → **302**(无凭证被 Access 拦 = 加固生效);
- `curl -s https://$GW_HOST/healthz` → `"upstream":true`(Worker 带凭证探测通过 = 全链路通)。

### 阶段 4:配对与交付

```bash
cd /tmp/dsh-gw
GW=https://$GW_HOST ADMIN_KEY=$ADMIN_KEY node scripts/pair.mjs <手机App「配对连接」页生成的10位码> --label $(scutil --get ComputerName 2>/dev/null || echo mac)
```

向用户输出交付清单(原样转述):

```
✅ 网关地址:  https://<GW_HOST>        (手机 App 配对页/登录页填这个)
   隧道状态:  healthz upstream:true
   密钥保管:  ADMIN_KEY 已单独告知;忘记即重跑阶段 1 的 secret put 换新
   吊销设备:  GW=https://<GW_HOST> ADMIN_KEY=*** node scripts/revoke.mjs --list
   上游更新:  cd /tmp/dsh-gw && git pull && npx wrangler deploy
```

### 故障排查速查

| 症状 | 判断 |
|---|---|
| healthz `upstream:false` + 隧道 curl 000 | cloudflared 没起 / DSH_PORT 错(`sudo cloudflared service install` 后看 `log show --predicate 'process == "cloudflared"'`) |
| 隧道 curl 302 → cloudflareaccess.com | Access 生效但 Worker 侧 secret/ID 没配对(阶段 3 第 3 步漏跑或值粘贴带了 `CF-Access-Client-Id: ` 前缀——Worker 会自动剥,但值本身必须对) |
| 隧道 curl 530/1033 | DNS 记录指向的隧道不对,或 ingress 没配 catch-all |
| healthz 413 | 请求体超 `MAX_UPLOAD_BYTES`(CF 计划硬顶:Free/Pro 100MB) |
| 配对 409 code already in use | 同码 30 分钟内用过,手机端换个码 |
