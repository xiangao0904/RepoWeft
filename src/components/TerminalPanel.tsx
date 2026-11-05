import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { RefreshCw, Terminal as TerminalIcon, X } from "lucide-react";
import type { Repository } from "../types";
import { useI18n } from "../lib/i18n";
import { desktop, gitService } from "../services/git";
import "@xterm/xterm/css/xterm.css";

type Output = { kind: "data"; bytes: number[] } | { kind: "exit" };

function pageTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(name).trim();
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: color("--surface"),
    foreground: color("--text"),
    cursor: color("--accent"),
    cursorAccent: color("--surface"),
    selectionBackground: `${color("--accent")}40`,
    black: color("--subtle"),
    brightBlack: color("--muted"),
    red: color("--red"),
    brightRed: color("--red"),
    green: color("--green"),
    brightGreen: color("--green"),
    yellow: light ? "#946200" : "#e5b969",
    brightYellow: light ? "#946200" : "#e5b969",
    blue: light ? "#2563a5" : "#77a5ed",
    brightBlue: light ? "#2563a5" : "#77a5ed",
    magenta: color("--accent"),
    brightMagenta: color("--accent"),
    cyan: light ? "#167d80" : "#5dc8b6",
    brightCyan: light ? "#167d80" : "#5dc8b6",
    white: color("--text"),
    brightWhite: color("--text"),
  };
}

export default function TerminalPanel({
  repo,
  onClose,
}: {
  repo: Repository;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!container.current) return;
    if (!desktop || repo.demo) {
      setStatus(t("desktopOnly"));
      return;
    }
    let disposed = false;
    let id: number | null = null;
    let pendingAck = 0;
    let ended = false;
    let input = Promise.resolve();
    const earlyInput: string[] = [];
    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 2000,
      theme: pageTheme(),
    });
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = pageTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    fit.fit();
    setStatus(t("terminalStarting"));
    const acknowledge = (bytes: number) => {
      if (id === null) pendingAck += bytes;
      else if (!disposed && !ended)
        void invoke("terminal_ack", { id, bytes }).catch(() => {});
    };
    const output = new Channel<Output>();
    output.onmessage = (event) => {
      if (disposed) return;
      if (event.kind === "exit") {
        ended = true;
        setStatus(t("terminalExited"));
        return;
      }
      terminal.write(new Uint8Array(event.bytes), () =>
        acknowledge(event.bytes.length),
      );
    };
    // Warm the shared connection first, so the shell does not stop at a password
    // prompt inside the terminal. Platforms without reuse let the PTY ask instead.
    const authenticated =
      repo.location.kind === "ssh"
        ? gitService.warmConnection(repo.location.host).catch(() => {})
        : Promise.resolve();
    void authenticated
      .then(() => {
        if (disposed) return null;
        return invoke<number>("terminal_open", {
          location: repo.location,
          cols: terminal.cols,
          rows: terminal.rows,
          output,
        });
      })
      .then((session) => {
        if (session === null) return;
        id = session;
        if (disposed) {
          void invoke("terminal_close", { id }).catch(() => {});
          return;
        }
        if (pendingAck) {
          acknowledge(pendingAck);
          pendingAck = 0;
        }
        for (const text of earlyInput.splice(0)) transmit(text);
        if (!ended) setStatus("");
        fit.fit();
        void invoke("terminal_resize", {
          id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
        terminal.focus();
      })
      .catch((error) => {
        if (!disposed) setStatus(String(error));
      });
    const transmit = (text: string) => {
      if (ended) return;
      if (id === null) {
        earlyInput.push(text);
        return;
      }
      // Serialize input so paste and keystrokes retain their original order.
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 8192, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const chunk = text.slice(offset, end);
        offset = end;
        input = input
          .then(async () => {
            if (!disposed && !ended)
              await invoke("terminal_write", { id, data: chunk });
          })
          .catch((error) => {
            if (!disposed) setStatus(String(error));
          });
      }
    };
    const data = terminal.onData(transmit);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        if (id !== null && !ended)
          void invoke("terminal_resize", {
            id,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => {});
      });
    });
    observer.observe(container.current);
    return () => {
      disposed = true;
      themeObserver.disconnect();
      observer.disconnect();
      cancelAnimationFrame(frame);
      data.dispose();
      terminal.dispose();
      if (id !== null) void invoke("terminal_close", { id }).catch(() => {});
    };
  }, [repo.id, version, t]);
  return (
    <section
      className="terminal-panel"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header>
        <TerminalIcon size={14} />
        <strong>{t("terminal")}</strong>
        <span className="terminal-path" title={repo.location.path}>
          {repo.location.kind === "ssh" ? `${repo.location.host.name}:` : ""}
          {repo.location.path}
        </span>
        <button
          className="icon-button"
          title={t("terminalRestart")}
          aria-label={t("terminalRestart")}
          onClick={() => setVersion((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button"
          title={t("terminalClose")}
          aria-label={t("terminalClose")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      {status && (
        <div className="terminal-status" role="status">
          {status}
        </div>
      )}
      <div ref={container} className="terminal-surface" />
    </section>
  );
}
