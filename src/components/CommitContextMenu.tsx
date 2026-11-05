import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n, type MessageKey } from "../lib/i18n";

export type CommitMenuAction =
  | "checkoutCommit"
  | "createBranch"
  | "createTag"
  | "merge"
  | "rebase"
  | "cherryPick"
  | "reword"
  | "revert"
  | "reset";
const groups: [CommitMenuAction, MessageKey][][] = [
  [
    ["checkoutCommit", "contextCheckout"],
    ["createBranch", "contextBranch"],
    ["createTag", "contextTag"],
  ],
  [
    ["merge", "contextMerge"],
    ["rebase", "contextRebase"],
    ["cherryPick", "contextCherryPick"],
  ],
  [
    ["reword", "contextReword"],
    ["revert", "contextRevert"],
    ["reset", "contextReset"],
  ],
];

export function CommitContextMenu({
  x,
  y,
  busy,
  onChoose,
  onCopy,
  onClose,
}: {
  x: number;
  y: number;
  busy: boolean;
  onChoose: (kind: CommitMenuAction) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    if (!menu.contains(document.activeElement))
      returnFocus.current = document.activeElement as HTMLElement | null;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);
  useEffect(() => {
    const menu = root.current;
    const previous = returnFocus.current;
    const outside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) close.current();
    };
    const scroll = (event: Event) => {
      if (!menu?.contains(event.target as Node)) close.current();
    };
    const dismiss = () => close.current();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      if (
        (document.activeElement === document.body ||
          menu?.contains(document.activeElement)) &&
        previous instanceof HTMLElement &&
        !menu?.contains(previous) &&
        previous.isConnected
      )
        previous.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={root}
      className="commit-context-menu"
      role="menu"
      aria-label={t("commitActions")}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (["Escape", "Tab"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        const items = [
          ...(root.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next]?.focus();
      }}
    >
      {groups.map((group, index) => (
        <div key={index} role="group">
          {index > 0 && (
            <div className="context-menu-divider" role="separator" />
          )}
          {group.map(([kind, label]) => (
            <button
              type="button"
              role="menuitem"
              key={kind}
              disabled={busy}
              onPointerEnter={(event) => {
                if (!busy) event.currentTarget.focus();
              }}
              onClick={() => onChoose(kind)}
            >
              {t(label)}
            </button>
          ))}
        </div>
      ))}
      <div className="context-menu-divider" role="separator" />
      <button
        type="button"
        role="menuitem"
        onPointerEnter={(event) => event.currentTarget.focus()}
        onClick={onCopy}
      >
        {t("copyHash")}
      </button>
    </div>,
    document.body,
  );
}
