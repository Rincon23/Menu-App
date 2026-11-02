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
//
// Também entrega as métricas das máquinas (RAM, disco e containers) em
// GET /api/system — ver a seção "Métricas" mais abaixo.

// Marcadores das páginas de erro que aparecem quando o serviço de origem caiu
// mas o proxy/túnel continua no ar (container parado, nginx sem upstream...).
const TUNNEL_DOWN_RE = /cloudflare tunnel error|error 1033|error code:\s*10\d\d|unable to resolve it|bad gateway|web server is down/i;

// Status HTTP que Cloudflare / proxy reverso devolve quando a origem está fora
// do ar (não é erro do serviço em si, é o serviço não respondendo).
const ORIGIN_DOWN_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

import http from "node:http";
import os from "node:os";
import { statfs } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

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

// --- Métricas: RAM, disco e containers -------------------------------------
// Cada máquina (seção do menu) roda este mesmo checador. Dentro do container,
// os.totalmem/freemem e o statfs de "/" enxergam o HOST (RAM e disco onde o
// Docker guarda os dados), e o socket do Docker diz quanto cada container em
// execução usa. A máquina onde o menu roda junta as próprias métricas
// (MACHINE_ID) com as das outras (REMOTE_AGENTS, via GET /api/agent) e
// entrega tudo em GET /api/system.

// id da seção do menu que corresponde a ESTA máquina ("orangepi", "servidor").
const MACHINE_ID = process.env.MACHINE_ID || "";
const DOCKER_SOCKET =
  process.env.DOCKER_SOCKET ||
  (process.platform === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock");
const DISK_PATH = process.env.DISK_PATH || "/";
// Segredo compartilhado entre as máquinas pra proteger GET /api/agent.
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
// "servidor=http://100.x.y.z:3002,outra=http://..." -> [["servidor", "http://..."]]
const REMOTE_AGENTS = (process.env.REMOTE_AGENTS || "")
  .split(",")
  .filter((s) => s.includes("="))
  .map((s) => [s.slice(0, s.indexOf("=")).trim(), s.slice(s.indexOf("=") + 1).trim()])
  .filter(([id, url]) => id && url);
const SYSTEM_CACHE_TTL_MS = 10000;
// "docker system df" é pesado (varre volumes), então o tamanho em disco de
// cada container é recalculado no máximo a cada 10 min, em segundo plano.
const DF_CACHE_TTL_MS = 10 * 60 * 1000;

function dockerGet(path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`docker ${path} respondeu ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`docker ${path} demorou demais`)));
    req.on("error", reject);
    req.end();
  });
}

// Mesma conta do "docker stats": uso total menos o cache de arquivos inativos.
function containerRam(stats) {
  const mem = stats.memory_stats || {};
  if (!mem.usage) return null;
  const inactive = mem.stats?.total_inactive_file ?? mem.stats?.inactive_file ?? 0; // cgroup v1 ?? v2
  return inactive < mem.usage ? mem.usage - inactive : mem.usage;
}

/** @type {{ at: number, byId: Map<string, number> } | null} */
let dfCache = null;
let dfPending = null;

function refreshDf() {
  dfPending ??= dockerGet("/system/df", 120000)
    .then((df) => {
      const volumes = new Map((df.Volumes || []).map((v) => [v.Name, Math.max(0, v.UsageData?.Size ?? 0)]));
      const byId = new Map();
      // Disco do container = imagem + camada gravável + volumes nomeados que ele
      // monta. Pastas do host montadas direto (bind mounts) não entram na conta.
      for (const c of df.Containers || []) {
        let bytes = c.SizeRootFs || 0;
        for (const m of c.Mounts || []) if (m.Type === "volume") bytes += volumes.get(m.Name) || 0;
        byId.set(c.Id, bytes);
      }
      dfCache = { at: Date.now(), byId };
    })
    .catch((err) => console.warn("[rincon-menu-checker] docker system df falhou:", err.message))
    .finally(() => {
      dfPending = null;
    });
  return dfPending;
}

async function containerDisks() {
  // Na primeira vez espera um pouco; se demorar, responde sem o disco e ele
  // aparece na próxima consulta.
  if (!dfCache) await Promise.race([refreshDf(), sleep(8000)]);
  else if (Date.now() - dfCache.at > DF_CACHE_TTL_MS) refreshDf();
  return dfCache?.byId ?? new Map();
}

async function collectLocal() {
  const total = os.totalmem();
  const out = { ram: { used: total - os.freemem(), total }, disk: null, containers: null };

  try {
    const s = await statfs(DISK_PATH);
    out.disk = { used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize };
  } catch (err) {
    console.warn("[rincon-menu-checker] statfs falhou:", err.message);
  }

  try {
    const [list, disks] = await Promise.all([dockerGet("/containers/json"), containerDisks()]);
    out.containers = await Promise.all(
      list.map(async (c) => {
        let ram = null;
        try {
          ram = containerRam(await dockerGet(`/containers/${c.Id}/stats?stream=false&one-shot=true`));
        } catch {
          ram = null;
        }
        return {
          name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ""),
          image: c.Image,
          ram,
          disk: disks.get(c.Id) ?? null,
        };
      })
    );
    out.containers.sort((a, b) => (b.ram ?? 0) - (a.ram ?? 0));
  } catch (err) {
    console.warn("[rincon-menu-checker] docker indisponível:", err.message);
  }

  return out;
}

async function fetchAgent(base) {
  const res = await fetch(new URL("/api/agent", base), {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`agente respondeu ${res.status}`);
  return res.json();
}

let systemCache = null;

async function collectSystem() {
  if (systemCache && Date.now() - systemCache.at < SYSTEM_CACHE_TTL_MS) return systemCache.data;
  const machines = {};
  await Promise.all([
    MACHINE_ID && collectLocal().then((m) => (machines[MACHINE_ID] = m)),
    ...REMOTE_AGENTS.map(([id, base]) =>
      fetchAgent(base)
        .then((m) => (machines[id] = m))
        .catch((err) => {
          console.warn(`[rincon-menu-checker] agente "${id}" fora:`, err.message);
          machines[id] = { error: "não foi possível falar com o agente" };
        })
    ),
  ]);
  const data = { machines, collectedAt: new Date().toISOString() };
  systemCache = { at: Date.now(), data };
  return data;
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

  if (req.method === "GET" && url.pathname === "/api/system") {
    collectSystem().then(
      (data) => sendJson(res, 200, data),
      (err) => sendJson(res, 500, { error: err.message })
    );
    return;
  }

  // Métricas só desta máquina — quem chama é o checador da máquina onde o
  // menu roda. Sem AGENT_TOKEN configurado, fica desligado.
  if (req.method === "GET" && url.pathname === "/api/agent") {
    if (!AGENT_TOKEN || req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) {
      sendJson(res, 401, { error: "token inválido" });
      return;
    }
    collectLocal().then(
      (data) => sendJson(res, 200, data),
      (err) => sendJson(res, 500, { error: err.message })
    );
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
