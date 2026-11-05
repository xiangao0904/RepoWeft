import {
  AccountsProvider,
  AccountButton,
  RepositoryAccount,
} from "./components/Accounts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Globe2,
  Home as HomeIcon,
  LayoutGrid,
  LoaderCircle,
  Plus,
  Search,
  Server,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  en,
  zh,
  errorText,
  I18nContext,
  type Locale,
  type MessageKey,
} from "./lib/i18n";
import { useStored } from "./lib/storage";
import { desktop, gitService } from "./services/git";
import type {
  Action,
  AuthRequest,
  Repository,
  Snapshot,
  SSHHost,
} from "./types";
import { Brand, Splitter } from "./components/ui";
import {
  Home,
  Workspaces,
  Servers,
  Settings,
  SidebarRepo,
} from "./components/Pages";
import {
  RepositoryView,
  RepoActions,
  type RepoTab,
} from "./components/RepositoryView";
import { AuthDialog, Dialogs, type DialogState } from "./components/Dialogs";
import "./App.css";
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));

// Anything matching this stays clickable inside the titlebar instead of
// turning the whole bar into a window-drag handle.
const TITLEBAR_INTERACTIVE =
  "button, a, input, textarea, select, kbd, [contenteditable='true'], [data-no-drag]";

function isTitlebarChrome(target: EventTarget | null) {
  return (
    target instanceof Element && target.closest(TITLEBAR_INTERACTIVE) === null
  );
}

type Page = "home" | "workspaces" | "servers" | "settings" | "repository";

export default function App() {
  const [locale, setLocale] = useStored<Locale>("locale", "zh-CN");
  const [theme, setTheme] = useStored<string>("theme", "dark");
  const [repositories, setRepositories] = useStored<Repository[]>(
    "repositories",
    [],
  );
  const [openRepositories, setOpenRepositories] = useStored<Repository[]>(
    "openRepositories",
    [],
  );
  const [hosts, setHosts] = useStored<SSHHost[]>("hosts", []);
  const [page, setPage] = useState<Page>("home");
  const [repo, setRepo] = useState<Repository | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<RepoTab>("history");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useStored("terminalHeight", 260);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [auth, setAuth] = useState<AuthRequest | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const repositoryPicker = useRef<HTMLDivElement>(null);
  const operationLock = useRef(false);
  const request = useRef(0);
  const authAnswer = useRef<((value: boolean | null) => void) | null>(null);
  const dictionary = locale === "en" ? en : zh;
  const t = useCallback(
    (key: MessageKey): string => dictionary[key],
    [dictionary],
  );
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );

  // Every SSH call may need a password or a trusted host key; the service asks here.
  useEffect(() => {
    gitService.setAuthPrompt(
      (pending) =>
        new Promise<boolean | null>((resolve) => {
          authAnswer.current?.(null);
          authAnswer.current = resolve;
          setAuth(pending);
        }),
    );
    return () => gitService.setAuthPrompt(null);
  }, []);
  function settleAuth(accepted: boolean | null) {
    const resolve = authAnswer.current;
    authAnswer.current = null;
    setAuth(null);
    resolve?.(accepted);
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [theme, locale]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(
      () => setToast(null),
      toast.error ? 12000 : 3500,
    );
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!desktop) return;
    const sync = () => {
      void gitService
        .sshHosts()
        .then((configured) => {
          setHosts((items) => [
            ...items.filter((h) => !h.id.startsWith("ssh-config:")),
            ...configured,
          ]);
        })
        .catch((error) => notify(errorText(error, t), true));
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [notify, setHosts]);

  async function openRepo(
    next: Repository,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (operationLock.current || signal?.aborted) return false;
    const id = ++request.current;
    const cancel = () => {
      if (request.current === id) {
        ++request.current;
        setBusy(false);
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    setBusy(true);
    const cached = gitService.cachedSnapshot(next);
    if (cached) {
      setRepo(next);
      setData(cached);
      setPage("repository");
      setTab("history");
    }
    try {
      const snapshot = await gitService.snapshot(next);
      if (request.current !== id) return false;
      const existing = repositories.find(
        (r) =>
          r.location.path === next.location.path &&
          r.location.kind === next.location.kind &&
          (r.location.kind !== "ssh" ||
            next.location.kind !== "ssh" ||
            r.location.host.id === next.location.host.id),
      );
      const updated = {
        ...next,
        id: existing?.id ?? next.id,
        favorite: existing?.favorite ?? next.favorite,
        lastOpened: Date.now(),
      };
      setOpenRepositories((items) => {
        const index = items.findIndex((item) => item.id === updated.id);
        return index < 0
          ? [...items, updated]
          : items.map((item, i) => (i === index ? updated : item));
      });
      setRepo(updated);
      setData(snapshot);
      setPage("repository");
      setTab("history");
      if (!next.demo)
        setRepositories((items) => [
          updated,
          ...items.filter((r) => r.id !== updated.id),
        ]);
      return true;
    } catch (error) {
      if (request.current === id && !signal?.aborted)
        notify(errorText(error, t), true);
      return false;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (request.current === id) setBusy(false);
    }
  }
  function closeRepository(id: string) {
    if (busy || operationLock.current) return;
    const index = openRepositories.findIndex((item) => item.id === id);
    const remaining = openRepositories.filter((item) => item.id !== id);
    setOpenRepositories(remaining);
    if (repo?.id !== id) return;
    ++request.current;
    setRepo(null);
    setData(null);
    setTerminalOpen(false);
    setPage("home");
    if (page === "repository" && remaining.length) {
      void openRepo(remaining[Math.min(index, remaining.length - 1)]);
    }
  }

  async function refresh() {
    if (!repo || operationLock.current) return;
    const id = ++request.current;
    setBusy(true);
    try {
      const result = await gitService.snapshot(repo);
      if (id === request.current) setData(result);
    } catch (e) {
      notify(errorText(e, t), true);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  async function action(action: Action): Promise<boolean> {
    if (!repo || operationLock.current || busy) return false;
    operationLock.current = true;
    setBusy(true);
    try {
      await gitService.action(repo, action);
      setData(await gitService.snapshot(repo));
      notify(t("operationSuccess"));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const display =
        message === "DEMO_UNAVAILABLE"
          ? t("unavailableDemo")
          : errorText(error, t);
      notify(display, true);
      try {
        setData(await gitService.snapshot(repo));
      } catch {
        /* Preserve current state when the host is unreachable. */
      }
      return false;
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }
  const latest = useRef({ refresh, setDialog });
  latest.current = { refresh, setDialog };
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        latest.current.setDialog({ type: "commands" });
      }
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        latest.current.setDialog({ type: "open" });
      }
      if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        void latest.current.refresh();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  function saveHost(host: SSHHost) {
    setHosts((items) => [...items.filter((h) => h.id !== host.id), host]);
    setRepositories((items) =>
      items.map((r) =>
        r.location.kind === "ssh" && r.location.host.id === host.id
          ? { ...r, location: { ...r.location, host } }
          : r,
      ),
    );
  }
  function confirm(message: MessageKey, actionValue: Action) {
    setDialog({
      type: "confirm",
      message,
      run: async () => {
        await action(actionValue);
      },
    });
  }
  const repoProps = {
    repositories,
    onOpen: (r: Repository) => {
      void openRepo(r);
    },
    onDialog: setDialog,
    onFavorite: (id: string) =>
      setRepositories((items) =>
        items.map((r) => (r.id === id ? { ...r, favorite: !r.favorite } : r)),
      ),
    onForget: (id: string) =>
      setRepositories((items) => items.filter((r) => r.id !== id)),
    onViewAll: () => setPage("workspaces"),
    onServers: () => setPage("servers"),
  };
  const isRepo = page === "repository" && repo && data;
  const nav = [
    { page: "home", key: "home", icon: HomeIcon },
    { page: "workspaces", key: "workspaces", icon: LayoutGrid },
    { page: "servers", key: "servers", icon: Server },
    { page: "settings", key: "settings", icon: SettingsIcon },
  ] as const;
  const tabs = [
    { key: "history", icon: GitCommitHorizontal },
    { key: "changes", icon: FolderGit2 },
    { key: "branches", icon: GitBranch },
    { key: "remotes", icon: Globe2 },
  ] as const;

  // Drag the window from anywhere in the titlebar that is not an interactive
  // control, instead of only the few pixels the native drag attribute covered.
  const onTitlebarPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!desktop || event.button !== 0 || !isTitlebarChrome(event.target)) {
      return;
    }
    void getCurrentWindow().startDragging();
  };

  const onTitlebarDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!desktop || !isTitlebarChrome(event.target)) return;
    void getCurrentWindow().toggleMaximize();
  };

  return (
    <I18nContext.Provider value={{ locale, t }}>
      <AccountsProvider>
        <div className="app-shell">
          <header
            className="titlebar"
            onPointerDown={onTitlebarPointerDown}
            onDoubleClick={onTitlebarDoubleClick}
          >
            <button className="app-brand" onClick={() => setPage("home")}>
              <Brand />
              <strong>RepoWeft</strong>
            </button>
            <div className="titlebar-main">
              <div className="breadcrumbs">
                {isRepo ? (
                  <>
                    <button
                      className="icon-button"
                      aria-label={t("back")}
                      onClick={() => setPage("home")}
                    >
                      <ArrowLeft size={15} />
                    </button>
                    <span className="breadcrumb-separator" />
                    <FolderGit2 size={15} />
                    <strong>{repo.name}</strong>
                    <span
                      className={`location-pill ${repo.location.kind === "ssh" ? "ssh" : ""}`}
                    >
                      {repo.demo
                        ? t("demo")
                        : repo.location.kind === "ssh"
                          ? `SSH · ${repo.location.host.name}`
                          : t("local")}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="workspace-breadcrumb">
                      {t("workspaces")}
                    </span>
                    <ChevronRight size={13} />
                    <span>{t(page as Exclude<Page, "repository">)}</span>
                  </>
                )}
              </div>
              <button
                className="global-search"
                onClick={() => setDialog({ type: "commands" })}
              >
                <Search size={14} />
                <span>{t("commandMenu")}</span>
                <kbd>Ctrl K</kbd>
              </button>
            </div>
            {desktop && (
              <div className="window-controls">
                <button
                  aria-label={locale === "en" ? "Minimize" : "最小化"}
                  onClick={() => void getCurrentWindow().minimize()}
                >
                  −
                </button>
                <button
                  aria-label={
                    locale === "en" ? "Maximize or restore" : "最大化或还原"
                  }
                  onClick={() => void getCurrentWindow().toggleMaximize()}
                >
                  □
                </button>
                <button
                  className="window-close"
                  aria-label={t("close")}
                  onClick={() => void getCurrentWindow().close()}
                >
                  ×
                </button>
              </div>
            )}
          </header>
          <div className="app-body">
            <aside className="sidebar">
              <nav className="primary-nav">
                {nav.map((item) => (
                  <button
                    key={item.page}
                    className={page === item.page ? "active" : ""}
                    onClick={() => setPage(item.page)}
                  >
                    <item.icon size={17} strokeWidth={1.7} />
                    <span>{t(item.key)}</span>
                    {page === item.page && <span className="nav-indicator" />}
                  </button>
                ))}
              </nav>
              {repo && data && (
                <div className="sidebar-section current-repository">
                  <div className="sidebar-section-title">
                    <span>{repo.name}</span>
                    <span className="tiny-status" />
                  </div>
                  {tabs.map((item) => (
                    <button
                      key={item.key}
                      className={`repo-nav ${isRepo && tab === item.key ? "active" : ""}`}
                      onClick={() => {
                        setPage("repository");
                        setTab(item.key);
                      }}
                    >
                      <item.icon size={16} />
                      <span>{t(item.key)}</span>
                      {item.key === "changes" && data.files.length > 0 && (
                        <span className="count">{data.files.length}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="sidebar-section workspace-switcher">
                <div className="sidebar-section-title">
                  <span>{t("openRepositories")}</span>
                  <button
                    className="icon-button"
                    title={t("open")}
                    aria-label={t("open")}
                    popoverTarget="repository-picker"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      const picker = repositoryPicker.current;
                      if (picker) {
                        picker.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
                        picker.style.top = `${Math.min(rect.bottom + 8, Math.max(8, window.innerHeight - 360))}px`;
                      }
                    }}
                  >
                    <Plus size={14} />
                  </button>
                  <div
                    id="repository-picker"
                    ref={repositoryPicker}
                    popover="auto"
                    className="repository-picker"
                  >
                    <div className="repository-picker-actions">
                      <button
                        onClick={() => {
                          repositoryPicker.current?.hidePopover();
                          setDialog({ type: "open" });
                        }}
                      >
                        <FolderGit2 size={15} />
                        {t("open")}
                      </button>
                      <button
                        onClick={() => {
                          repositoryPicker.current?.hidePopover();
                          setDialog({ type: "clone" });
                        }}
                      >
                        <ArrowDownToLine size={15} />
                        {t("clone")}
                      </button>
                    </div>
                    <div className="repository-picker-label">{t("recent")}</div>
                    <div className="repository-picker-list">
                      {repositories.slice(0, 20).map((item) => (
                        <button
                          key={item.id}
                          disabled={busy}
                          onClick={() => {
                            repositoryPicker.current?.hidePopover();
                            void openRepo(item);
                          }}
                          title={item.location.path}
                        >
                          {item.location.kind === "ssh" ? (
                            <Server size={16} />
                          ) : (
                            <FolderGit2 size={16} />
                          )}
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {item.location.kind === "ssh"
                                ? `${item.location.host.name} · ${item.location.path}`
                                : item.location.path}
                            </small>
                          </span>
                          {openRepositories.some(
                            (opened) => opened.id === item.id,
                          ) && <Check size={14} />}
                        </button>
                      ))}
                      {!repositories.length && (
                        <p>{t("noRepositoriesDescription")}</p>
                      )}
                    </div>
                  </div>
                </div>
                {openRepositories.map((r) => (
                  <SidebarRepo
                    key={r.id}
                    repo={r}
                    active={Boolean(isRepo && repo.id === r.id)}
                    closeDisabled={busy}
                    onClose={() => closeRepository(r.id)}
                    onClick={() => {
                      void openRepo(r);
                    }}
                  />
                ))}
                {!openRepositories.length && (
                  <button
                    className="sidebar-empty-action"
                    onClick={() => setDialog({ type: "open" })}
                  >
                    <FolderGit2 size={15} />
                    {t("open")}
                    <Plus size={12} />
                  </button>
                )}
              </div>
              <div className="sidebar-bottom">
                <AccountButton />
                <div className="quick-actions">
                  <span>{t("quickActions")}</span>
                  <button onClick={() => setDialog({ type: "open" })}>
                    {t("open")}
                    <kbd>Ctrl O</kbd>
                  </button>
                  <button onClick={() => setDialog({ type: "clone" })}>
                    {t("clone")}
                    <ArrowRight size={12} />
                  </button>
                  <button onClick={() => setDialog({ type: "commands" })}>
                    {t("commandMenu")}
                    <kbd>Ctrl K</kbd>
                  </button>
                </div>
                <div className="sidebar-version">
                  <span className="version-mark">
                    <Brand />
                    v0.1.0
                  </span>
                  <button
                    className="icon-button"
                    aria-label={t("about")}
                    onClick={() => setPage("settings")}
                  >
                    <CircleHelp size={15} />
                  </button>
                </div>
              </div>
            </aside>
            <main className="main-content">
              {isRepo ? (
                <>
                  <div className="workspace-toolbar">
                    <div className="workspace-tabs">
                      {tabs.map((item) => (
                        <button
                          key={item.key}
                          className={tab === item.key ? "active" : ""}
                          onClick={() => setTab(item.key)}
                        >
                          <item.icon size={15} />
                          {t(item.key)}
                          {item.key === "changes" && data.files.length > 0 && (
                            <span className="count">{data.files.length}</span>
                          )}
                        </button>
                      ))}
                      <button
                        className={terminalOpen ? "active" : ""}
                        aria-pressed={terminalOpen}
                        onClick={() => setTerminalOpen((open) => !open)}
                      >
                        <TerminalIcon size={15} />
                        {t("terminal")}
                      </button>
                    </div>
                    <RepositoryAccount key={repo.id} repo={repo} />
                    <RepoActions
                      busy={busy}
                      onAction={action}
                      onRefresh={() => void refresh()}
                    />
                  </div>
                  {repo.demo && (
                    <div className="demo-notice">
                      <span className="demo-tag">DEMO</span>
                      {t("demoNotice")}
                    </div>
                  )}
                  <div className="repository-content-pane">
                    <RepositoryView
                      repo={repo}
                      data={data}
                      tab={tab}
                      busy={busy}
                      onAction={action}
                      onPrompt={(type) => setDialog({ type })}
                      onConfirm={confirm}
                      notify={notify}
                      terminal={
                        terminalOpen && (
                          <>
                            <Splitter
                              orientation="horizontal"
                              onResize={(delta) =>
                                setTerminalHeight((height) =>
                                  Math.max(
                                    140,
                                    Math.min(
                                      window.innerHeight * 0.65,
                                      height - delta,
                                    ),
                                  ),
                                )
                              }
                            />
                            <div
                              className="repository-terminal-pane"
                              style={{ height: terminalHeight }}
                            >
                              <Suspense
                                fallback={
                                  <div className="terminal-status">
                                    {t("terminalStarting")}
                                  </div>
                                }
                              >
                                <TerminalPanel
                                  key={repo.id}
                                  repo={repo}
                                  onClose={() => setTerminalOpen(false)}
                                />
                              </Suspense>
                            </div>
                          </>
                        )
                      }
                    />
                  </div>
                </>
              ) : page === "home" ? (
                <Home {...repoProps} />
              ) : page === "workspaces" ? (
                <Workspaces {...repoProps} />
              ) : page === "servers" ? (
                <Servers
                  hosts={hosts}
                  onDialog={setDialog}
                  onRemove={(id) =>
                    setDialog({
                      type: "confirm",
                      message: "removeServerWarning",
                      run: async () => {
                        setHosts((items) => items.filter((h) => h.id !== id));
                      },
                    })
                  }
                />
              ) : (
                <Settings
                  locale={locale}
                  setLocale={setLocale}
                  theme={theme}
                  setTheme={setTheme}
                />
              )}
            </main>
          </div>
          {toast && (
            <div
              className={`toast ${toast.error ? "error" : ""}`}
              role={toast.error ? "alert" : "status"}
            >
              {toast.error ? <CircleHelp size={18} /> : <Check size={18} />}
              <span>{toast.message}</span>
              <button
                className="icon-button"
                aria-label={t("close")}
                onClick={() => setToast(null)}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {busy && !isRepo && (
            <div className="opening-indicator">
              <LoaderCircle className="spin" size={16} />
              {t("working")}
            </div>
          )}
          {dialog && (
            <Dialogs
              key={`${dialog.type}:${"host" in dialog ? dialog.host?.id : ""}`}
              dialog={dialog}
              onClose={() => setDialog(null)}
              onOpen={openRepo}
              onSaveHost={saveHost}
              onAction={action}
              onCommand={(type) => {
                if (type === "settings" || type === "server") {
                  setPage(type === "settings" ? "settings" : "servers");
                  setDialog(null);
                } else setDialog({ type });
              }}
            />
          )}
          {auth && (
            <AuthDialog
              key={`${auth.kind}:${auth.host.id}:${auth.retry}`}
              request={auth}
              onResolved={() => settleAuth(true)}
              onClose={() => settleAuth(null)}
            />
          )}
        </div>
      </AccountsProvider>
    </I18nContext.Provider>
  );
}
