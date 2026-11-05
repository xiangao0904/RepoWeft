import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { desktop } from "../services/git";
import { errorText, useI18n } from "../lib/i18n";
import { useStored } from "../lib/storage";
import type { Repository } from "../types";
import { Modal } from "./ui";

type Account = {
  id: string;
  login: string;
  method: "oauth" | "pat";
  reauthorize: boolean;
};
type DevicePrompt = {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  accountLogin: string | null;
  phase: "waiting" | "retrying" | "profile";
};
function GitHubMark() {
  return <span className="github-mark" aria-hidden="true" />;
}
function AccountAvatar({ account }: { account: Account }) {
  const [failed, setFailed] = useState(false);
  const src = /^\d+$/.test(account.id)
    ? `https://avatars.githubusercontent.com/u/${account.id}?s=80&v=4`
    : null;
  return (
    <span className="account-avatar" aria-hidden="true">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{account.login.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
type Accounts = { accounts: Account[]; activeId: string | null };
type Configuration = { configured: boolean; installationUrl: string | null };
const empty: Accounts = { accounts: [], activeId: null };
const Context = createContext<{
  state: Accounts;
  show: () => void;
  select: (id: string) => Promise<void>;
}>({ state: empty, show: () => {}, select: async () => {} });
export function AccountsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<Accounts>(empty);
  const [configuration, setConfiguration] = useState<Configuration>({
    configured: false,
    installationUrl: null,
  });
  const [visible, setVisible] = useState(false);
  const [seen, setSeen] = useStored("accountsWelcomeSeen", false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [device, setDevice] = useState<DevicePrompt | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const initial = useRef({ seen, t });
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const reload = () =>
      invoke<Accounts>("accounts_list").then((data) => {
        if (active) setState(data);
      });
    void Promise.all([
      invoke<Accounts>("accounts_list"),
      invoke<Configuration>("github_oauth_configuration"),
    ])
      .then(([data, configuration]) => {
        if (!active) return;
        setState(data);
        setConfiguration(configuration);
        if (!initial.current.seen && !data.accounts.length) setVisible(true);
      })
      .catch((e) => {
        if (active) {
          setError(errorText(e, initial.current.t));
          setVisible(true);
        }
      });
    const reauthorize = () => {
      if (!document.querySelector('[role="dialog"]')) setVisible(true);
      setError(initial.current.t("accountReauthorizeHint"));
      void reload().catch(() => {});
    };
    window.addEventListener("repoweft:reauthorize", reauthorize);
    return () => {
      active = false;
      if (lock.current) void invoke("github_oauth_cancel").catch(() => {});
      window.removeEventListener("repoweft:reauthorize", reauthorize);
    };
  }, []);
  function show() {
    setError("");
    setVisible(true);
  }
  function close() {
    if (lock.current) return;
    setVisible(false);
    setToken("");
    setError("");
    setSeen(true);
  }
  async function run(command: string, args?: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const oauth = command === "github_oauth_login";
    setOauthPending(oauth);
    setDevice(null);
    setCopied(false);
    try {
      if (!desktop) throw "ACCOUNT_DESKTOP_ONLY";
      setState(await invoke<Accounts>(command, args));
      setToken("");
      setSeen(true);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      lock.current = false;
      setBusy(false);
      setOauthPending(false);
      setDevice(null);
    }
  }
  function login(accountId?: string) {
    if (lock.current) return;
    const onDevice = new Channel<DevicePrompt>();
    onDevice.onmessage = (prompt) => setDevice(prompt);
    void run("github_oauth_login", {
      accountId: accountId ?? null,
      onDevice,
    });
  }
  async function open(url: string) {
    try {
      await openUrl(url);
    } catch {
      setError(t("oauthBrowserFailed"));
    }
  }
  return (
    <Context.Provider
      value={{ state, show, select: (id) => run("account_select", { id }) }}
    >
      {children}
      {visible && (
        <Modal
          title={t(state.accounts.length ? "accounts" : "accountSignIn")}
          onClose={close}
        >
          <div className="modal-content account-content">
            <div className="account-heading">
              <span className="account-provider-icon">
                <GitHubMark />
              </span>
              <div>
                <h3>
                  {t(state.accounts.length ? "accounts" : "accountSignIn")}
                </h3>
                <p>{t("accountLoginDescription")}</p>
              </div>
            </div>
            <button
              className="primary-button github-sign-in"
              disabled={busy || !desktop || !configuration.configured}
              onClick={() => login()}
            >
              <GitHubMark />
              {t(
                state.accounts.length
                  ? "accountAddGithub"
                  : "accountSignInGithub",
              )}
            </button>
            {!configuration.configured && (
              <p className="field-hint">{t("oauthNotConfigured")}</p>
            )}
            {device && (
              <div className="device-authorization">
                <p>{t("oauthDeviceInstructions")}</p>
                {device.accountLogin && (
                  <p className="field-hint">
                    {t("oauthDeviceAccount")}{" "}
                    <strong>{device.accountLogin}</strong>
                  </p>
                )}
                <div className="device-code-row">
                  <code aria-label={t("oauthDeviceCode")}>
                    {device.userCode}
                  </code>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(device.userCode)
                        .then(() => setCopied(true))
                        .catch(() => setError(t("oauthCopyFailed")))
                    }
                  >
                    {t(copied ? "oauthCopied" : "oauthCopyCode")}
                  </button>
                </div>
                <button
                  className="text-button"
                  onClick={() => void open(device.verificationUri)}
                >
                  {t("oauthOpenGithub")}
                </button>
                <p className="field-hint">{t("oauthDeviceExpiry")}</p>
              </div>
            )}
            {oauthPending && (
              <div className="oauth-pending" role="status">
                <LoaderCircle size={16} className="spin" />
                <span>
                  {t(
                    device?.phase === "retrying"
                      ? "oauthRetrying"
                      : device?.phase === "profile"
                        ? "oauthLoadingProfile"
                        : "oauthWaiting",
                  )}
                </span>
                <button
                  className="text-button"
                  onClick={() =>
                    void invoke("github_oauth_cancel").catch(() =>
                      setError(t("oauthCancelFailed")),
                    )
                  }
                >
                  {t("cancel")}
                </button>
              </div>
            )}
            <div className="account-list">
              {state.accounts.map((account) => (
                <div className="account-row" key={account.id}>
                  <div className="account-identity">
                    <AccountAvatar key={account.id} account={account} />
                    <div className="account-identity-text">
                      <strong>{account.login}</strong>
                      <small>
                        {t(
                          account.method === "oauth"
                            ? "accountOAuth"
                            : "accountPat",
                        )}{" "}
                        ·{" "}
                        {t(
                          account.reauthorize
                            ? "accountReauthorize"
                            : account.id === state.activeId
                              ? "accountActive"
                              : "accountSaved",
                        )}
                      </small>
                    </div>
                  </div>
                  <div className="account-row-actions">
                    <button
                      className="secondary-button"
                      aria-label={`${t("accountSwitch")} ${account.login}`}
                      disabled={busy || account.id === state.activeId}
                      onClick={() =>
                        void run("account_select", { id: account.id })
                      }
                    >
                      {t("accountSwitch")}
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || !configuration.configured}
                      aria-label={`${t("accountReauthorize")} ${account.login}`}
                      onClick={() => login(account.id)}
                    >
                      {t("accountReauthorize")}
                    </button>
                    {account.method === "oauth" && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void run("account_use_pat", { id: account.id })
                        }
                      >
                        {t("accountUsePat")}
                      </button>
                    )}
                    <button
                      className="text-button danger-hover"
                      disabled={busy}
                      aria-label={`${t("remove")} ${account.login}`}
                      onClick={() =>
                        void run("account_remove", { id: account.id })
                      }
                    >
                      {t("remove")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {configuration.installationUrl && (
              <div className="account-access">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void open(configuration.installationUrl!)}
                >
                  {t("accountManageAccess")}
                </button>
                <p className="field-hint">{t("accountInstallationHint")}</p>
              </div>
            )}
            <details className="account-advanced">
              <summary>{t("accountWithToken")}</summary>
              <form
                id="account-connect"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (token.trim()) void run("account_connect", { token });
                }}
              >
                <label htmlFor="github-token">{t("accountToken")}</label>
                <input
                  id="github-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  disabled={busy}
                  onChange={(e) => setToken(e.target.value)}
                />
                <p className="field-hint">{t("accountTokenHint")}</p>
                <a
                  href="https://github.com/settings/personal-access-tokens/new"
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    if (desktop) {
                      e.preventDefault();
                      void open(e.currentTarget.href);
                    }
                  }}
                >
                  {t("accountCreateToken")}
                </a>
                <button
                  className="secondary-button"
                  disabled={busy || !token.trim()}
                >
                  <Plus size={14} />
                  {t("accountConnect")}
                </button>
              </form>
            </details>
            <p className="dialog-description">{t("accountScopeHint")}</p>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={close}
            >
              {t(state.accounts.length ? "close" : "accountLater")}
            </button>
          </footer>
        </Modal>
      )}
    </Context.Provider>
  );
}
export function AccountButton() {
  const { state, show } = useContext(Context);
  const { t } = useI18n();
  const active = state.accounts.find((a) => a.id === state.activeId);
  return (
    <button
      className="account-entry"
      onClick={show}
      aria-label={
        active ? `${t("accountManage")} · ${active.login}` : t("accountSignIn")
      }
      title={t("accounts")}
    >
      {active ? (
        <AccountAvatar key={active.id} account={active} />
      ) : (
        <span className="account-provider-icon">
          <GitHubMark />
        </span>
      )}
      <span className="account-entry-text">
        <strong>{active?.login ?? t("accountSignIn")}</strong>
        <small>{t(active ? "accountManage" : "accountSignedOut")}</small>
      </span>
      <ChevronDown
        size={14}
        className="account-entry-chevron"
        aria-hidden="true"
      />
    </button>
  );
}
export function AccountSettings() {
  const { t } = useI18n();
  return (
    <section className="settings-section">
      <h3 className="section-label">{t("accounts")}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <strong>{t("accounts")}</strong>
            <p>{t("accountsDescription")}</p>
          </div>
          <AccountButton />
        </div>
      </div>
    </section>
  );
}
export function RepositoryAccount({ repo }: { repo: Repository }) {
  const { state } = useContext(Context);
  const { t } = useI18n();
  const [binding, setBinding] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const local = repo.location.kind === "local" && !repo.demo;
  const path = repo.location.path;
  useEffect(() => {
    const id = ++request.current;
    setBusy(true);
    setError("");
    if (!desktop || !local) return;
    void invoke<string | null>("account_repository_get", { path })
      .then((value) => {
        if (request.current === id) setBinding(value ?? "");
      })
      .catch((e) => {
        if (request.current === id) setError(errorText(e, t));
      })
      .finally(() => {
        if (request.current === id) setBusy(false);
      });
    return () => {
      ++request.current;
    };
  }, [path, local, t]);
  if (!local) return null;
  async function change(value: string) {
    const id = request.current;
    setBusy(true);
    setError("");
    try {
      await invoke("account_repository_set", { path, id: value || null });
      if (id === request.current) setBinding(value);
    } catch (e) {
      if (id === request.current) setError(errorText(e, t));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  return (
    <div className="repository-account">
      <label>
        <GitHubMark />
        <select
          aria-label={t("repositoryAccount")}
          title={t("accountIdentityHint")}
          disabled={busy || !desktop}
          value={binding}
          onChange={(e) => void change(e.target.value)}
        >
          <option value="">{t("accountFollowDefault")}</option>
          <option value="system">{t("accountSystemCredentials")}</option>
          {binding &&
            binding !== "system" &&
            !state.accounts.some((a) => a.id === binding) && (
              <option value={binding}>{t("accountBindingMissing")}</option>
            )}
          {state.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.login}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
