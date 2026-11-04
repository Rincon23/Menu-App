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
// GET /api/system, o login do dono (/api/login), o layout dos links salvo
// pelo modo edição (/api/links) e o terminal das máquinas (WebSocket em
// /api/terminal) — ver as seções mais abaixo.

// Marcadores das páginas de erro que aparecem quando o serviço de origem caiu
// mas o proxy/túnel continua no ar (container parado, nginx sem upstream...).
const TUNNEL_DOWN_RE = /cloudflare tunnel error|error 1033|error code:\s*10\d\d|unable to resolve it|bad gateway|web server is down/i;

// Status HTTP que Cloudflare / proxy reverso devolve quando a origem está fora
// do ar (não é erro do serviço em si, é o serviço não respondendo).
const ORIGIN_DOWN_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { statfs, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket } from "ws";
import { decodeBase32, verifyTotp } from "./totp.js";
import { parseHash, verifyPassword } from "./password.js";

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
const MAX_TARGETS = 200;

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
// Containers descartáveis do terminal (ver seção "Terminal") — não entram na lista.
const TERMINAL_LABEL = "rincon-menu.terminal";

function dockerRequest(method, path, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path,
        timeout: timeoutMs,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode > 299) {
            let msg = data.trim();
            try {
              msg = JSON.parse(data).message || msg;
            } catch {}
            return reject(new Error(`docker ${path} respondeu ${res.statusCode}${msg ? `: ${msg}` : ""}`));
          }
          if (!data) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`docker ${path} demorou demais`)));
    req.on("error", reject);
    req.end(payload);
  });
}

const dockerGet = (path, timeoutMs) => dockerRequest("GET", path, undefined, timeoutMs);

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
      list
        .filter((c) => !c.Labels?.[TERMINAL_LABEL])
        .map(async (c) => {
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

// --- Login do dono -----------------------------------------------------------
// Uma senha só, guardada no .env apenas como hash (ADMIN_PASSWORD_HASH, criado
// pelo definir-senha.sh — ver password.js); sem ela o login fica desligado.
// Com ADMIN_TOTP_SECRET também pede o código de 2 fatores (ver totp.js).
// Logado dá pra reorganizar / ocultar / adicionar links e abrir o terminal.
// A sessão é um cookie assinado com HMAC, sem banco: "<expira-em-ms>.<assinatura>".
// A chave do HMAC fica no volume de dados (SESSION_KEY_FILE), não no .env:
// quem conseguir só o .env não forja uma sessão. Trocar a senha ou a chave
// 2FA derruba todas as sessões abertas.
const ADMIN_PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || "").trim();
const PASSWORD_HASH = ADMIN_PASSWORD_HASH ? parseHash(ADMIN_PASSWORD_HASH) : null;
const ADMIN_TOTP_SECRET = (process.env.ADMIN_TOTP_SECRET || "").trim();
const TOTP_KEY = ADMIN_TOTP_SECRET ? decodeBase32(ADMIN_TOTP_SECRET) : null;
/** @type {Buffer | null} carregada antes do server.listen */
let sessionKey = null;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

/** @type {Map<string, { count: number, first: number }>} */
const loginFails = new Map();
// Último passo de 30s cujo código já entrou: o mesmo código não serve 2 vezes.
let lastTotpStep = 0;

function loginProblem() {
  if (!ADMIN_PASSWORD_HASH) return "login desligado: defina a senha com ./definir-senha.sh no Orange Pi";
  if (!PASSWORD_HASH) return "login desligado: ADMIN_PASSWORD_HASH inválida no .env";
  if (ADMIN_TOTP_SECRET && !TOTP_KEY) return "login desligado: ADMIN_TOTP_SECRET inválida no .env";
  return null;
}

// Compara em tempo constante (não vaza pelo tempo de resposta quantos
// caracteres da senha/token batem).
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function sign(value) {
  return createHmac("sha256", sessionKey)
    .update(`${ADMIN_PASSWORD_HASH}:${ADMIN_TOTP_SECRET}:${value}`)
    .digest("base64url");
}

function isAdmin(req) {
  if (loginProblem() || !sessionKey) return false;
  const m = /(?:^|;\s*)rm_session=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  return Number(exp) > Date.now() && !!sig && safeEqual(sig, sign(exp));
}

function sessionCookie(req, value, maxAgeSec) {
  // "Secure" só quando veio por HTTPS (Cloudflare) — acessando pelo IP da rede
  // local em http o navegador descartaria o cookie.
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `rm_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

// Recusa requisições disparadas por outro site — inclusive outros
// *.rincon.dev.br, que contam como "mesmo site" pro SameSite do cookie.
function sameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  return req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "?";
}

// Depois de MAX_LOGIN_FAILS senhas erradas, o IP fica 15 min sem tentar.
function loginLocked(ip) {
  const f = loginFails.get(ip);
  if (f && Date.now() - f.first > LOGIN_LOCK_MS) loginFails.delete(ip);
  return (loginFails.get(ip)?.count ?? 0) >= MAX_LOGIN_FAILS;
}

function loginFailed(ip) {
  if (loginFails.size > 1000) loginFails.clear();
  const f = loginFails.get(ip) ?? { count: 0, first: Date.now() };
  f.count++;
  loginFails.set(ip, f);
}

function agentAuthorized(req) {
  return !!AGENT_TOKEN && safeEqual(req.headers.authorization || "", `Bearer ${AGENT_TOKEN}`);
}

// --- Layout dos links --------------------------------------------------------
// Ordem, links ocultos e links adicionados pelo modo edição ficam em
// DATA_DIR/links.json (volume do Docker). Enquanto nada for salvo, GET devolve
// null e o front usa a lista padrão do RinconMenu.jsx.
const DATA_DIR = process.env.DATA_DIR || "./data";
const LINKS_FILE = path.join(DATA_DIR, "links.json");
const SESSION_KEY_FILE = path.join(DATA_DIR, "session.key");

const ID_RE = /^[a-z0-9-]{1,60}$/;
const ICON_RE = /^[A-Za-z0-9]{1,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const isStr = (v, max) => typeof v === "string" && v.length <= max;

async function loadLinks() {
  try {
    return JSON.parse(await readFile(LINKS_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function saveLinks(groups) {
  await mkdir(DATA_DIR, { recursive: true });
  // Grava num temporário e renomeia: nunca fica um arquivo pela metade.
  await writeFile(`${LINKS_FILE}.tmp`, JSON.stringify(groups, null, 2));
  await rename(`${LINKS_FILE}.tmp`, LINKS_FILE);
}

// Valida o layout vindo do front e guarda só os campos conhecidos. A URL
// precisa ser http(s) (nada de "javascript:") e a cor um hex, porque as duas
// vão direto pro HTML.
function cleanGroups(input) {
  if (!Array.isArray(input) || input.length > 20) return null;
  const groupIds = new Set();
  const appIds = new Set();
  const groups = [];
  for (const g of input) {
    if (!g || !ID_RE.test(g.id) || groupIds.has(g.id) || !isStr(g.label, 80) || !ICON_RE.test(g.icon)) return null;
    if (!Array.isArray(g.apps) || g.apps.length > 100) return null;
    groupIds.add(g.id);
    const apps = [];
    for (const a of g.apps) {
      if (!a || !ID_RE.test(a.id) || appIds.has(a.id) || !isStr(a.name, 80) || !isStr(a.desc, 200)) return null;
      if (!COLOR_RE.test(a.accent) || !ICON_RE.test(a.icon) || !isStr(a.url, 2000)) return null;
      let url;
      try {
        url = new URL(a.url);
      } catch {
        return null;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      appIds.add(a.id);
      apps.push({
        id: a.id,
        name: a.name,
        desc: a.desc,
        url: url.href,
        domain: isStr(a.domain, 253) && a.domain ? a.domain : url.hostname,
        accent: a.accent,
        icon: a.icon,
        ...(a.hidden ? { hidden: true } : {}),
      });
    }
    groups.push({ id: g.id, label: g.label, icon: g.icon, apps });
  }
  return groups;
}

// --- Terminal das máquinas ---------------------------------------------------
// Shell no HOST (não no container), pelo navegador, tipo um ssh. Truque: cria
// pelo socket do Docker um container descartável, privilegiado e com
// --pid=host, que roda "nsenter -t 1" — entra nos namespaces do processo 1 do
// host e executa "su -l" lá. O Docker cuida do TTY (Tty: true), então htop,
// nano etc. funcionam. Fechou o navegador, o container é morto e se apaga
// sozinho (AutoRemove).
//
// O Servidor não tem o menu: o checador daqui repassa o WebSocket pro agente
// dele (/api/agent/terminal, protegido pelo AGENT_TOKEN), que faz o mesmo lá.
// Mensagens, iguais nos dois trechos: quem digita manda texto JSON
// { type: "input", data } / { type: "resize", cols, rows }; a saída do
// terminal volta como binário (ou texto, pros avisos de erro).
const TERMINAL_USER = process.env.TERMINAL_USER || "root";
let terminalImage = process.env.TERMINAL_IMAGE || "";

// Usa a própria imagem do checador: já está baixada, é da arquitetura certa
// e o busybox do Alpine tem nsenter. (O hostname de um container é o id dele.)
async function resolveTerminalImage() {
  terminalImage ||= (await dockerGet(`/containers/${os.hostname()}/json`)).Image;
  return terminalImage;
}

// POST /attach com "Upgrade: tcp": o Docker devolve a conexão crua do TTY.
function dockerAttach(id) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      method: "POST",
      path: `/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
    });
    req.on("upgrade", (res, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on("response", (res) => reject(new Error(`docker attach respondeu ${res.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

async function openHostShell() {
  const { Id: id } = await dockerRequest("POST", "/containers/create", {
    Image: await resolveTerminalImage(),
    Entrypoint: ["nsenter"],
    Cmd: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "su", "-l", TERMINAL_USER],
    Env: ["TERM=xterm-256color"],
    Tty: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: { [TERMINAL_LABEL]: "1" },
    HostConfig: { Privileged: true, PidMode: "host", NetworkMode: "none", AutoRemove: true },
  });
  let stream;
  try {
    stream = await dockerAttach(id);
    await dockerRequest("POST", `/containers/${id}/start`);
  } catch (err) {
    stream?.destroy();
    dockerRequest("DELETE", `/containers/${id}?force=1`).catch(() => {});
    throw err;
  }
  return {
    stream,
    handle(msg) {
      let m;
      try {
        m = JSON.parse(msg);
      } catch {
        return;
      }
      if (m.type === "input" && typeof m.data === "string") stream.write(m.data);
      if (m.type === "resize" && m.cols > 0 && m.rows > 0) {
        const q = `h=${Math.min(500, m.rows | 0)}&w=${Math.min(500, m.cols | 0)}`;
        dockerRequest("POST", `/containers/${id}/resize?${q}`).catch(() => {});
      }
    },
    close() {
      stream.destroy();
      dockerRequest("POST", `/containers/${id}/kill`).catch(() => {});
    },
  };
}

function attachLocalShell(ws) {
  let shell = null;
  // Mensagens que chegam antes do shell abrir (o primeiro resize, por exemplo).
  const early = [];
  let closed = false;
  ws.on("message", (msg) => (shell ? shell.handle(msg) : early.push(msg)));
  ws.on("close", () => {
    closed = true;
    shell?.close();
  });
  openHostShell().then(
    (s) => {
      shell = s;
      if (closed) return shell.close();
      shell.stream.on("data", (chunk) => ws.send(chunk));
      shell.stream.on("close", () => ws.close());
      shell.stream.on("error", () => ws.close());
      early.splice(0).forEach((m) => shell.handle(m));
    },
    (err) => {
      console.warn("[rincon-menu-checker] terminal não abriu:", err.message);
      if (closed) return;
      ws.send(`\r\n[não foi possível abrir o terminal: ${err.message}]\r\n`);
      ws.close();
    }
  );
}

function proxyAgentShell(ws, base) {
  const url = new URL("/api/agent/terminal", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  const early = [];
  ws.on("message", (msg, isBinary) =>
    upstream.readyState === WebSocket.OPEN ? upstream.send(msg, { binary: isBinary }) : early.push([msg, isBinary])
  );
  ws.on("close", () => upstream.terminate());
  upstream.on("open", () => early.splice(0).forEach(([msg, isBinary]) => upstream.send(msg, { binary: isBinary })));
  upstream.on("message", (msg, isBinary) => ws.send(msg, { binary: isBinary }));
  upstream.on("close", () => ws.close());
  upstream.on("error", (err) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(`\r\n[não foi possível falar com o agente: ${err.message}]\r\n`);
    ws.close();
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

function terminalHandler(req) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/agent/terminal") return agentAuthorized(req) ? attachLocalShell : 401;
  if (url.pathname !== "/api/terminal") return 404;
  if (!isAdmin(req) || !sameOrigin(req)) return 401;
  const machine = url.searchParams.get("machine");
  if (MACHINE_ID && machine === MACHINE_ID) return attachLocalShell;
  const remote = REMOTE_AGENTS.find(([id]) => id === machine);
  return remote ? (ws) => proxyAgentShell(ws, remote[1]) : 404;
}

function terminalMachines() {
  return [MACHINE_ID, ...REMOTE_AGENTS.map(([id]) => id)].filter(Boolean);
}

// --- HTTP --------------------------------------------------------------------

function sendJson(res, code, payload, headers = {}) {
  const data = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

// Lê o corpo como JSON; null se for inválido ou maior que maxBytes.
function readJson(req, maxBytes = 20000) {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      tooLarge = body.length > maxBytes;
    });
    req.on("end", () => {
      try {
        resolve(tooLarge ? null : JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

async function handle(req, res) {
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

  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/health":
      return sendJson(res, 200, { ok: true });

    case "GET /api/system":
      return sendJson(res, 200, await collectSystem());

    // Métricas só desta máquina — quem chama é o checador da máquina onde o
    // menu roda. Sem AGENT_TOKEN configurado, fica desligado.
    case "GET /api/agent":
      if (!agentAuthorized(req)) return sendJson(res, 401, { error: "token inválido" });
      return sendJson(res, 200, await collectLocal());

    case "GET /api/me": {
      const admin = isAdmin(req);
      return sendJson(res, 200, {
        admin,
        loginEnabled: !loginProblem(),
        totp: !!TOTP_KEY,
        terminals: admin ? terminalMachines() : [],
      });
    }

    case "POST /api/login": {
      const problem = loginProblem();
      if (problem) return sendJson(res, 503, { error: problem });
      const ip = clientIp(req);
      if (loginLocked(ip)) return sendJson(res, 429, { error: "muitas tentativas, espere 15 minutos" });
      const body = await readJson(req);
      const passwordOk = typeof body?.password === "string" && (await verifyPassword(PASSWORD_HASH, body.password));
      const step = TOTP_KEY ? verifyTotp(TOTP_KEY, body?.code) : null;
      const codeOk = !TOTP_KEY || (step !== null && step > lastTotpStep);
      // Não diz qual dos dois errou.
      if (!passwordOk || !codeOk) {
        loginFailed(ip);
        await sleep(500);
        return sendJson(res, 401, { error: TOTP_KEY ? "senha ou código incorreto" : "senha incorreta" });
      }
      if (TOTP_KEY) lastTotpStep = step;
      loginFails.delete(ip);
      const exp = String(Date.now() + SESSION_TTL_MS);
      const cookie = sessionCookie(req, `${exp}.${sign(exp)}`, SESSION_TTL_MS / 1000);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
    }

    case "POST /api/logout":
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });

    // Visitante não recebe os links ocultos.
    case "GET /api/links": {
      const groups = await loadLinks();
      if (!groups || isAdmin(req)) return sendJson(res, 200, { groups });
      return sendJson(res, 200, { groups: groups.map((g) => ({ ...g, apps: g.apps.filter((a) => !a.hidden) })) });
    }

    case "PUT /api/links": {
      if (!isAdmin(req) || !sameOrigin(req)) return sendJson(res, 401, { error: "faça login de novo" });
      const groups = cleanGroups((await readJson(req, 500000))?.groups);
      if (!groups) return sendJson(res, 400, { error: "layout inválido" });
      await saveLinks(groups);
      return sendJson(res, 200, { groups });
    }

    case "POST /api/status": {
      const targets = (await readJson(req))?.targets;
      if (!Array.isArray(targets)) {
        return sendJson(res, 400, { error: "corpo precisa ser { targets: [{ id, url }] }" });
      }
      const statuses = {};
      await Promise.all(
        targets.slice(0, MAX_TARGETS).map(async (t) => {
          if (!t || typeof t.id !== "string" || typeof t.url !== "string") return;
          statuses[t.id] = await probeCached(t.url);
        })
      );
      return sendJson(res, 200, { statuses, checkedAt: new Date().toISOString() });
    }

    default:
      return sendJson(res, 404, { error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.warn("[rincon-menu-checker] erro:", err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  });
});

server.on("upgrade", (req, socket, head) => {
  const open = terminalHandler(req);
  if (typeof open !== "function") {
    socket.end(`HTTP/1.1 ${open === 401 ? "401 Unauthorized" : "404 Not Found"}\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("error", () => ws.terminate());
    // Ping a cada 30s: sem tráfego, Nginx e Cloudflare derrubam a conexão.
    const ping = setInterval(() => ws.ping(), 30000);
    ws.on("close", () => clearInterval(ping));
    open(ws);
  });
});

// Chave das sessões: criada uma vez e guardada no volume (no host, só o root
// lê), pra sessão sobreviver a um ./update.sh.
async function loadSessionKey() {
  try {
    const key = await readFile(SESSION_KEY_FILE);
    if (key.length >= 32) return key;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SESSION_KEY_FILE, key, { mode: 0o600 });
  return key;
}

if (!loginProblem()) sessionKey = await loadSessionKey();

server.listen(PORT, () => {
  console.log(`[rincon-menu-checker] ouvindo em :${PORT}`);
});
