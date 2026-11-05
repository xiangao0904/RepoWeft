import { AccountSettings } from "./Accounts";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  FolderGit2,
  Globe2,
  Heart,
  KeyRound,
  Laptop,
  Moon,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Star,
  Sun,
  Terminal,
  Trash2,
  Wifi,
} from "lucide-react";
import type { Repository, SSHHost } from "../types";
import { errorText, relativeTime, useI18n, type Locale } from "../lib/i18n";
import { Brand, Empty } from "./ui";
import { desktop, gitService } from "../services/git";
import type { DialogState } from "./Dialogs";

interface RepositoriesProps {
  repositories: Repository[];
  onOpen: (repo: Repository) => void;
  onDialog: (dialog: DialogState) => void;
  onFavorite: (id: string) => void;
  onForget: (id: string) => void;
  onViewAll: () => void;
  onServers: () => void;
}
export function Home(props: RepositoriesProps) {
  const { t } = useI18n();
  return (
    <div className="home-page">
      <div className="home-inner">
        <div className="hero">
          <div className="hero-kicker">
            <span className="tiny-line" />
            {t("tagline")}
          </div>
          <Brand large />
          <h1>{t("welcome")}</h1>
          <p>{t("homeDescription")}</p>
        </div>
        <div className="action-cards">
          {(
            [
              {
                type: "open",
                title: "open",
                desc: "openDescription",
                icon: FolderGit2,
                shortcut: "Ctrl O",
              },
              {
                type: "clone",
                title: "clone",
                desc: "cloneDescription",
                icon: ArrowDownToLine,
                shortcut: "",
              },
              {
                type: "server",
                title: "connect",
                desc: "connectDescription",
                icon: Server,
                shortcut: "",
              },
            ] as const
          ).map((card) => (
            <button
              className="action-card"
              key={card.type}
              onClick={() =>
                card.type === "server"
                  ? props.onServers()
                  : props.onDialog({ type: card.type })
              }
            >
              <card.icon size={24} strokeWidth={1.5} />
              <strong>{t(card.title)}</strong>
              <p>{t(card.desc)}</p>
              <div className="action-card-bottom">
                <span>{card.shortcut && <kbd>{card.shortcut}</kbd>}</span>
                <ArrowRight size={17} />
              </div>
            </button>
          ))}
        </div>
        <div className="home-extra-action">
          <button
            className="text-button"
            onClick={() => props.onDialog({ type: "init" })}
          >
            <Plus size={12} />
            {t("init")}
          </button>
        </div>
        <div className="recent-heading">
          <h2>
            {t("recent")}
            <span>{props.repositories.length.toString().padStart(2, "0")}</span>
          </h2>
          <button className="text-button" onClick={props.onViewAll}>
            {t("viewAll")}
            <ArrowRight size={14} />
          </button>
        </div>
        <RepositoryTable
          {...props}
          repositories={props.repositories.slice(0, 5)}
        />
      </div>
    </div>
  );
}
export function Workspaces(props: RepositoriesProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(false);
  const filtered = props.repositories.filter(
    (r) =>
      (!favorites || r.favorite) &&
      `${r.name} ${r.location.path}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="standard-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">REPOWEFT</span>
          <h1>{t("workspaces")}</h1>
          <p>{t("homeDescription")}</p>
        </div>
        <button
          className="primary-button"
          onClick={() => props.onDialog({ type: "open" })}
        >
          <Plus size={16} />
          {t("open")}
        </button>
      </div>
      <div className="workspace-filters">
        <div className="segmented">
          <button
            className={!favorites ? "active" : ""}
            onClick={() => setFavorites(false)}
          >
            {t("all")}
          </button>
          <button
            className={favorites ? "active" : ""}
            onClick={() => setFavorites(true)}
          >
            <Star size={13} />
            {t("favorites")}
          </button>
        </div>
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label={t("searchRepos")}
            placeholder={t("searchRepos")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <RepositoryTable {...props} repositories={filtered} />
    </div>
  );
}

function RepositoryTable({
  repositories,
  onOpen,
  onFavorite,
  onForget,
}: RepositoriesProps) {
  const { t, locale } = useI18n();
  return (
    <div className="repository-table">
      {repositories.length > 0 && (
        <div className="table-header">
          <span>{t("repository")}</span>
          <span>{t("location")}</span>
          <span>{t("lastOpened")}</span>
          <span />
        </div>
      )}
      <div className="table-rows">
        {repositories.length > 0 ? (
          repositories.map((repo) => (
            <div className="repository-table-row" key={repo.id}>
              <button className="repo-open-button" onClick={() => onOpen(repo)}>
                <span className="repo-folder-icon">
                  <FolderGit2 size={22} strokeWidth={1.5} />
                </span>
                <span>
                  <strong>
                    {repo.name}
                    {repo.demo && <span className="demo-tag">DEMO</span>}
                  </strong>
                  <small>{repo.location.path}</small>
                </span>
              </button>
              <span
                className={`location-pill ${repo.location.kind === "ssh" ? "ssh" : ""}`}
              >
                {repo.location.kind === "ssh" ? (
                  <>
                    <Server size={12} />
                    {repo.location.host.name}
                  </>
                ) : (
                  <>
                    <Laptop size={12} />
                    {t("local")}
                  </>
                )}
              </span>
              <span className="last-opened">
                {relativeTime(repo.lastOpened, locale, t)}
              </span>
              <div className="repo-row-actions">
                <button
                  className={`icon-button ${repo.favorite ? "favorited" : ""}`}
                  onClick={() => onFavorite(repo.id)}
                  aria-label={`${t("favorite")} ${repo.name}`}
                >
                  <Star
                    size={16}
                    fill={repo.favorite ? "currentColor" : "none"}
                  />
                </button>
                <button
                  className="icon-button forget-button"
                  onClick={() => onForget(repo.id)}
                  aria-label={`${t("forget")} ${repo.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        ) : (
          <Empty
            title={t("noRepositories")}
            description={t("noRepositoriesDescription")}
          />
        )}
      </div>
    </div>
  );
}

export function Servers({
  hosts,
  onDialog,
  onRemove,
}: {
  hosts: SSHHost[];
  onDialog: (dialog: DialogState) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Record<string, "busy" | "ok" | "error">>(
    {},
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void Promise.all(
      hosts.map((host) =>
        gitService.passwordSaved(host).then(
          (value) => [host.id, value] as const,
          () => null,
        ),
      ),
    ).then((entries) => {
      if (!active) return;
      setSaved(
        Object.fromEntries(entries.filter((entry) => entry !== null)) as Record<
          string,
          boolean
        >,
      );
    });
    return () => {
      active = false;
    };
  }, [hosts]);
  async function test(host: SSHHost) {
    if (!desktop) {
      setErrors((p) => ({ ...p, [host.id]: t("desktopOnly") }));
      return;
    }
    setStatus((p) => ({ ...p, [host.id]: "busy" }));
    setErrors((p) => ({ ...p, [host.id]: "" }));
    try {
      await gitService.test(host);
      setStatus((p) => ({ ...p, [host.id]: "ok" }));
    } catch (e) {
      setStatus((p) => ({ ...p, [host.id]: "error" }));
      setErrors((p) => ({ ...p, [host.id]: errorText(e, t) }));
    }
  }
  return (
    <div className="standard-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">SSH WORKSPACE</span>
          <h1>{t("servers")}</h1>
          <p>{t("serverDescription")}</p>
        </div>
        <button
          className="primary-button"
          onClick={() => onDialog({ type: "server" })}
        >
          <Plus size={16} />
          {t("addServer")}
        </button>
      </div>
      {hosts.length ? (
        <div className="server-grid">
          {hosts.map((host) => (
            <section className="server-card" key={host.id}>
              <div className="server-card-heading">
                <span className="server-icon">
                  <Server size={23} />
                </span>
                <span
                  className={`connection-status ${status[host.id] === "ok" ? "online" : ""}`}
                >
                  <i />
                  {t(status[host.id] === "ok" ? "connected" : "configured")}
                </span>
                <button
                  className="icon-button"
                  title={t("editServer")}
                  aria-label={`${t("editServer")} ${host.name}`}
                  onClick={() => onDialog({ type: "server", host })}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button danger-hover"
                  title={t("remove")}
                  aria-label={`${t("remove")} ${host.name}`}
                  onClick={() => onRemove(host.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <h2>{host.name}</h2>
              <code>
                {host.username ? `${host.username}@` : ""}
                {host.hostname}
                {host.port ? `:${host.port}` : ""}
              </code>
              {saved[host.id] && (
                <p className="saved-credential">
                  <KeyRound size={12} />
                  {t("passwordSaved")}
                  <button
                    className="text-button"
                    onClick={() => {
                      void gitService
                        .forgetPassword(host)
                        .then(() =>
                          setSaved((p) => ({ ...p, [host.id]: false })),
                        );
                    }}
                  >
                    {t("forgetPassword")}
                  </button>
                </p>
              )}
              <div className="server-card-footer">
                <button
                  className="secondary-button"
                  disabled={status[host.id] === "busy"}
                  onClick={() => void test(host)}
                >
                  <Wifi size={14} />
                  {t(status[host.id] === "busy" ? "working" : "testConnection")}
                </button>
                <button
                  className="text-button"
                  onClick={() => onDialog({ type: "remoteCreate", host })}
                >
                  {t("newRemote")}
                  <Plus size={13} />
                </button>
                <button
                  className="text-button"
                  onClick={() => onDialog({ type: "remoteOpen", host })}
                >
                  {t("openRemote")}
                  <ArrowRight size={14} />
                </button>
              </div>
              {errors[host.id] && (
                <p className="inline-error">{errors[host.id]}</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="server-empty">
          <Empty
            icon={<Server size={32} />}
            title={t("noServers")}
            description={t("noServersDescription")}
          >
            <button
              className="secondary-button"
              onClick={() => onDialog({ type: "server" })}
            >
              <Plus size={15} />
              {t("addServer")}
            </button>
          </Empty>
        </div>
      )}
    </div>
  );
}

export function Settings({
  locale,
  setLocale,
  theme,
  setTheme,
}: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: string;
  setTheme: (theme: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="standard-page settings-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">REPOWEFT</span>
          <h1>{t("settings")}</h1>
          <p>{t("settingsDescription")}</p>
        </div>
      </div>
      <AccountSettings />
      <section className="settings-section">
        <h3 className="section-label">{t("appearance")}</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <strong>{t("theme")}</strong>
              <p>{t("settingsDescription")}</p>
            </div>
            <div className="theme-picker">
              <button
                className={theme === "dark" ? "active" : ""}
                onClick={() => setTheme("dark")}
              >
                <Moon size={16} />
                {t("dark")}
                {theme === "dark" && <Check size={13} />}
              </button>
              <button
                className={theme === "light" ? "active" : ""}
                onClick={() => setTheme("light")}
              >
                <Sun size={16} />
                {t("light")}
                {theme === "light" && <Check size={13} />}
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>
                <Globe2 size={15} />
                {t("language")}
              </strong>
              <p>{t("languageDescription")}</p>
            </div>
            <select
              aria-label={t("language")}
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3 className="section-label">{t("behavior")}</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div>
              <strong>
                <Terminal size={15} />
                {t("gitIntegration")}
              </strong>
              <p>{t("gitDescription")}</p>
            </div>
            <span className="settings-badge">PATH</span>
          </div>
          <div className="settings-row">
            <div>
              <strong>
                <ShieldCheck size={15} />
                {t("privacy")}
              </strong>
              <p>{t("privacyDescription")}</p>
            </div>
            <ShieldCheck size={20} className="addition" />
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3 className="section-label">{t("shortcuts")}</h3>
        <div className="settings-card">
          {(["openShortcut", "searchShortcut", "refreshShortcut"] as const).map(
            (key, i) => (
              <div className="settings-row shortcut-row" key={key}>
                <strong>{t(key)}</strong>
                <kbd>{["Ctrl O", "Ctrl K", "Ctrl R"][i]}</kbd>
              </div>
            ),
          )}
        </div>
      </section>
      <div className="about-card">
        <Brand />
        <div>
          <strong>
            RepoWeft <span>v0.1.0</span>
          </strong>
          <p>{t("aboutDescription")}</p>
        </div>
        <Heart size={17} />
      </div>
    </div>
  );
}

export function SidebarRepo({
  repo,
  active,
  onClick,
}: {
  repo: Repository;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`sidebar-repo ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <FolderGit2 size={16} />
      <span>
        <strong>{repo.name}</strong>
        <small>
          {repo.location.kind === "ssh"
            ? repo.location.host.name
            : repo.location.path}
        </small>
      </span>
      <ChevronRight size={13} />
    </button>
  );
}
