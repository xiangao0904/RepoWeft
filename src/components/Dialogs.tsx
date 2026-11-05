import { useEffect, useRef, useState, type FormEvent } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import { errorText, useI18n, type MessageKey } from "../lib/i18n";
import { useStored } from "../lib/storage";
import { desktop, gitService } from "../services/git";
import type {
  Action,
  AuthRequest,
  DirectoryEntry,
  Repository,
  SSHHost,
} from "../types";
import { Modal } from "./ui";

export type DialogState =
  | { type: "open" | "clone" | "init" }
  | { type: "server"; host?: SSHHost }
  | { type: "remoteOpen"; host: SSHHost }
  | { type: "remoteCreate"; host: SSHHost }
  | { type: "branch" | "remote" }
  | { type: "confirm"; message: MessageKey; run: () => Promise<void> }
  | { type: "commands" };
export interface DialogProps {
  dialog: DialogState;
  onClose: () => void;
  onOpen: (repo: Repository, signal?: AbortSignal) => Promise<boolean>;
  onSaveHost: (host: SSHHost) => void;
  onAction: (action: Action) => Promise<boolean>;
  onCommand: (type: "open" | "clone" | "init" | "server" | "settings") => void;
}

export function Dialogs(props: DialogProps) {
  const { dialog } = props;
  if (dialog.type === "commands") return <CommandDialog {...props} />;
  if (dialog.type === "server")
    return <HostDialog {...props} host={dialog.host} />;
  if (dialog.type === "confirm")
    return (
      <ConfirmDialog {...props} message={dialog.message} run={dialog.run} />
    );
  return <RepositoryDialog {...props} />;
}

function ConfirmDialog({
  message,
  run,
  onClose,
}: DialogProps & { message: MessageKey; run: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={t("confirm")}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-content">
        <p className="dialog-description">{t(message)}</p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button disabled={busy} className="secondary-button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void run()
              .then(onClose)
              .catch((e) => {
                setError(String(e));
                setBusy(false);
              });
          }}
        >
          {busy ? <LoaderCircle size={16} className="spin" /> : null}
          {t("confirm")}
        </button>
      </footer>
    </Modal>
  );
}

function HostDialog({
  host,
  onClose,
  onSaveHost,
}: DialogProps & { host?: SSHHost }) {
  const { t } = useI18n();
  const [name, setName] = useState(host?.name ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [username, setUsername] = useState(host?.username ?? "");
  const [port, setPort] = useState(host?.port ?? 0);
  const [identityFile, setIdentityFile] = useState(host?.identityFile ?? "");
  return (
    <Modal title={t(host ? "editServer" : "addServer")} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSaveHost({
            id: host?.id ?? crypto.randomUUID(),
            name: name.trim(),
            hostname: hostname.trim(),
            username: username.trim(),
            port,
            identityFile: identityFile.trim(),
          });
          onClose();
        }}
      >
        <div className="modal-content form-fields">
          <div className="dialog-symbol">
            <Server size={24} />
          </div>
          <label>
            {t("name")}
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="gpu-01"
            />
          </label>
          <label>
            {t("hostname")}
            <input
              required
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="192.168.1.10"
            />
          </label>
          <div className="form-columns">
            <label>
              {t("username")}
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ubuntu"
              />
            </label>
            <label>
              {t("port")}
              <input
                type="number"
                min="0"
                max="65535"
                required
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
              <span className="field-hint">{t("sshConfigPort")}</span>
            </label>
          </div>
          <label>
            {t("identity")}
            <input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
            />
          </label>
          <div className="info-box">
            <ShieldCheck size={18} />
            <p>{t("sshHint")}</p>
          </div>
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button">{t("save")}</button>
        </footer>
      </form>
    </Modal>
  );
}

function RepositoryDialog({ dialog, onClose, onOpen, onAction }: DialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");
  const [extra, setExtra] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"init" | "clone">("init");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirs, setDirs] = useState<DirectoryEntry[] | null>(null);
  const creating = dialog.type === "remoteCreate";
  const isRemote = dialog.type === "remoteOpen" || creating;
  const navigation = useRef(0);
  const remoteAbort = useRef(new AbortController());
  const remoteHost = isRemote ? dialog.host : null;
  const target = `${path.replace(/\/+$/, "")}/${name.trim()}`;
  async function navigate(destination: string) {
    if (!remoteHost) return;
    const request = ++navigation.current;
    setBusy(true);
    setError("");
    try {
      const result = await gitService.directories(remoteHost, destination);
      if (request === navigation.current) {
        setPath(result.path);
        setDirs(result.directories);
      }
    } catch (error) {
      if (request === navigation.current) setError(errorText(error, t));
    } finally {
      if (request === navigation.current) setBusy(false);
    }
  }
  useEffect(() => {
    remoteAbort.current = new AbortController();
    if (remoteHost) void navigate("");
    return () => {
      ++navigation.current;
      remoteAbort.current.abort();
    };
  }, [remoteHost?.id]);
  function close() {
    if (busy && !isRemote) return;
    if (isRemote) {
      ++navigation.current;
      remoteAbort.current.abort();
    }
    onClose();
  }
  const title: MessageKey =
    dialog.type === "clone"
      ? "cloneTitle"
      : dialog.type === "init"
        ? "initTitle"
        : dialog.type === "branch"
          ? "newBranch"
          : dialog.type === "remote"
            ? "addRemote"
            : creating
              ? "remoteCreateTitle"
              : isRemote
                ? "openRemote"
                : "openTitle";
  async function browse() {
    if (!desktop) {
      setError(t("desktopOnly"));
      return;
    }
    setError("");
    if (isRemote) {
      await navigate(path);
    } else {
      try {
        const result = await pickDirectory({
          directory: true,
          multiple: false,
        });
        if (result) setPath(result);
      } catch (e) {
        setError(String(e));
      }
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (dialog.type === "branch" || dialog.type === "remote") {
        if (
          await onAction({
            kind: dialog.type === "branch" ? "createBranch" : "addRemote",
            value: value.trim(),
            extra: extra.trim(),
          })
        )
          onClose();
      } else if (creating) {
        if (!desktop) throw new Error(t("desktopOnly"));
        const folder = name.trim();
        if (
          !folder ||
          /[\\/]/.test(folder) ||
          folder === "." ||
          folder === ".."
        )
          throw new Error(t("invalidName"));
        if (mode === "clone" && !url.trim()) throw new Error(t("remoteUrl"));
        const created = await gitService.createRemote(
          dialog.host,
          target,
          mode === "clone" ? url.trim() : undefined,
        );
        const repo: Repository = {
          id: crypto.randomUUID(),
          name: folder,
          location: { kind: "ssh", path: created, host: dialog.host },
          favorite: false,
          lastOpened: Date.now(),
        };
        if (await onOpen(repo, remoteAbort.current.signal)) onClose();
      } else {
        if (!desktop) throw new Error(t("desktopOnly"));
        if (!path.trim()) throw new Error(t("invalidPath"));
        if (dialog.type === "init" || dialog.type === "clone")
          await gitService.create(
            path.trim(),
            dialog.type === "clone" ? value.trim() : undefined,
          );
        const clean = path.trim().replace(/[\\/]+$/, "");
        const repo: Repository = {
          id: crypto.randomUUID(),
          name: clean.split(/[\\/]/).pop() || clean,
          location:
            dialog.type === "remoteOpen"
              ? { kind: "ssh", path: clean, host: dialog.host }
              : { kind: "local", path: clean },
          favorite: false,
          lastOpened: Date.now(),
        };
        if (
          await onOpen(repo, isRemote ? remoteAbort.current.signal : undefined)
        )
          onClose();
      }
    } catch (e) {
      if (!remoteAbort.current.signal.aborted) setError(errorText(e, t));
    } finally {
      if (!remoteAbort.current.signal.aborted) setBusy(false);
    }
  }
  const pathLabel =
    dialog.type === "clone" ? "clonePath" : isRemote ? "remotePath" : "path";
  return (
    <Modal title={t(title)} onClose={close}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-content form-fields">
          <p className="dialog-description">
            {t(
              dialog.type === "clone"
                ? "cloneHint"
                : dialog.type === "init"
                  ? "initHint"
                  : dialog.type === "branch"
                    ? "branchHint"
                    : dialog.type === "remote"
                      ? "remoteHint"
                      : creating
                        ? "remoteCreateHint"
                        : isRemote
                          ? "sshHint"
                          : "openHint",
            )}
          </p>
          {creating && (
            <>
              <div
                className="segmented"
                role="group"
                aria-label={t("remoteCreateTitle")}
              >
                <button
                  type="button"
                  className={mode === "init" ? "active" : ""}
                  onClick={() => setMode("init")}
                >
                  {t("remoteInit")}
                </button>
                <button
                  type="button"
                  className={mode === "clone" ? "active" : ""}
                  onClick={() => setMode("clone")}
                >
                  {t("remoteClone")}
                </button>
              </div>
              <label>
                {t("remoteRepoName")}
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-project"
                />
              </label>
              {mode === "clone" && (
                <label>
                  {t("remoteUrl")}
                  <input
                    required
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/owner/repository.git"
                  />
                </label>
              )}
            </>
          )}
          {(dialog.type === "branch" ||
            dialog.type === "remote" ||
            dialog.type === "clone") && (
            <label>
              {t(
                dialog.type === "branch"
                  ? "branchName"
                  : dialog.type === "remote"
                    ? "remoteName"
                    : "remoteUrl",
              )}
              <input
                autoFocus
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  dialog.type === "branch"
                    ? "feature/new-idea"
                    : dialog.type === "remote"
                      ? "origin"
                      : "https://github.com/owner/repository.git"
                }
              />
            </label>
          )}
          {dialog.type === "remote" && (
            <label>
              {t("remoteUrl")}
              <input
                required
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="git@github.com:owner/repository.git"
              />
            </label>
          )}
          {!isRemote &&
            dialog.type !== "branch" &&
            dialog.type !== "remote" && (
              <label>
                {t(pathLabel)}
                <div className="input-with-button">
                  <input
                    required
                    value={path}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setDirs(null);
                    }}
                  />
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void browse()}
                    title={t("browse")}
                    aria-label={t("browse")}
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              </label>
            )}
          {isRemote && (
            <div className="remote-browser-location">
              <span>{remoteHost?.name}</span>
              <div className="remote-breadcrumbs">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void navigate("/")}
                >
                  /
                </button>
                {path
                  .split("/")
                  .filter(Boolean)
                  .map((part, index, parts) => (
                    <button
                      type="button"
                      key={index}
                      disabled={busy}
                      onClick={() =>
                        void navigate("/" + parts.slice(0, index + 1).join("/"))
                      }
                    >
                      {part}
                      <ChevronRight size={12} />
                    </button>
                  ))}
              </div>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void navigate("/")}
              >
                {t("remoteRoot")}
              </button>
            </div>
          )}
          {isRemote && busy && (
            <div className="browser-loading" role="status">
              <LoaderCircle size={18} className="spin" />
              {t("working")}
            </div>
          )}
          {dirs && (
            <div className="directory-browser">
              <button
                type="button"
                onClick={() => {
                  void navigate(
                    path.substring(0, path.lastIndexOf("/")) || "/",
                  );
                }}
              >
                <ArrowLeft size={14} />
                {t("parent")}
              </button>
              {dirs.map((dir) => (
                <button
                  type="button"
                  key={dir.path}
                  disabled={busy || !dir.accessible}
                  title={!dir.accessible ? t("directoryNoAccess") : dir.path}
                  onClick={() => {
                    if (dir.accessible) void navigate(dir.path);
                  }}
                >
                  <Folder size={16} />
                  <span>{dir.path.split("/").pop()}</span>
                  {dir.accessible ? (
                    <ChevronRight size={14} />
                  ) : (
                    <>
                      <small>{t("directoryNoAccess")}</small>
                      <LockKeyhole size={14} />
                    </>
                  )}
                </button>
              ))}
              {!dirs.length && <p>{t("emptyDirectory")}</p>}
            </div>
          )}
          {creating && path && (
            <p className="remote-target">
              <span>{t("remoteTarget")}</span>
              <code>{target}</code>
            </p>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button
            className="secondary-button"
            type="button"
            disabled={busy && !isRemote}
            onClick={close}
          >
            {t("cancel")}
          </button>
          <button
            className="primary-button"
            disabled={busy || (isRemote && !path) || (creating && !name.trim())}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Plus size={15} />
            )}
            {t(
              busy
                ? "working"
                : dialog.type === "clone"
                  ? "clone"
                  : dialog.type === "init" ||
                      dialog.type === "branch" ||
                      dialog.type === "remote" ||
                      creating
                    ? "create"
                    : "open",
            )}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function CommandDialog({ onClose, onCommand }: DialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const commands = [
    { type: "open", key: "open" },
    { type: "clone", key: "clone" },
    { type: "init", key: "init" },
    { type: "server", key: "connect" },
    { type: "settings", key: "settings" },
  ] as const;
  return (
    <Modal title={t("commandMenu")} onClose={onClose}>
      <div className="command-search">
        <Search size={19} />
        <input
          autoFocus
          placeholder={t("searchCommands")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("searchCommands")}
        />
      </div>
      <div className="command-list">
        {commands
          .filter((c) => t(c.key).toLowerCase().includes(query.toLowerCase()))
          .map((c) => (
            <button key={c.type} onClick={() => onCommand(c.type)}>
              <span>{t(c.key)}</span>
              <ChevronRight size={15} />
            </button>
          ))}
      </div>
    </Modal>
  );
}

/**
 * Connection-time prompt for an SSH host. It performs the step it owns and only
 * resolves once the transport accepted the answer, so errors stay in the dialog.
 */
export function AuthDialog({
  request,
  onResolved,
  onClose,
}: {
  request: AuthRequest;
  onResolved: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useStored("saveSshPassword", false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const host = request.host;
  const label = `${host.username ? `${host.username}@` : ""}${host.hostname}${host.port ? `:${host.port}` : ""}`;
  useEffect(() => {
    if (request.kind !== "hostKey" || request.changed) return;
    let active = true;
    gitService.hostKey(host).then(
      (value) => {
        if (active) setFingerprint(value);
      },
      (failure) => {
        if (active) setError(errorText(failure, t));
      },
    );
    return () => {
      active = false;
    };
  }, [host, request.kind, request.changed, t]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (request.kind === "hostKey") await gitService.trust(host);
      else await gitService.connect(host, password, remember);
      onResolved();
    } catch (failure) {
      setError(
        String(failure) === "REPOWEFT_AUTH_REQUIRED"
          ? t("sshPasswordWrong")
          : errorText(failure, t),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t(
        request.kind === "password" ? "sshPasswordTitle" : "hostKeyTitle",
      )}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="modal-content form-fields">
          <div className="dialog-symbol">
            {request.kind === "password" ? (
              <KeyRound size={24} />
            ) : (
              <ShieldCheck size={24} />
            )}
          </div>
          <p className="dialog-description">
            {t(
              request.kind === "password"
                ? "sshPasswordHint"
                : request.changed
                  ? "hostKeyChanged"
                  : "hostKeyHint",
            )}
          </p>
          <code className="auth-host">{label}</code>
          {request.kind === "password" ? (
            <>
              <label>
                {t("password")}
                <input
                  autoFocus
                  required
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>{t("rememberPassword")}</span>
              </label>
              <span className="field-hint">{t("rememberPasswordHint")}</span>
            </>
          ) : (
            !request.changed && (
              <div className="fingerprint">
                <span>{t("fingerprint")}</span>
                <code>{fingerprint || t("fingerprintLoading")}</code>
              </div>
            )
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          {!request.changed && (
            <button
              className="primary-button"
              disabled={busy || (request.kind === "password" && !password)}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : request.kind === "password" ? (
                <KeyRound size={15} />
              ) : (
                <ShieldCheck size={15} />
              )}
              {t(request.kind === "password" ? "connect" : "trustHost")}
            </button>
          )}
        </footer>
      </form>
    </Modal>
  );
}
