import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Search, Star, Moon, Sun, KeyRound, Box, RefreshCw, GitBranch,
  ExternalLink, Cpu, Server, Globe, Pin, Film, Cloud,
} from "lucide-react";

const GROUPS = [
  {
    id: "orangepi",
    label: "Orange Pi",
    Icon: Cpu,
    apps: [
      {
        id: "portainer",
        name: "Portainer",
        desc: "Gestão de containers Docker",
        url: "https://portainer.rincon.dev.br/#!/auth",
        domain: "portainer.rincon.dev.br",
        accent: "#17C3E6",
        Icon: Box,
      },
      {
        id: "syncthing",
        name: "Syncthing",
        desc: "Sincronização de arquivos",
        url: "https://sync-orangepi.rincon.dev.br/",
        domain: "sync-orangepi.rincon.dev.br",
        accent: "#14B8A6",
        Icon: RefreshCw,
      },
      {
        id: "n8n",
        name: "n8n",
        desc: "Automação de workflows",
        url: "https://n8n.rincon.dev.br/home/workflows",
        domain: "n8n.rincon.dev.br",
        accent: "#FF6B4A",
        Icon: GitBranch,
      },
      {
        id: "vaultwarden",
        name: "Vaultwarden",
        desc: "Cofre de senhas",
        url: "https://senhas.rincon.dev.br/#/login",
        domain: "senhas.rincon.dev.br",
        accent: "#3B6FE0",
        Icon: KeyRound,
      },
    ],
  },
  {
    id: "servidor",
    label: "Servidor",
    Icon: Server,
    apps: [
      {
        id: "portainer-server",
        name: "Portainer",
        desc: "Gestão de containers do server",
        url: "https://portainer-server.rincon.dev.br/#!/auth",
        domain: "portainer-server.rincon.dev.br",
        accent: "#17C3E6",
        Icon: Box,
      },
      {
        id: "n8n-server",
        name: "n8n",
        desc: "Automação de workflows",
        url: "https://n8n-server.rincon.dev.br/signin?redirect=%252F",
        domain: "n8n-server.rincon.dev.br",
        accent: "#FF6B4A",
        Icon: GitBranch,
      },
      {
        id: "jellyfin",
        name: "Jellyfin",
        desc: "Servidor de mídia",
        url: "https://jellyfin.rincon.dev.br/web/#/home",
        domain: "jellyfin.rincon.dev.br",
        accent: "#AA5CC3",
        Icon: Film,
      },
      {
        id: "nextcloud",
        name: "Nextcloud",
        desc: "Nuvem de arquivos pessoal",
        url: "https://cloud.rincon.dev.br/login",
        domain: "cloud.rincon.dev.br",
        accent: "#0082C9",
        Icon: Cloud,
      },
      {
        id: "syncthing-server",
        name: "Syncthing",
        desc: "Sincronização de arquivos do server",
        url: "https://sync-server.rincon.dev.br/",
        domain: "sync-server.rincon.dev.br",
        accent: "#14B8A6",
        Icon: RefreshCw,
      },
    ],
  },
  {
    id: "rede",
    label: "Rede · sites úteis",
    Icon: Globe,
    apps: [
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

function greeting(hour) {
  if (hour < 5) return "Boa madrugada.";
  if (hour < 12) return "Bom dia.";
  if (hour < 18) return "Boa tarde.";
  return "Boa noite.";
}

function AppIcon({ app }) {
  const { Icon } = app;
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

function AppCard({ app, isFav, onToggleFav, status = "checking" }) {
  return (
    <a
      href={app.url}
      target="_blank"
      rel="noopener noreferrer"
      className="app-card"
      style={{ "--accent": app.accent, "--accent-glow": app.accent + "33" }}
    >
      <div className="app-card-top">
        <AppIcon app={app} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`status-dot ${status}`} title={STATUS_LABEL[status]} />
          <button
            className={`fav-btn ${isFav ? "active" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleFav(app.id);
            }}
            aria-label={isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"}
          >
            <Star size={15} fill={isFav ? "currentColor" : "none"} strokeWidth={1.75} />
          </button>
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

export default function RinconMenu() {
  const [theme, setTheme] = useState("dark");
  const [now, setNow] = useState(new Date());
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [statuses, setStatuses] = useState({});
  const searchRef = useRef(null);
  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  const allApps = useMemo(() => GROUPS.flatMap((g) => g.apps), []);

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
  }, [allApps]);

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

  const q = query.trim().toLowerCase();
  const matches = (app) =>
    !q || app.name.toLowerCase().includes(q) || app.desc.toLowerCase().includes(q);

  const filteredGroups = GROUPS.map((g) => ({
    ...g,
    apps: g.apps.filter(matches),
  })).filter((g) => g.apps.length > 0);

  const pinned = allApps.filter((a) => favorites.has(a.id) && matches(a));

  const totalVisible = filteredGroups.reduce((n, g) => n + g.apps.length, 0);
  const onlineCount = allApps.filter((a) => statuses[a.id] === "online").length;
  const timeStr = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={`rincon-root ${theme} ${reduceMotion ? "reduce-motion" : ""}`} data-theme={theme}>
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
          height: 1px;
          background: var(--panel-border);
        }

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

        @media (max-width: 640px) {
          .rincon-root { padding: 36px 18px 30px; }
          .greeting { font-size: 25px; }
          .grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className={`rincon-shell ${loaded ? "in" : ""}`}>
        <div className="topbar">
          <span className="prompt">menuapp@rincon<span className="caret">:~$</span></span>
          <div className="topbar-right">
            <span className="clock">{timeStr}</span>
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
          <span className="count">{onlineCount}</span>/{allApps.length} serviços no ar em {GROUPS.length} grupos
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

        {totalVisible === 0 && (
          <div className="empty-state">nenhum serviço encontrado para "{query}"</div>
        )}

        {pinned.length > 0 && (
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

        {filteredGroups.map((group) => (
          <div className="section" key={group.id}>
            <div className="section-head">
              <group.Icon size={13} />
              <span className="section-title">{group.label.toUpperCase()}</span>
              <span className="count-badge">{group.apps.length}</span>
              <div className="section-line" />
            </div>
            <div className="grid">
              {group.apps.map((app) => (
                <AppCard key={app.id} app={app} isFav={favorites.has(app.id)} onToggleFav={toggleFavorite} status={statuses[app.id] || "checking"} />
              ))}
            </div>
          </div>
        ))}

        <div className="footer">
          <span>Rincon · Painel Pessoal</span>
          <span>{now.getFullYear()}</span>
        </div>
      </div>
    </div>
  );
}