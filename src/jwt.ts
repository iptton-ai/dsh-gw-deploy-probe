// HS256 JWT(WebCrypto 实现)。claims 形状与 Rust 版 gateway_shared::jwt 对齐:
// {sub, jti, device, iat, exp};校验签名 + exp(jsonwebtoken Validation 默认行为)。

export interface GatewayClaims {
  sub: string;
  jti: string;
  device: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  const s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(claims: GatewayClaims, secret: string): Promise<string> {
  const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<GatewayClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !secret) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(parts[2]) as BufferSource,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    // 与 jsonwebtoken Validation 默认行为对齐:必须带 exp 且未过期。
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
