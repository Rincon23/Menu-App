// Checador de status dos serviços — roda no servidor, sem as limitações do
// navegador (o navegador não consegue LER o corpo de uma resposta de outro
// domínio por causa do CORS; daqui a gente lê à vontade). O front manda a
// lista de alvos em POST /api/status e recebe { statuses: { id: "online" | "offline" } }.
//
// Como decide (lógica simples: é um curl):
//   - a resposta contém a página de erro do Cloudflare Tunnel (1033) -> "offline"
//   - qualquer outra resposta -> "online"
//   - erro de rede / DNS / timeout -> "offline"
//   - host fora de *.rincon.dev.br ou payload inválido -> "unknown" (não checado)

// Marcadores da página "Error 1033 — Cloudflare Tunnel error" (túnel fora do ar).
const TUNNEL_DOWN_RE = /cloudflare tunnel error|error 1033|error code:\s*1033|unable to resolve it/i;

import http from "node:http";

const PORT = Number(process.env.PORT) || 3001;
const ALLOWED_HOST_SUFFIX = process.env.ALLOWED_HOST_SUFFIX || ".rincon.dev.br";
const REQUEST_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 8000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30000;
const MAX_TARGETS = 50;

/** @type {Map<string, { status: string, at: number }>} */
const cache = new Map();

function hostAllowed(hostname) {
  return (
    hostname === ALLOWED_HOST_SUFFIX.replace(/^\./, "") ||
    hostname.endsWith(ALLOWED_HOST_SUFFIX)
  );
}

async function probe(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return "unknown";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "unknown";
  if (!hostAllowed(url.hostname)) return "unknown";

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": "rincon-menu-healthcheck/1.0" },
    });
    // Lê só o começo do corpo pra ver se é a página de erro do túnel
    // (ela vem com HTTP 530, mas conferir o texto é mais seguro).
    let body = "";
    try {
      body = (await res.text()).slice(0, 4000);
    } catch {
      body = "";
    }
    return TUNNEL_DOWN_RE.test(body) ? "offline" : "online";
  } catch {
    return "offline";
  }
}

async function probeCached(rawUrl) {
  const hit = cache.get(rawUrl);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.status;
  const status = await probe(rawUrl);
  cache.set(rawUrl, { status, at: now });
  return status;
}

function sendJson(res, code, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/api/status") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  let body = "";
  let tooLarge = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 20000) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    let targets;
    try {
      targets = JSON.parse(body).targets;
    } catch {
      targets = null;
    }
    if (!Array.isArray(targets)) {
      sendJson(res, 400, { error: "corpo precisa ser { targets: [{ id, url }] }" });
      return;
    }

    const statuses = {};
    await Promise.all(
      targets.slice(0, MAX_TARGETS).map(async (t) => {
        if (!t || typeof t.id !== "string" || typeof t.url !== "string") return;
        statuses[t.id] = await probeCached(t.url);
      })
    );

    sendJson(res, 200, { statuses, checkedAt: new Date().toISOString() });
  });
});

server.listen(PORT, () => {
  console.log(`[rincon-menu-checker] ouvindo em :${PORT}`);
});
