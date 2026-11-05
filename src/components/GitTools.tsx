import { X, ArrowLeft, Check } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Action,
  Commit,
  GitAction,
  Snapshot,
  Repository,
  ConflictVersions,
  RewordResult,
} from "../types";
import { errorText, useI18n, type MessageKey } from "../lib/i18n";
import { gitService } from "../services/git";
import { QuickCommitInput } from "./QuickCommitInput";
import { Modal } from "./ui";

type Run = (
  action: Action,
  onResult?: (output: string) => void,
) => Promise<boolean>;
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
  kind,
  busy,
  onAction,
  onClose,
}: {
  commit: Commit;
  kind: GitAction;
  busy: boolean;
  onAction: Run;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(kind === "reword" ? commit.message : "");
  const [mode, setMode] = useState("mixed");
  const [publication, setPublication] = useState<RewordResult | null>(null);
  const [pushTarget, setPushTarget] = useState(0);
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
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
  async function submit() {
    if (locked || (needsValue && !value.trim())) return;
    setSaving(true);
    try {
      const response: { result: RewordResult | null } = { result: null };
      const ok = await onAction(
        {
          kind,
          value: needsValue ? value.trim() : commit.hash,
          extra: kind === "reset" ? mode : needsValue ? commit.hash : undefined,
        },
        (output) => {
          if (kind === "reword")
            response.result = JSON.parse(output) as RewordResult;
        },
      );
      if (!ok) return;
      if (response.result && response.result.targets.length)
        setPublication(response.result);
      else onClose();
    } finally {
      setSaving(false);
    }
  }
  if (publication) {
    const target = publication.targets[pushTarget];
    return (
      <Modal
        key="publish-rewrite"
        title={t("publishedRewordTitle")}
        onClose={() => {
          if (!locked) onClose();
        }}
      >
        <div className="modal-content git-operation-dialog">
          <p>{t("publishedRewordPrompt")}</p>
          {publication.targets.length > 1 ? (
            <label>
              {t("publishedRewordTarget")}
              <select
                aria-label={t("publishedRewordTarget")}
                disabled={locked}
                value={pushTarget}
                onChange={(e) => setPushTarget(Number(e.target.value))}
              >
                {publication.targets.map((lease, index) => (
                  <option key={`${lease.remote}:${lease.target}`} value={index}>
                    {lease.remote}/{lease.target.replace("refs/heads/", "")}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <code>
              {target.remote}/{target.target.replace("refs/heads/", "")}
            </code>
          )}
          <footer>
            <button
              className="secondary-button"
              disabled={locked}
              onClick={onClose}
            >
              {t("keepLocalRewrite")}
            </button>
            <button
              className="primary-button"
              disabled={locked}
              onClick={() =>
                void onAction({
                  kind: "forcePush",
                  lease: target,
                  expectedHead: publication.head,
                  expectedBranch: publication.branch,
                }).then((ok) => {
                  if (ok) onClose();
                })
              }
            >
              {t("forcePush")}
            </button>
          </footer>
        </div>
      </Modal>
    );
  }
  if (needsValue)
    return (
      <QuickCommitInput
        title={t(options.find(([action]) => action === kind)![1])}
        hash={commit.hash}
        value={value}
        placeholder={t(
          kind === "createTag"
            ? "tagNameInput"
            : kind === "createBranch"
              ? "branchName"
              : "commitSummary",
        )}
        multiline={kind === "reword"}
        busy={locked}
        onChange={setValue}
        onSubmit={() => void submit()}
        onClose={onClose}
      />
    );
  return (
    <Modal
      key="edit-commit"
      title={t(options.find(([action]) => action === kind)![1])}
      onClose={() => {
        if (!locked) onClose();
      }}
    >
      <div className="modal-content git-operation-dialog">
        <strong>{commit.message}</strong>
        <code>{commit.hash}</code>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (locked) return;
            void submit();
          }}
        >
          <p>{t(kind === "reset" ? "resetWarning" : "historyWarning")}</p>
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
              disabled={locked}
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              className="primary-button"
              disabled={locked || (needsValue && !value.trim())}
            >
              {t("confirm")}
            </button>
          </footer>
        </form>
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
