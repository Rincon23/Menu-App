import React, { useState, useEffect, useRef, useMemo, lazy, Suspense } from "react";
import {
  Search, Star, Moon, Sun, KeyRound, Box, RefreshCw, GitBranch,
  ExternalLink, Cpu, Server, Globe, Pin, Film, Cloud, Wallet, Video,
  Container, ChevronDown, Briefcase, Home, Database, HardDrive, Monitor,
  Music, Image, Camera, Mail, Calendar, Newspaper, BookOpen, Gamepad2,
  Code, Bot, Shield, Link, LogIn, LogOut, Pencil, Eye, EyeOff,
  GripVertical, Plus, X, Trash2, SquareTerminal,
} from "lucide-react";

// Só quem está logado e abre o terminal baixa o xterm.js.
const TerminalPanel = lazy(() => import("./TerminalPanel.jsx"));

// Ícones que dá pra usar nos links — o layout salvo guarda só o nome.
const ICONS = {
  Globe, Box, RefreshCw, GitBranch, KeyRound, Wallet, Film, Cloud, Video,
  Briefcase, Cpu, Server, Home, Database, HardDrive, Monitor, Music, Image,
  Camera, Mail, Calendar, Newspaper, BookOpen, Gamepad2, Code, Bot, Shield, Link,
};

// Layout padrão. Depois que você salva algo no modo edição (ordem, ocultar,
// adicionar), vale o layout salvo no servidor (/api/links) e esta lista só é
// usada se o checador estiver fora do ar no primeiro acesso.
const DEFAULT_GROUPS = [
  {
    id: "orangepi",
    label: "Orange Pi",
    icon: "Cpu",
    apps: [
      {
        id: "portainer",
        name: "Portainer",
        desc: "Gestão de containers Docker",
        url: "https://portainer.rincon.dev.br/#!/auth",
        domain: "portainer.rincon.dev.br",
        accent: "#17C3E6",
        icon: "Box",
      },
      {
        id: "syncthing",
        name: "Syncthing",
        desc: "Sincronização de arquivos",
        url: "https://sync-orangepi.rincon.dev.br/",
        domain: "sync-orangepi.rincon.dev.br",
        accent: "#14B8A6",
        icon: "RefreshCw",
      },
      {
        id: "n8n",
        name: "n8n",
        desc: "Automação de workflows",
        url: "https://n8n.rincon.dev.br/home/workflows",
        domain: "n8n.rincon.dev.br",
        accent: "#FF6B4A",
        icon: "GitBranch",
      },
      {
        id: "vaultwarden",
        name: "Vaultwarden",
        desc: "Cofre de senhas",
        url: "https://senhas.rincon.dev.br/#/login",
        domain: "senhas.rincon.dev.br",
        accent: "#3B6FE0",
        icon: "KeyRound",
      },
      {
        id: "capital",
        name: "Capital +",
        desc: "Orçamento mensal por categoria",
        url: "https://capital.rincon.dev.br/",
        domain: "capital.rincon.dev.br",
        accent: "#22C55E",
        icon: "Wallet",
      },
    ],
  },
  {
    id: "servidor",
    label: "Servidor",
    icon: "Server",
    apps: [
      {
        id: "portainer-server",
        name: "Portainer",
        desc: "Gestão de containers do server",
        url: "https://portainer-server.rincon.dev.br/#!/auth",
        domain: "portainer-server.rincon.dev.br",
        accent: "#17C3E6",
        icon: "Box",
      },
      {
        id: "n8n-server",
        name: "n8n",
        desc: "Automação de workflows",
        url: "https://n8n-server.rincon.dev.br/signin?redirect=%252F",
        domain: "n8n-server.rincon.dev.br",
        accent: "#FF6B4A",
        icon: "GitBranch",
      },
      {
        id: "jellyfin",
        name: "Jellyfin",
        desc: "Servidor de mídia",
        url: "https://jellyfin.rincon.dev.br/web/#/home",
        domain: "jellyfin.rincon.dev.br",
        accent: "#AA5CC3",
        icon: "Film",
      },
      {
        id: "nextcloud",
        name: "Nextcloud",
        desc: "Nuvem de arquivos pessoal",
        url: "https://cloud.rincon.dev.br/login",
        domain: "cloud.rincon.dev.br",
        accent: "#0082C9",
        icon: "Cloud",
      },
      {
        id: "syncthing-server",
        name: "Syncthing",
        desc: "Sincronização de arquivos do server",
        url: "https://sync-server.rincon.dev.br/",
        domain: "sync-server.rincon.dev.br",
        accent: "#14B8A6",
        icon: "RefreshCw",
      },
      {
        id: "live",
        name: "Live",
        desc: "Sala privada: voz, vídeo e tela",
        url: "https://live.rincon.dev.br/",
        domain: "live.rincon.dev.br",
        accent: "#E5484D",
        icon: "Video",
      },
    ],
  },
  {
    id: "rede",
    label: "Rede · sites úteis",
    icon: "Globe",
    apps: [
      {
        id: "cloudflare",
        name: "Cloudflare",
        desc: "DNS, tunnels e proxy reverso",
        url: "https://www.cloudflare.com/pt-br/",
        domain: "cloudflare.com",
        accent: "#F38020",
        icon: "Globe",
      },
      {
        id: "portfolio",
        name: "Portfólio",
        desc: "Meu portfólio no GitHub Pages",
        url: "https://rincon23.github.io/",
        domain: "rincon23.github.io",
        accent: "#8B5CF6",
        icon: "Briefcase",
      },
    ],
  },
];

// Pergunta o status dos serviços pro checador no servidor (/api/status).
// O back-end dá um curl em cada URL: se voltar a página de erro 1033 do
// Cloudflare Tunnel (ou erro de rede) = fora do ar; qualquer outra coisa = no ar.
// Vai pelo servidor porque o navegador não lê o corpo de respostas cross-origin.
async function fetchStatuses(apps, signal) {
  const res = await fetch("/api/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets: apps.map((a) => ({ id: a.id, url: a.url })) }),
    signal,
  });
  if (!res.ok) throw new Error(`checador respondeu ${res.status}`);
  const data = await res.json();
  return data.statuses || {};
}

// Métricas das máquinas (RAM, disco e containers rodando), já agrupadas pelo
// id da seção ("orangepi", "servidor"). Seção sem máquina (rede) não aparece.
async function fetchSystems(signal) {
  const res = await fetch("/api/system", { signal });
  if (!res.ok) throw new Error(`checador respondeu ${res.status}`);
  const data = await res.json();
  return data.machines || {};
}

// GET/POST/PUT em JSON; erro com a mensagem que o checador mandou.
async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `checador respondeu ${res.status}`), { status: res.status });
  return data;
}

// Último layout recebido fica no navegador, pra página abrir já na ordem
// certa (sem piscar a lista padrão enquanto /api/links responde).
const LAYOUT_KEY = "rincon-menu-layout";

function cachedLayout() {
  try {
    const groups = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (Array.isArray(groups) && groups.every((g) => Array.isArray(g.apps))) return groups;
  } catch {}
  return DEFAULT_GROUPS;
}

// Tira o app de onde está e põe no lugar do alvo (ou no fim do grupo, sem
// alvo). Arrastando pra frente ele fica depois do alvo, pra trás fica antes.
function moveApp(groups, appId, toGroupId, targetId = null) {
  const app = groups.flatMap((g) => g.apps).find((a) => a.id === appId);
  const dest = groups.find((g) => g.id === toGroupId);
  if (!app || !dest || appId === targetId) return groups;
  const index = targetId ? dest.apps.findIndex((a) => a.id === targetId) : dest.apps.length;
  return groups.map((g) => {
    const apps = g.apps.filter((a) => a.id !== appId);
    if (g.id === toGroupId) apps.splice(index === -1 ? apps.length : index, 0, app);
    return { ...g, apps };
  });
}

function updateApp(groups, appId, fn) {
  return groups.map((g) => ({ ...g, apps: g.apps.flatMap((a) => (a.id === appId ? fn(a) : [a])) }));
}

function newAppId(name) {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "link"}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatBytes(bytes) {
  if (bytes == null) return "—";
  const gb = bytes / 2 ** 30;
  if (gb >= 1024) return `${(gb / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} TB`;
  if (gb >= 1) return `${gb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(bytes / 2 ** 20)} MB`;
}

function greeting(hour) {
  if (hour < 5) return "Boa madrugada.";
  if (hour < 12) return "Bom dia.";
  if (hour < 18) return "Boa tarde.";
  return "Boa noite.";
}

function AppIcon({ app }) {
  const Icon = ICONS[app.icon] ?? Globe;
  return (
    <span className="app-icon-fallback" style={{ background: app.accent + "22", color: app.accent }}>
      <Icon size={20} strokeWidth={1.75} />
    </span>
  );
}

const STATUS_LABEL = {
  checking: "Verificando...",
  online: "Online",
  offline: "Offline",
  unknown: "Não foi possível verificar",
};

// Botão dentro do card (que é um link): não deixa o clique abrir o link.
function cardAction(fn) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
}

// No modo edição (edit != null) o card dá pra arrastar e mostra os botões de
// ocultar e editar no lugar da estrela.
function AppCard({ app, isFav, onToggleFav, status = "checking", edit }) {
  return (
    <a
      href={app.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`app-card ${edit ? "editable" : ""} ${app.hidden ? "is-hidden" : ""} ${edit?.dragging ? "dragging" : ""}`}
      style={{ "--accent": app.accent, "--accent-glow": app.accent + "33" }}
      draggable={edit ? true : undefined}
      onDragStart={edit?.onDragStart}
      onDragEnter={edit?.onDragEnter}
    >
      <div className="app-card-top">
        <AppIcon app={app} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`status-dot ${status}`} title={STATUS_LABEL[status]} />
          {edit ? (
            <>
              <button
                className="fav-btn"
                onClick={cardAction(edit.onToggleHidden)}
                title={app.hidden ? "Mostrar" : "Ocultar"}
                aria-label={app.hidden ? `Mostrar ${app.name}` : `Ocultar ${app.name}`}
              >
                {app.hidden ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
              </button>
              <button className="fav-btn" onClick={cardAction(edit.onEdit)} title="Editar" aria-label={`Editar ${app.name}`}>
                <Pencil size={14} strokeWidth={1.75} />
              </button>
              <GripVertical size={15} className="grip" aria-hidden="true" />
            </>
          ) : (
            <button
              className={`fav-btn ${isFav ? "active" : ""}`}
              onClick={cardAction(() => onToggleFav(app.id))}
              aria-label={isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"}
            >
              <Star size={15} fill={isFav ? "currentColor" : "none"} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      <div>
        <p className="app-name">{app.name}</p>
        <p className="app-desc">{app.desc}</p>
      </div>
      <span className="app-domain">
        <ExternalLink size={11} />
        {app.domain}
      </span>
    </a>
  );
}

function UsageMeter({ label, used, total }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const level = pct >= 90 ? "high" : pct >= 75 ? "mid" : "low";
  return (
    <span className="meter" title={`${label}: ${Math.round(pct)}% em uso`}>
      <span className="meter-label">{label}</span>
      <span className={`meter-bar ${level}`}><span style={{ width: `${pct}%` }} /></span>
      <span>{formatBytes(used)} / {formatBytes(total)}</span>
    </span>
  );
}

function MachineStats({ sys, open, onToggle }) {
  if (sys.error) return <span className="meter unavailable">métricas indisponíveis</span>;
  return (
    <div className="machine-stats">
      {sys.ram && <UsageMeter label="RAM" {...sys.ram} />}
      {sys.disk && <UsageMeter label="DISCO" {...sys.disk} />}
      {sys.containers && (
        <button
          className="containers-btn"
          onClick={onToggle}
          aria-expanded={open}
          title={`${sys.containers.length} containers rodando`}
          aria-label={`${open ? "Esconder" : "Mostrar"} ${sys.containers.length} containers`}
        >
          <Container size={12} />
          {sys.containers.length}
          <ChevronDown size={12} className={open ? "flip" : ""} />
        </button>
      )}
    </div>
  );
}

function ContainerList({ containers }) {
  return (
    <div className="containers">
      <div className="containers-row containers-head">
        <span className="c-name">container</span><span>ram</span><span>disco</span>
      </div>
      {containers.map((c) => (
        <div className="containers-row" key={c.name}>
          <span className="c-name" title={c.image}>{c.name}</span>
          <span>{formatBytes(c.ram)}</span>
          <span>{formatBytes(c.disk)}</span>
        </div>
      ))}
    </div>
  );
}

function Dialog({ title, onClose, children }) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <span className="section-title">{title.toUpperCase()}</span>
          <button className="theme-btn" onClick={onClose} aria-label="Fechar">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// totp: o checador pede também o código de 2 fatores (ADMIN_TOTP_SECRET).
function LoginDialog({ totp, onClose, onLoggedIn }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { method: "POST", body: { password, code } });
      onLoggedIn();
    } catch (err) {
      setError(err.message);
      setCode("");
      setBusy(false);
    }
  }

  return (
    <Dialog title="Entrar" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>senha</span>
          <input
            className="search-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {totp && (
          <label className="field">
            <span>código do autenticador (2FA)</span>
            <input
              className="search-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button className="btn primary" disabled={busy || !password || (totp && code.length !== 6)}>
            {busy ? "entrando..." : "entrar"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Adicionar (app == null) ou editar um link.
function AppDialog({ groups, groupId, app, onSave, onDelete, onClose }) {
  const [form, setForm] = useState(() => ({
    name: app?.name ?? "",
    desc: app?.desc ?? "",
    url: app?.url ?? "https://",
    groupId,
    icon: app?.icon ?? "Globe",
    accent: app?.accent ?? "#3B6FE0",
  }));
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  function submit(e) {
    e.preventDefault();
    let url;
    try {
      url = new URL(form.url.trim());
    } catch {
      return setError("URL inválida");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return setError("a URL precisa começar com http:// ou https://");
    onSave(
      {
        ...app,
        id: app?.id ?? newAppId(form.name),
        name: form.name.trim(),
        desc: form.desc.trim(),
        url: url.href,
        domain: url.hostname,
        icon: form.icon,
        accent: form.accent,
      },
      form.groupId
    );
  }

  return (
    <Dialog title={app ? "Editar link" : "Adicionar link"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>nome</span>
          <input className="search-input" required maxLength={80} autoFocus value={form.name} onChange={set("name")} />
        </label>
        <label className="field">
          <span>descrição</span>
          <input className="search-input" maxLength={200} value={form.desc} onChange={set("desc")} />
        </label>
        <label className="field">
          <span>url</span>
          <input className="search-input" required maxLength={2000} value={form.url} onChange={set("url")} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>seção</span>
            <select className="search-input" value={form.groupId} onChange={set("groupId")}>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
          </label>
          <label className="field color-field">
            <span>cor</span>
            <input type="color" value={form.accent} onChange={set("accent")} />
          </label>
        </div>
        <div className="field">
          <span>ícone</span>
          <div className="icon-picker">
            {Object.entries(ICONS).map(([name, Icon]) => (
              <button
                type="button"
                key={name}
                className={form.icon === name ? "active" : ""}
                onClick={() => setForm((f) => ({ ...f, icon: name }))}
                aria-label={name}
                aria-pressed={form.icon === name}
              >
                <Icon size={16} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          {app && (
            <button type="button" className="btn danger" onClick={onDelete}>
              <Trash2 size={13} /> excluir
            </button>
          )}
          <button className="btn primary">salvar</button>
        </div>
      </form>
    </Dialog>
  );
}

export default function RinconMenu() {
  const [theme, setTheme] = useState("dark");
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [statuses, setStatuses] = useState({});
  const [systems, setSystems] = useState({});
  const [openContainers, setOpenContainers] = useState(() => new Set());
  const [groups, setGroups] = useState(cachedLayout);
  const [me, setMe] = useState({ admin: false, loginEnabled: false, totp: false, terminals: [] });
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState(null);
  // { type: "login" } | { type: "app", groupId, app? }
  const [dialog, setDialog] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const [notice, setNotice] = useState("");
  const searchRef = useRef(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const dragStartRef = useRef(null);
  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  const allApps = useMemo(() => groups.flatMap((g) => g.apps), [groups]);
  const appsRef = useRef(allApps);
  appsRef.current = allApps;
  // Só refaz a checagem de status quando muda a lista de URLs (não a ordem).
  const statusKey = allApps.map((a) => `${a.id} ${a.url}`).sort().join("\n");

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(groups));
    } catch {}
  }, [groups]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // Quem sou eu (logado?) e o layout salvo. Roda de novo depois de entrar/sair,
  // porque logado o layout vem com os links ocultos.
  async function loadSession(signal) {
    try {
      const [session, links] = await Promise.all([api("/api/me", { signal }), api("/api/links", { signal })]);
      setMe(session);
      setGroups(links.groups ?? DEFAULT_GROUPS);
      if (!session.admin) setEditing(false);
    } catch (err) {
      if (err.name !== "AbortError") console.warn("checador indisponível:", err.message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setLoaded(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function runChecks() {
      const allApps = appsRef.current;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const app of allApps) if (!next[app.id]) next[app.id] = "checking";
        return next;
      });
      try {
        const result = await fetchStatuses(allApps, controller.signal);
        setStatuses(() => {
          const next = {};
          for (const app of allApps) next[app.id] = result[app.id] || "unknown";
          return next;
        });
      } catch (err) {
        if (err.name === "AbortError") return;
        console.warn("checador de status indisponível:", err.message);
        // Mantém o último status conhecido; só marca "unknown" o que nunca
        // chegou a ser verificado (assim um tropeço passageiro não zera tudo).
        setStatuses((prev) => {
          const next = { ...prev };
          for (const app of allApps) {
            if (!next[app.id] || next[app.id] === "checking") next[app.id] = "unknown";
          }
          return next;
        });
      }
    }

    runChecks();
    const t = setInterval(runChecks, 60000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [statusKey]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSystems() {
      try {
        setSystems(await fetchSystems(controller.signal));
      } catch (err) {
        // Mantém os últimos números conhecidos se o checador tropeçar.
        if (err.name !== "AbortError") console.warn("métricas indisponíveis:", err.message);
      }
    }

    loadSystems();
    const t = setInterval(loadSystems, 30000);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "/" ) {
        const tag = document.activeElement?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          searchRef.current?.focus();
        }
      }
      if (e.key === "Escape") {
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function toggleFavorite(id) {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleContainers(groupId) {
    setOpenContainers((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  async function logout() {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    setMe((m) => ({ ...m, admin: false, terminals: [] }));
    setEditing(false);
    setTerminal(null);
    loadSession();
  }

  // Mostra na hora e salva no servidor; se falhar, avisa e recarrega o que
  // está salvo lá.
  async function persist(next) {
    setGroups(next);
    try {
      await api("/api/links", { method: "PUT", body: { groups: next } });
    } catch (err) {
      setNotice(`Não salvou: ${err.message}`);
      loadSession();
    }
  }

  function saveApp(app, groupId) {
    const from = groups.find((g) => g.apps.some((a) => a.id === app.id));
    let next = from
      ? updateApp(groups, app.id, () => [app])
      : groups.map((g) => (g.id === groupId ? { ...g, apps: [...g.apps, app] } : g));
    if (from && from.id !== groupId) next = moveApp(next, app.id, groupId);
    persist(next);
    setDialog(null);
  }

  function deleteApp(app) {
    if (!window.confirm(`Excluir "${app.name}"? (pra só esconder, use o olho)`)) return;
    persist(updateApp(groups, app.id, () => []));
    setDialog(null);
  }

  // Arrastar: o card muda de lugar ao passar por cima dos outros (ou do "+"
  // no fim de uma seção) e o layout é salvo ao soltar.
  function dragTo(groupId, targetId) {
    if (dragId) setGroups((g) => moveApp(g, dragId, groupId, targetId));
  }

  function endDrag() {
    setDragId(null);
    if (JSON.stringify(dragStartRef.current) !== JSON.stringify(groupsRef.current)) persist(groupsRef.current);
  }

  function editProps(app, groupId) {
    return {
      dragging: dragId === app.id,
      onDragStart: (e) => {
        dragStartRef.current = groups;
        setDragId(app.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", app.name);
        // Listener nativo, não o onDragEnd do React: quando o card muda de
        // seção o React troca o elemento, e o dragend do original (que saiu
        // da página) não chega mais no React.
        e.currentTarget.addEventListener("dragend", endDrag, { once: true });
      },
      onDragEnter: () => dragTo(groupId, app.id),
      onToggleHidden: () => persist(updateApp(groups, app.id, (a) => [{ ...a, hidden: !a.hidden }])),
      onEdit: () => setDialog({ type: "app", groupId, app }),
    };
  }

  const q = query.trim().toLowerCase();
  const matches = (app) =>
    (editing || !app.hidden) &&
    (!q || app.name.toLowerCase().includes(q) || app.desc.toLowerCase().includes(q));

  const filteredGroups = groups.map((g) => ({
    ...g,
    apps: g.apps.filter(matches),
  })).filter((g) => g.apps.length > 0 || editing);

  const pinned = allApps.filter((a) => favorites.has(a.id) && matches(a));

  const visibleApps = allApps.filter((a) => !a.hidden);
  const totalVisible = filteredGroups.reduce((n, g) => n + g.apps.length, 0);
  const onlineCount = visibleApps.filter((a) => statuses[a.id] === "online").length;
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className={`rincon-root ${theme} ${reduceMotion ? "reduce-motion" : ""}`}
      data-theme={theme}
      // Durante o arraste a página toda aceita o "soltar" (senão o Firefox
      // tenta abrir o link arrastado).
      onDragOver={(e) => dragId && e.preventDefault()}
      onDrop={(e) => dragId && e.preventDefault()}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

        .rincon-root {
          --bg: #090c10;
          --bg-2: #0d1218;
          --panel: rgba(255,255,255,0.035);
          --panel-border: rgba(255,255,255,0.08);
          --panel-hover-border: rgba(255,255,255,0.16);
          --text: #edeff4;
          --text-muted: #838ca0;
          --text-faint: #545c6e;
          --online: #34d399;
          --shadow: 0 20px 50px -20px rgba(0,0,0,0.6);
          font-family: 'IBM Plex Sans', -apple-system, sans-serif;
          background: radial-gradient(120% 140% at 15% -10%, #131a24 0%, var(--bg) 45%), var(--bg);
          color: var(--text);
          min-height: 100vh;
          width: 100%;
          box-sizing: border-box;
          padding: 56px 28px 40px;
          position: relative;
          overflow-x: hidden;
        }
        .rincon-root.light {
          --bg: #ffffff;
          --bg-2: #a3a3a3;
          --panel: rgba(20,20,20,0.03);
          --panel-border: rgba(20,20,20,0.09);
          --panel-hover-border: rgba(20,20,20,0.2);
          --text: #16181d;
          --text-muted: #6b7284;
          --text-faint: #9aa0ae;
          --shadow: 0 20px 40px -24px rgba(20,20,30,0.25);
          background: radial-gradient(120% 140% at 15% -10%, #c4c4c4 0%, var(--bg) 55%), var(--bg);
        }
        .rincon-root * { box-sizing: border-box; }
        .rincon-shell {
          max-width: 1080px;
          margin: 0 auto;
          opacity: 0;
          transform: translateY(14px);
          transition: opacity 0.7s ease, transform 0.7s ease;
        }
        .rincon-shell.in { opacity: 1; transform: translateY(0); }
        .rincon-root.reduce-motion .rincon-shell { transition: none; }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          color: var(--text-muted);
          margin-bottom: 46px;
          letter-spacing: 0.01em;
        }
        .prompt { color: var(--text); }
        .prompt .caret { color: var(--online); }
        .topbar-right { display: flex; align-items: center; gap: 18px; }
        .clock { color: var(--text-muted); }
        .theme-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 30px; height: 30px;
          border-radius: 7px;
          border: 1px solid var(--panel-border);
          background: var(--panel);
          color: var(--text-muted);
          cursor: pointer;
          transition: border-color 0.2s ease, color 0.2s ease;
        }
        .theme-btn:hover { color: var(--text); border-color: var(--panel-hover-border); }
        .theme-btn:focus-visible, .search-input:focus-visible, .app-card:focus-visible, .fav-btn:focus-visible {
          outline: 2px solid var(--online);
          outline-offset: 2px;
        }

        .greeting {
          font-size: 30px;
          font-weight: 600;
          letter-spacing: -0.01em;
          margin: 0 0 6px;
        }
        .greeting-sub {
          font-size: 14.5px;
          color: var(--text-muted);
          margin: 0 0 34px;
        }
        .greeting-sub .count { color: var(--online); font-family: 'IBM Plex Mono', monospace; }

        .search-wrap {
          position: relative;
          margin-bottom: 40px;
        }
        .search-input {
          width: 100%;
          background: var(--panel);
          border: 1px solid var(--panel-border);
          border-radius: 10px;
          padding: 13px 46px 13px 16px;
          color: var(--text);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13.5px;
          transition: border-color 0.2s ease, background 0.2s ease;
        }
        .search-input::placeholder { color: var(--text-faint); }
        .search-input:focus { border-color: var(--panel-hover-border); background: var(--bg-2); outline: none; }
        .search-icon { position: absolute; right: 44px; top: 50%; transform: translateY(-50%); color: var(--text-faint); pointer-events: none; }
        .search-hint {
          position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-faint);
          border: 1px solid var(--panel-border); border-radius: 5px; padding: 2px 6px;
          pointer-events: none;
        }

        .section { margin-bottom: 38px; }
        .section-head {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 14px;
          color: var(--text-muted);
        }
        .section-head .count-badge {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-faint);
        }
        .section-title {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          letter-spacing: 0.02em;
          color: var(--text-muted);
        }
        .section-line {
          flex: 1;
          min-width: 24px;
          height: 1px;
          background: var(--panel-border);
        }

        .machine-stats { display: flex; align-items: center; gap: 14px; }
        .meter {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          white-space: nowrap;
        }
        .meter-label { color: var(--text-faint); }
        .meter.unavailable { color: #fbbf24; }
        .meter-bar {
          width: 44px; height: 4px;
          border-radius: 2px;
          background: var(--panel-border);
          overflow: hidden;
        }
        .meter-bar > span { display: block; height: 100%; border-radius: 2px; background: var(--online); }
        .meter-bar.mid > span { background: #fbbf24; }
        .meter-bar.high > span { background: #f87171; }
        .containers-btn {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-muted);
          background: var(--panel);
          border: 1px solid var(--panel-border);
          border-radius: 6px;
          padding: 3px 7px;
          cursor: pointer;
          transition: border-color 0.2s ease, color 0.2s ease;
        }
        .containers-btn:hover { color: var(--text); border-color: var(--panel-hover-border); }
        .containers-btn:focus-visible { outline: 2px solid var(--online); outline-offset: 2px; }
        .containers-btn .flip { transform: rotate(180deg); }

        .containers {
          background: var(--panel);
          border: 1px solid var(--panel-border);
          border-radius: 10px;
          padding: 8px 14px;
          margin-bottom: 14px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
        }
        .containers-row {
          display: grid;
          grid-template-columns: 1fr 80px 80px;
          gap: 12px;
          padding: 5px 0;
          border-bottom: 1px solid var(--panel-border);
        }
        .containers-row:last-child { border-bottom: none; }
        .containers-row > span:not(.c-name) { text-align: right; color: var(--text-muted); }
        .containers-head { font-size: 10.5px; color: var(--text-faint); }
        .containers-head > span:not(.c-name) { color: var(--text-faint); }
        .c-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 14px;
        }

        .app-card {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 14px;
          background: var(--panel);
          border: 1px solid var(--panel-border);
          border-radius: 12px;
          padding: 18px 18px 16px;
          text-decoration: none;
          color: var(--text);
          backdrop-filter: blur(14px);
          overflow: hidden;
          transition: transform 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease;
        }
        .app-card::before {
          content: "";
          position: absolute;
          left: 0; top: 0; bottom: 0;
          width: 3px;
          background: var(--accent);
          opacity: 0.7;
        }
        .app-card:hover, .app-card:focus-visible {
          transform: translateY(-3px);
          border-color: var(--panel-hover-border);
          box-shadow: var(--shadow), 0 0 0 1px var(--accent-glow) inset;
        }
        .rincon-root.reduce-motion .app-card { transition: none; }
        .rincon-root.reduce-motion .app-card:hover { transform: none; }

        .app-card-top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
        }
        .app-icon-fallback {
          width: 30px; height: 30px;
          border-radius: 7px;
          display: flex; align-items: center; justify-content: center;
        }
        .status-dot {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: var(--online);
          margin-top: 4px;
          box-shadow: 0 0 0 3px rgba(52,211,153,0.15);
        }
        .status-dot.offline {
          background: #f87171;
          box-shadow: 0 0 0 3px rgba(248,113,113,0.15);
        }
        .status-dot.checking {
          background: var(--text-faint);
          box-shadow: 0 0 0 3px rgba(120,120,120,0.12);
        }
        .status-dot.unknown {
          background: #fbbf24;
          box-shadow: 0 0 0 3px rgba(251,191,36,0.15);
        }
        .rincon-root:not(.reduce-motion) .status-dot.online,
        .rincon-root:not(.reduce-motion) .status-dot.checking { animation: pulse 2.6s ease-in-out infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }

        .app-name { font-size: 15px; font-weight: 600; margin: 0; }
        .app-desc { font-size: 12.5px; color: var(--text-muted); margin: 0; line-height: 1.4; }
        .app-domain {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          color: var(--text-faint);
          display: flex;
          align-items: center;
          gap: 5px;
          margin-top: auto;
        }

        .fav-btn {
          background: none; border: none; cursor: pointer;
          color: var(--text-faint);
          display: flex; align-items: center; justify-content: center;
          padding: 2px;
          transition: color 0.2s ease, transform 0.15s ease;
        }
        .fav-btn:hover { color: #fbbf24; transform: scale(1.12); }
        .fav-btn.active { color: #fbbf24; }

        .empty-state {
          padding: 30px 4px;
          color: var(--text-muted);
          font-size: 13.5px;
          font-family: 'IBM Plex Mono', monospace;
        }

        .footer {
          margin-top: 20px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11.5px;
          color: var(--text-faint);
          display: flex;
          justify-content: space-between;
        }

        /* --- logado: modo edição, diálogos e terminal --- */
        .theme-btn.active { color: var(--online); border-color: var(--online); }
        .edit-hint {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--text-muted);
          margin: -24px 0 30px;
          line-height: 1.7;
        }
        .edit-hint svg { vertical-align: -2px; }
        .app-card.editable { cursor: grab; }
        .app-card.is-hidden { opacity: 0.45; border-style: dashed; }
        .app-card.dragging { opacity: 0.3; }
        .grip { color: var(--text-faint); }
        .add-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 132px;
          border: 1px dashed var(--panel-border);
          border-radius: 12px;
          background: none;
          color: var(--text-faint);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          cursor: pointer;
          transition: border-color 0.2s ease, color 0.2s ease;
        }
        .add-card:hover { color: var(--text); border-color: var(--panel-hover-border); }
        .add-card:focus-visible, .btn:focus-visible, .icon-picker button:focus-visible {
          outline: 2px solid var(--online);
          outline-offset: 2px;
        }

        .overlay {
          position: fixed;
          inset: 0;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          background: rgba(0,0,0,0.55);
          backdrop-filter: blur(4px);
        }
        .dialog {
          width: 100%;
          max-width: 440px;
          max-height: 100%;
          overflow-y: auto;
          background: var(--bg);
          border: 1px solid var(--panel-border);
          border-radius: 12px;
          padding: 16px 18px 18px;
          box-shadow: var(--shadow);
        }
        .dialog-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .form { display: flex; flex-direction: column; gap: 12px; }
        .field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
        .field > span { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-faint); }
        .field .search-input { padding: 9px 12px; }
        .field-row { display: flex; gap: 12px; }
        .color-field { flex: 0 0 auto; }
        .color-field input {
          width: 52px; height: 37px;
          padding: 3px;
          border: 1px solid var(--panel-border);
          border-radius: 10px;
          background: var(--panel);
          cursor: pointer;
        }
        .icon-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 6px; }
        .icon-picker button {
          height: 34px;
          display: flex; align-items: center; justify-content: center;
          border: 1px solid var(--panel-border);
          border-radius: 7px;
          background: var(--panel);
          color: var(--text-muted);
          cursor: pointer;
        }
        .icon-picker button.active { color: var(--online); border-color: var(--online); }
        .form-error { margin: 0; font-size: 12.5px; color: #f87171; }
        .form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
        .btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12.5px;
          padding: 8px 14px;
          border-radius: 8px;
          border: 1px solid var(--panel-border);
          background: var(--panel);
          color: var(--text);
          cursor: pointer;
        }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .btn.primary { background: var(--online); border-color: var(--online); color: #06281c; font-weight: 500; }
        .btn.danger { color: #f87171; margin-right: auto; }

        .term-panel {
          width: 100%;
          max-width: 1100px;
          height: min(80vh, 720px);
          display: flex;
          flex-direction: column;
          background: #090c10;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          overflow: hidden;
          box-shadow: var(--shadow);
        }
        .term-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px 8px 14px;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          color: #edeff4;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .term-head .prompt { color: inherit; }
        .term-box { flex: 1; min-height: 0; padding: 8px 4px 4px 10px; }

        .notice {
          position: fixed;
          left: 50%; bottom: 22px;
          transform: translateX(-50%);
          z-index: 60;
          max-width: calc(100% - 32px);
          padding: 10px 14px;
          border-radius: 9px;
          border: 1px solid rgba(248,113,113,0.4);
          background: var(--bg);
          color: #f87171;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12.5px;
          box-shadow: var(--shadow);
        }

        @media (max-width: 640px) {
          .rincon-root { padding: 36px 18px 30px; }
          .greeting { font-size: 25px; }
          .grid { grid-template-columns: 1fr; }
          .section-head { flex-wrap: wrap; }
          .machine-stats { width: 100%; flex-wrap: wrap; gap: 8px 14px; }
        }
      `}</style>

      <div className={`rincon-shell ${loaded ? "in" : ""}`}>
        <div className="topbar">
          <span className="prompt">menuapp@rincon<span className="caret">:~$</span></span>
          <div className="topbar-right">
            <span className="clock">{timeStr}</span>
            {me.admin ? (
              <>
                <button
                  className={`theme-btn ${editing ? "active" : ""}`}
                  onClick={() => setEditing((v) => !v)}
                  aria-pressed={editing}
                  aria-label={editing ? "Sair do modo edição" : "Editar links"}
                  title={editing ? "Sair do modo edição" : "Editar links"}
                >
                  <Pencil size={14} />
                </button>
                <button className="theme-btn" onClick={logout} aria-label="Sair" title="Sair">
                  <LogOut size={15} />
                </button>
              </>
            ) : (
              <button className="theme-btn" onClick={() => setDialog({ type: "login" })} aria-label="Entrar" title="Entrar">
                <LogIn size={15} />
              </button>
            )}
            <button
              className="theme-btn"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              aria-label={theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro"}
            >
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>

        <h1 className="greeting">{greeting(now.getHours())}</h1>
        <p className="greeting-sub">
          <span className="count">{onlineCount}</span>/{visibleApps.length} serviços no ar em {groups.length} grupos
        </p>

        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search-input"
            type="text"
            placeholder="buscar serviço..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar aplicativo"
          />
          <Search size={15} className="search-icon" />
          {!query && <span className="search-hint">/</span>}
        </div>

        {editing && (
          <p className="edit-hint">
            modo edição · arraste os cards pra mudar a ordem (ou de seção) · <Eye size={12} /> oculta pra quem não
            está logado · <Pencil size={12} /> edita · <Plus size={12} /> adiciona — tudo salva na hora
          </p>
        )}

        {totalVisible === 0 && !editing && (
          <div className="empty-state">nenhum serviço encontrado para "{query}"</div>
        )}

        {pinned.length > 0 && !editing && (
          <div className="section">
            <div className="section-head">
              <Pin size={13} />
              <span className="section-title">FIXADOS</span>
              <span className="count-badge">{pinned.length}</span>
              <div className="section-line" />
            </div>
            <div className="grid">
              {pinned.map((app) => (
                <AppCard key={app.id} app={app} isFav={favorites.has(app.id)} onToggleFav={toggleFavorite} status={statuses[app.id] || "checking"} />
              ))}
            </div>
          </div>
        )}

        {filteredGroups.map((group) => {
          const sys = systems[group.id];
          const showContainers = openContainers.has(group.id) && sys?.containers;
          const GroupIcon = ICONS[group.icon] ?? Globe;
          return (
            <div className="section" key={group.id}>
              <div className="section-head">
                <GroupIcon size={13} />
                <span className="section-title">{group.label.toUpperCase()}</span>
                <span className="count-badge">{group.apps.length}</span>
                <div className="section-line" />
                {me.terminals.includes(group.id) && (
                  <button
                    className="containers-btn"
                    onClick={() => setTerminal(group.id)}
                    title="Abrir terminal"
                    aria-label={`Abrir terminal — ${group.label}`}
                  >
                    <SquareTerminal size={12} />
                    terminal
                  </button>
                )}
                {sys && (
                  <MachineStats
                    sys={sys}
                    open={openContainers.has(group.id)}
                    onToggle={() => toggleContainers(group.id)}
                  />
                )}
              </div>
              {showContainers && <ContainerList containers={sys.containers} />}
              <div className="grid">
                {group.apps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    isFav={favorites.has(app.id)}
                    onToggleFav={toggleFavorite}
                    status={statuses[app.id] || "checking"}
                    edit={editing ? editProps(app, group.id) : null}
                  />
                ))}
                {editing && (
                  <button
                    className="add-card"
                    onClick={() => setDialog({ type: "app", groupId: group.id })}
                    onDragEnter={() => dragTo(group.id, null)}
                  >
                    <Plus size={18} />
                    adicionar link
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="footer">
          <span>Rincon · Painel Pessoal</span>
          <span>{now.getFullYear()}</span>
        </div>
      </div>

      {dialog?.type === "login" && (
        <LoginDialog
          totp={me.totp}
          onClose={() => setDialog(null)}
          onLoggedIn={() => {
            setDialog(null);
            loadSession();
          }}
        />
      )}
      {dialog?.type === "app" && (
        <AppDialog
          groups={groups}
          groupId={dialog.groupId}
          app={dialog.app}
          onSave={saveApp}
          onDelete={() => deleteApp(dialog.app)}
          onClose={() => setDialog(null)}
        />
      )}
      {terminal && (
        <Suspense fallback={null}>
          <TerminalPanel
            machine={terminal}
            label={groups.find((g) => g.id === terminal)?.label ?? terminal}
            onClose={() => setTerminal(null)}
          />
        </Suspense>
      )}
      {notice && <div className="notice" role="status">{notice}</div>}
    </div>
  );
}
