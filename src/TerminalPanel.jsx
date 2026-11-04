import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

// Terminal de uma máquina (shell no host, tipo ssh) num painel por cima do
// menu. Carregado sob demanda: só quem está logado e abre baixa o xterm.js.
// Fala com o checador pelo WebSocket /api/terminal — ver server/index.js.
export default function TerminalPanel({ machine, label, onClose }) {
  const boxRef = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 13,
      theme: { background: "#090c10", foreground: "#edeff4", cursor: "#34d399" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();
    term.focus();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/terminal?machine=${encodeURIComponent(machine)}`);
    ws.binaryType = "arraybuffer";
    const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    ws.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => term.write("\r\n\x1b[90m[conexão encerrada — feche e abra de novo]\x1b[0m\r\n");
    const input = term.onData((data) => send({ type: "input", data }));
    const resize = term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(boxRef.current);

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      ws.onclose = null;
      ws.close();
      term.dispose();
    };
  }, [machine]);

  return (
    <div className="overlay" role="dialog" aria-label={`Terminal — ${label}`}>
      <div className="term-panel">
        <div className="term-head">
          <span className="prompt">{label}<span className="caret"> · terminal</span></span>
          <button className="theme-btn" onClick={onClose} aria-label="Fechar terminal">
            <X size={15} />
          </button>
        </div>
        <div className="term-box" ref={boxRef} />
      </div>
    </div>
  );
}
