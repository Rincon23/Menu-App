// Checador de status dos serviços — roda no servidor, sem as limitações do
// navegador (o navegador não consegue LER o corpo de uma resposta de outro
// domínio por causa do CORS; daqui a gente lê à vontade). O front manda a
// lista de alvos em POST /api/status e recebe { statuses: { id: "online" | "offline" } }.
//
// Como decide (lógica simples: é um curl):
//   - resposta com status de origem fora do ar (502/503/504/52x/530) -> "offline"
//   - o corpo é a página de erro do Cloudflare Tunnel / "bad gateway" -> "offline"
//   - qualquer outra resposta -> "online"
//   - erro de rede / DNS / timeout -> "offline"
//   - host não permitido ou payload inválido -> "unknown" (não checado)

// Marcadores das páginas de erro que aparecem quando o serviço de origem caiu
// mas o proxy/túnel continua no ar (container parado, nginx sem upstream...).
const TUNNEL_DOWN_RE = /cloudflare tunnel error|error 1033|error code:\s*10\d\d|unable to resolve it|bad gateway|web server is down/i;

// Status HTTP que Cloudflare / proxy reverso devolve quando a origem está fora
// do ar (não é erro do serviço em si, é o serviço não respondendo).
const ORIGIN_DOWN_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

import http from "node:http";

const PORT = Number(process.env.PORT) || 3001;
const ALLOWED_HOST_SUFFIX = process.env.ALLOWED_HOST_SUFFIX || ".rincon.dev.br";
// Hosts públicos extras liberados pra checagem (ex.: cloudflare.com, que não
// mora em *.rincon.dev.br mas aparece no menu). Lista separada por vírgula.
const ALLOWED_EXACT_HOSTS = new Set(
  (process.env.ALLOWED_EXACT_HOSTS || "cloudflare.com,www.cloudflare.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);
const REQUEST_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 8000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30000;
const MAX_TARGETS = 50;

/** @type {Map<string, { status: string, at: number }>} */
const cache = new Map();

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return (
    ALLOWED_EXACT_HOSTS.has(h) ||
    h === ALLOWED_HOST_SUFFIX.replace(/^\./, "") ||
    h.endsWith(ALLOWED_HOST_SUFFIX)
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
    // Status de "origem fora do ar" já decide sozinho — nem precisa ler o corpo.
    if (ORIGIN_DOWN_STATUS.has(res.status)) return "offline";
    // Caso a origem responda 200 mas com uma página de erro de proxy/túnel,
    // confere o começo do corpo.
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
