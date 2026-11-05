import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, CloudUpload, Plus, Tag, Trash2, X } from "lucide-react";
import type { Action, Snapshot } from "../types";
import { useI18n, type MessageKey } from "../lib/i18n";
import { conflicted } from "../lib/changes";
import { VirtualList } from "./VirtualList";

type Panel = "tags" | "stashes" | "publish";
export function WorkspaceTools({
  data,
  busy,
  onAction,
  onConfirm,
}: {
  data: Snapshot;
  busy: boolean;
  onAction: (action: Action) => Promise<boolean>;
  onConfirm: (message: MessageKey, action: Action) => void;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [remote, setRemote] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const selectedRemote = data.remotes.some((r) => r.name === remote)
    ? remote
    : (data.remotes[0]?.name ?? "");
  const tags = data.tags ?? [];
  const stashes = data.stashes ?? [];
  const current = data.branches.find((b) => b.current);
  const title = t(
    panel === "tags"
      ? "workspaceTags"
      : panel === "stashes"
        ? "workspaceStashes"
        : "publishBranch",
  );
  useEffect(() => {
    if (!panel) return;
    const outside = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setPanel(null);
    };
    const close = () => setPanel(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        root.current
          ?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')
          ?.focus();
        setPanel(null);
      }
    };
    popup.current
      ?.querySelector<HTMLElement>("select, button:not(:disabled)")
      ?.focus();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [panel]);
  const toggle = (value: Panel, button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(bounds.right - 360, window.innerWidth - 368)),
      top: bounds.bottom + 6,
    });
    setPanel((old) => (old === value ? null : value));
  };
  const run = (action: Action) =>
    void onAction(action).then((ok) => {
      if (ok) setPanel(null);
    });
  const confirm = (message: MessageKey, action: Action) => {
    setPanel(null);
    onConfirm(message, action);
  };
  const remoteSelector = (
    <label className="workspace-remote">
      <span>{t("remotes")}</span>
      <select
        disabled={busy || !data.remotes.length}
        aria-label={t("remotes")}
        value={selectedRemote}
        onChange={(event) => setRemote(event.target.value)}
      >
        {data.remotes.map((r) => (
          <option key={r.name}>{r.name}</option>
        ))}
      </select>
    </label>
  );
  return (
    <div ref={root} className="workspace-tools">
      <button
        className="workspace-tool-button"
        aria-label={`${t("workspaceTags")} ${tags.length}`}
        title={t("workspaceTags")}
        aria-expanded={panel === "tags"}
        aria-haspopup="dialog"
        onClick={(event) => toggle("tags", event.currentTarget)}
      >
        <Tag size={14} />
        <span>{t("workspaceTags")}</span>
        <span className="workspace-tool-count">{tags.length}</span>
      </button>
      <button
        className="workspace-tool-button"
        aria-label={`${t("workspaceStashes")} ${stashes.length}`}
        title={t("workspaceStashes")}
        aria-expanded={panel === "stashes"}
        aria-haspopup="dialog"
        onClick={(event) => toggle("stashes", event.currentTarget)}
      >
        <Archive size={14} />
        <span>{t("workspaceStashes")}</span>
        <span className="workspace-tool-count">{stashes.length}</span>
      </button>
      {current && !current.upstream && (
        <button
          className="workspace-tool-button"
          aria-label={t("publishBranch")}
          title={t("publishBranch")}
          aria-expanded={panel === "publish"}
          aria-haspopup="dialog"
          onClick={(event) => toggle("publish", event.currentTarget)}
        >
          <CloudUpload size={14} />
        </button>
      )}
      {panel &&
        createPortal(
          <div
            ref={popup}
            className="workspace-popover"
            role="dialog"
            aria-label={title}
            aria-modal={false}
            style={{
              left: position.left,
              top: position.top,
              maxHeight: `min(360px, calc(100vh - ${position.top + 12}px))`,
            }}
          >
            <header>
              <strong>{title}</strong>
              {panel === "stashes" && (
                <button
                  className="icon-button"
                  disabled={
                    busy ||
                    !data.files.length ||
                    !!data.operation ||
                    data.files.some(conflicted)
                  }
                  title={t("stash")}
                  aria-label={t("stash")}
                  onClick={() => run({ kind: "stash", value: "RepoWeft" })}
                >
                  <Plus size={15} />
                </button>
              )}
              <button
                className="icon-button"
                aria-label={t("close")}
                onClick={() => setPanel(null)}
              >
                <X size={14} />
              </button>
            </header>
            {panel === "tags" &&
              (tags.length ? (
                <>
                  {remoteSelector}
                  <VirtualList
                    items={tags}
                    rowHeight={44}
                    maxHeight="260px"
                    render={(tag) => (
                      <div key={tag} className="workspace-entry">
                        <Tag size={14} />
                        <code title={tag}>{tag}</code>
                        <button
                          className="workspace-text-action"
                          disabled={busy || !selectedRemote}
                          onClick={() =>
                            run({
                              kind: "pushTag",
                              value: tag,
                              extra: selectedRemote,
                            })
                          }
                        >
                          {t("push")}
                        </button>
                        <button
                          className="icon-button danger-hover"
                          title={t("deleteTag")}
                          aria-label={`${t("deleteTag")} ${tag}`}
                          disabled={busy}
                          onClick={() =>
                            confirm("historyWarning", {
                              kind: "deleteTag",
                              value: tag,
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  />
                </>
              ) : (
                <div className="workspace-empty">
                  <Tag size={24} />
                  <strong>{t("noTags")}</strong>
                  <span>{t("tagsEmptyHint")}</span>
                </div>
              ))}
            {panel === "stashes" &&
              (stashes.length ? (
                <VirtualList
                  items={stashes}
                  rowHeight={66}
                  maxHeight="264px"
                  render={(stash) => (
                    <div key={stash} className="workspace-stash-entry">
                      <code title={stash}>{stash}</code>
                      <div>
                        {(["stashApply", "stashPop", "stashDrop"] as const).map(
                          (kind) => (
                            <button
                              className="workspace-text-action"
                              key={kind}
                              disabled={busy || !!data.operation}
                              onClick={() => {
                                const action = {
                                  kind,
                                  value: stash.split(":")[0],
                                };
                                if (kind === "stashDrop")
                                  confirm("stashDropWarning", action);
                                else run(action);
                              }}
                            >
                              {t(kind)}
                            </button>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                />
              ) : (
                <div className="workspace-empty">
                  <Archive size={24} />
                  <strong>{t("noStashes")}</strong>
                  <span>{t("stashesEmptyHint")}</span>
                </div>
              ))}
            {panel === "publish" && (
              <div className="workspace-publish">
                {remoteSelector}
                <button
                  className="primary-button"
                  disabled={busy || !selectedRemote || !current}
                  onClick={() =>
                    run({ kind: "publishBranch", value: selectedRemote })
                  }
                >
                  <CloudUpload size={14} />
                  {t("publishBranch")}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
