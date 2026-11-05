import { X, ArrowLeft, Check } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Action,
  Commit,
  GitAction,
  Snapshot,
  Repository,
  ConflictVersions,
} from "../types";
import { errorText, useI18n, type MessageKey } from "../lib/i18n";
import { gitService } from "../services/git";
import { Modal } from "./ui";

type Run = (action: Action) => Promise<boolean>;
type Confirm = (message: MessageKey, action: Action) => void;

export function ConflictEditor({
  repo,
  path,
  busy,
  onAction,
  onClose,
}: {
  repo: Repository;
  path: string;
  busy: boolean;
  onAction: Run;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void gitService
      .conflict(repo, path, controller.signal)
      .then((data) => {
        setVersions(data);
        setResult(data.ours ?? data.theirs ?? "");
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error, t));
      });
    return () => controller.abort();
  }, [repo, path, t]);
  const accept = (
    kind: "resolveOurs" | "resolveTheirs" | "resolveDelete" | "resolveEdited",
  ) => {
    void onAction({
      kind,
      paths: [path],
      value: kind === "resolveEdited" ? result : undefined,
    }).then((ok) => {
      if (ok) onClose();
    });
  };
  return (
    <section className="inline-conflict-editor" aria-label={t("editConflict")}>
      <header className="conflict-toolbar">
        <button
          className="icon-button"
          title={t("back")}
          aria-label={t("back")}
          disabled={busy}
          onClick={onClose}
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <span className="eyebrow">{t("conflicts")}</span>
          <strong>{path}</strong>
        </div>
        <button
          className="icon-button"
          title={t("close")}
          aria-label={t("close")}
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p className="conflict-inline-hint">{t("conflictHint")}</p>
      {error && (
        <div>
          <p role="alert" className="inline-error">
            {error}
          </p>
          <div className="conflict-choices">
            {(["resolveOurs", "resolveTheirs", "resolveDelete"] as const).map(
              (kind) => (
                <button key={kind} disabled={busy} onClick={() => accept(kind)}>
                  {t(kind)}
                </button>
              ),
            )}
          </div>
        </div>
      )}
      {!versions && !error && <p>{t("working")}</p>}
      {versions && (
        <>
          <div className="conflict-split">
            {(["ours", "theirs"] as const).map((side) => (
              <section
                className={`conflict-side conflict-side-${side}`}
                key={side}
              >
                <header>
                  <div>
                    <span className="conflict-side-dot" />
                    <strong>
                      {t(side === "ours" ? "oursVersion" : "theirsVersion")}
                    </strong>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      accept(
                        versions[side] === null
                          ? "resolveDelete"
                          : side === "ours"
                            ? "resolveOurs"
                            : "resolveTheirs",
                      )
                    }
                  >
                    <Check size={14} />
                    {t("useVersion")}
                  </button>
                </header>
                <textarea
                  readOnly
                  aria-label={t(
                    side === "ours" ? "oursVersion" : "theirsVersion",
                  )}
                  spellCheck={false}
                  value={versions[side] ?? t("deletedVersion")}
                />
              </section>
            ))}
          </div>
          <details className="conflict-manual">
            <summary>{t("manualMerge")}</summary>
            <details>
              <summary>{t("conflictBase")}</summary>
              <pre>{versions.base ?? t("deletedVersion")}</pre>
            </details>
            <label>
              {t("conflictResult")}
              <textarea
                aria-label={t("conflictResult")}
                value={result}
                onChange={(e) => setResult(e.target.value)}
                rows={7}
                spellCheck={false}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => accept("resolveEdited")}
            >
              {t("saveResolution")}
            </button>
          </details>
        </>
      )}
    </section>
  );
}

export function CommitActions({
  commit,
  busy,
  onAction,
  onClose,
}: {
  commit: Commit;
  busy: boolean;
  onAction: Run;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<GitAction | null>(null);
  const [value, setValue] = useState("");
  const [mode, setMode] = useState("mixed");
  const options: [GitAction, MessageKey][] = [
    ["checkoutCommit", "checkoutCommit"],
    ["createBranch", "newBranchAt"],
    ["createTag", "createTag"],
    ["reset", "reset"],
    ["revert", "revert"],
    ["cherryPick", "cherryPick"],
    ["reword", "reword"],
    ["merge", "merge"],
    ["rebase", "rebase"],
  ];
  const needsValue =
    kind === "createBranch" || kind === "createTag" || kind === "reword";
  return (
    <Modal
      title={t("commitActions")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-content git-operation-dialog">
        <strong>{commit.message}</strong>
        <code>{commit.hash}</code>
        {!kind ? (
          <div className="commit-action-menu" role="menu">
            {options.map(([action, label]) => (
              <button
                role="menuitem"
                key={action}
                disabled={busy}
                onClick={() => {
                  setKind(action);
                  setValue(action === "reword" ? commit.message : "");
                }}
              >
                {t(label)}
              </button>
            ))}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              void onAction({
                kind,
                value: needsValue ? value.trim() : commit.hash,
                extra:
                  kind === "reset"
                    ? mode
                    : needsValue
                      ? commit.hash
                      : undefined,
              }).then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            <h3>{t(options.find(([action]) => action === kind)![1])}</h3>
            <p>
              {t(
                kind === "reword"
                  ? "rewordWarning"
                  : kind === "reset"
                    ? "resetWarning"
                    : "historyWarning",
              )}
            </p>
            {needsValue && (
              <textarea
                required
                autoFocus
                aria-label={t("actionValue")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={kind === "reword" ? 5 : 2}
              />
            )}
            {kind === "reset" && (
              <select
                aria-label={t("resetMode")}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="soft">{t("resetSoft")}</option>
                <option value="mixed">{t("resetMixed")}</option>
                <option value="hard">{t("resetHard")}</option>
              </select>
            )}
            <footer>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setKind(null)}
              >
                {t("back")}
              </button>
              <button
                className="primary-button"
                disabled={busy || (needsValue && !value.trim())}
              >
                {t("confirm")}
              </button>
            </footer>
          </form>
        )}
      </div>
    </Modal>
  );
}

export function OperationStatus({
  data,
  busy,
  onAction,
  onConfirm,
}: {
  data: Snapshot;
  busy: boolean;
  onAction: Run;
  onConfirm: Confirm;
}) {
  const { t } = useI18n();
  if (!data.operation) return null;
  return (
    <div className="operation-banner" role="status">
      <strong>
        {t("operationInProgress")}: {data.operation}
      </strong>
      <button
        disabled={busy || data.files.some(conflicted)}
        onClick={() =>
          void onAction({ kind: "continueOperation", value: data.operation! })
        }
      >
        {t("continueOperation")}
      </button>
      {data.operation !== "merge" && (
        <button
          disabled={busy}
          onClick={() =>
            onConfirm("skipWarning", {
              kind: "skipOperation",
              value: data.operation!,
            })
          }
        >
          {t("skipOperation")}
        </button>
      )}
      <button
        disabled={busy}
        onClick={() =>
          onConfirm("abortWarning", {
            kind: "abortOperation",
            value: data.operation!,
          })
        }
      >
        {t("abortOperation")}
      </button>
    </div>
  );
}

export function conflicted(file: { index: string; worktree: string }) {
  return (
    file.index === "U" ||
    file.worktree === "U" ||
    ["AA", "DD"].includes(file.index + file.worktree)
  );
}

export function WorkspaceTools({
  data,
  busy,
  onAction,
  onConfirm,
}: {
  data: Snapshot;
  busy: boolean;
  onAction: Run;
  onConfirm: Confirm;
}) {
  const { t } = useI18n();
  const [remote, setRemote] = useState("");
  const selectedRemote = data.remotes.some((r) => r.name === remote)
    ? remote
    : (data.remotes[0]?.name ?? "");
  return (
    <details className="workspace-tools">
      <summary>{t("gitTools")}</summary>
      <button
        disabled={
          busy ||
          !data.files.length ||
          !!data.operation ||
          data.files.some(conflicted)
        }
        onClick={() => void onAction({ kind: "stash", value: "RepoWeft" })}
      >
        {t("stash")}
      </button>
      <button
        disabled={
          busy || !selectedRemote || !data.branches.some((b) => b.current)
        }
        onClick={() =>
          void onAction({ kind: "publishBranch", value: selectedRemote })
        }
      >
        {t("publishBranch")}
      </button>
      <h4>{t("tagRef")}</h4>
      <select
        aria-label={t("remotes")}
        value={selectedRemote}
        onChange={(e) => setRemote(e.target.value)}
      >
        {data.remotes.map((r) => (
          <option key={r.name}>{r.name}</option>
        ))}
      </select>
      {!data.tags?.length && <p>{t("noTags")}</p>}
      {data.tags?.map((tag) => (
        <div className="tool-entry" key={tag}>
          <code>{tag}</code>
          <button
            disabled={busy || !selectedRemote}
            onClick={() =>
              void onAction({
                kind: "pushTag",
                value: tag,
                extra: selectedRemote,
              })
            }
          >
            {t("pushTag")}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              onConfirm("historyWarning", { kind: "deleteTag", value: tag })
            }
          >
            {t("deleteTag")}
          </button>
        </div>
      ))}
      <h4>{t("stash")}</h4>
      {!data.stashes?.length && <p>{t("noStashes")}</p>}
      {data.stashes?.map((stash) => (
        <div className="tool-entry" key={stash}>
          <code>{stash}</code>
          {(["stashApply", "stashPop", "stashDrop"] as const).map((kind) => (
            <button
              key={kind}
              disabled={busy || !!data.operation}
              onClick={() => {
                const action = { kind, value: stash.split(":")[0] };
                if (kind === "stashDrop") onConfirm("stashDropWarning", action);
                else void onAction(action);
              }}
            >
              {t(kind)}
            </button>
          ))}
        </div>
      ))}
    </details>
  );
}
