import { gravatar, resolveGithubAvatar } from "../lib/avatars";
import logo from "../../assets/logo/repoweft-icon.svg";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { X, GitBranch, FolderGit2 } from "lucide-react";
import { useI18n } from "../lib/i18n";

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand-mark ${large ? "large" : ""}`} aria-hidden="true">
      <img src={logo} alt="" />
    </span>
  );
}
export function Empty({
  icon = <FolderGit2 size={28} />,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLElement>("input, button, select, textarea")
      ?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab") return;
      const items = ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]',
      );
      if (!items?.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function BranchBadge({ name }: { name: string }) {
  return (
    <span className="branch-badge">
      <GitBranch size={11} />
      {name.replace("HEAD -> ", "")}
    </span>
  );
}

export const Avatar = memo(function Avatar({
  name,
  email,
  githubRepo = null,
  hash = "",
}: {
  name: string;
  email: string;
  githubRepo?: string | null;
  hash?: string;
}) {
  const [url, setUrl] = useState("");
  const [fallback, setFallback] = useState("");
  useEffect(() => {
    let cancelled = false;
    setUrl("");
    setFallback("");
    // Resolve independently of repository loading. Rows share cached requests per author.
    void resolveGithubAvatar(email, githubRepo, hash)
      .then(async (github) => {
        const backup =
          !github && !githubRepo && email.trim() ? await gravatar(email) : "";
        if (!cancelled) {
          setFallback(backup);
          setUrl(github || backup);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email, githubRepo, hash]);
  return (
    <span className="avatar">
      {url ? (
        <img
          src={url}
          alt={name}
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onError={() => setUrl(url !== fallback ? fallback : "")}
        />
      ) : (
        name.slice(0, 1)
      )}
    </span>
  );
});

export function Splitter({
  orientation,
  onResize,
}: {
  orientation: "vertical" | "horizontal";
  onResize: (delta: number) => void;
}) {
  const { t } = useI18n();
  const last = useRef<number | null>(null);
  return (
    <div
      className={`panel-splitter ${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={t("resizePanels")}
      aria-orientation={orientation}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        last.current = orientation === "vertical" ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const next = orientation === "vertical" ? e.clientX : e.clientY;
        onResize(next - last.current);
        last.current = next;
      }}
      onLostPointerCapture={() => {
        last.current = null;
      }}
      onPointerUp={(e) => {
        last.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onKeyDown={(e) => {
        const negative = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const positive =
          orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (e.key === negative || e.key === positive) {
          e.preventDefault();
          onResize(e.key === positive ? 16 : -16);
        }
      }}
    />
  );
}
