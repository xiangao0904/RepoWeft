import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "../lib/i18n";

export function QuickCommitInput({
  title,
  hash,
  value,
  placeholder,
  multiline,
  busy,
  onChange,
  onSubmit,
  onClose,
}: {
  title: string;
  hash: string;
  value: string;
  placeholder: string;
  multiline: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLFormElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const current = useRef({ busy, onClose });
  current.current = { busy, onClose };
  useLayoutEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    const input = root.current?.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >("input, textarea");
    input?.focus();
    input?.select();
  }, []);
  useEffect(() => {
    const form = root.current;
    const outside = (event: PointerEvent) => {
      if (!current.current.busy && !form?.contains(event.target as Node))
        current.current.onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      if (
        (document.activeElement === document.body ||
          form?.contains(document.activeElement)) &&
        previous.current?.isConnected
      )
        previous.current.focus();
    };
  }, []);
  return createPortal(
    <form
      ref={root}
      className="quick-commit-input"
      role="dialog"
      aria-label={title}
      aria-modal={false}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && value.trim()) onSubmit();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          if (!busy) onClose();
        }
        if (
          multiline &&
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault();
          root.current?.requestSubmit();
        }
      }}
    >
      <header>
        <span>{title}</span>
        <code>{hash.slice(0, 7)}</code>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      {multiline ? (
        <textarea
          disabled={busy}
          required
          aria-label={t("actionValue")}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          spellCheck={false}
        />
      ) : (
        <input
          disabled={busy}
          required
          aria-label={t("actionValue")}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <footer>
        <span>{t(multiline ? "quickCommitKeys" : "quickNameKeys")}</span>
        <button className="quick-input-submit" disabled={busy || !value.trim()}>
          {t(busy ? "working" : "confirm")}
        </button>
      </footer>
    </form>,
    document.body,
  );
}
