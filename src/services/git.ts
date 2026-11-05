import { ReadRequests } from "../lib/requests";
import { BudgetCache } from "../lib/cache";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Action,
  AuthPrompt,
  DirectoryEntry,
  Commit,
  CommitDetail,
  ConflictVersions,
  DiffDocument,
  DiffPage,
  DiffSource,
  Repository,
  Snapshot,
  SSHHost,
} from "../types";
import { demoDetail, demoDiff, demoSnapshot } from "./demo";
import { warmGithubAvatars, cancelGithubAvatars } from "../lib/avatars";

export const desktop = isTauri();
let sample: Snapshot = structuredClone(demoSnapshot);

const reads = new ReadRequests();
const diffClosers = new Map<string, Set<() => void>>();
const snapshots = new BudgetCache<Snapshot>(
  16 * 1024 * 1024,
  300_000,
  Date.now,
  8,
);
const details = new BudgetCache<CommitDetail>(8 * 1024 * 1024, 300_000);
setInterval(() => {
  snapshots.prune();
  details.prune();
}, 60_000);
function repoKey(repo: Repository) {
  return JSON.stringify(repo.location);
}
function hostOf(repo: Repository): SSHHost | undefined {
  return repo.location.kind === "ssh" ? repo.location.host : undefined;
}

/** Signals the Rust side returns instead of a raw OpenSSH error. */
const AUTH_REQUIRED = "REPOWEFT_AUTH_REQUIRED";
const HOST_KEY_UNKNOWN = "REPOWEFT_HOST_KEY_UNKNOWN";
const HOST_KEY_CHANGED = "REPOWEFT_HOST_KEY_CHANGED";

let promptForAuth: AuthPrompt | null = null;

/** Thrown when the user dismissed a connection prompt. */
export class AuthCancelled extends Error {
  constructor() {
    super("SSH_AUTH_CANCELLED");
  }
}

export function isAuthCancelled(error: unknown) {
  return error instanceof AuthCancelled;
}

function isAuthSignal(message: string) {
  return (
    message === AUTH_REQUIRED ||
    message === HOST_KEY_UNKNOWN ||
    message === HOST_KEY_CHANGED
  );
}

/**
 * Authenticate a host before touching it: keys and agent first, then a stored
 * password. Anything the transport cannot answer on its own becomes a UI prompt.
 */
async function negotiate(host: SSHHost) {
  for (let round = 0; round < 3; round++) {
    let signal: string;
    try {
      await invoke("ssh_connect", { host, password: null, remember: false });
      return;
    } catch (error) {
      signal = String(error);
    }
    if (!isAuthSignal(signal)) throw new Error(signal);
    if (!promptForAuth) throw new Error(signal);
    const kind = signal === AUTH_REQUIRED ? "password" : "hostKey";
    const answered = await promptForAuth({
      host,
      kind,
      changed: signal === HOST_KEY_CHANGED,
      retry: round > 0,
    });
    if (!answered) throw new AuthCancelled();
    // The password prompt authenticates on its own; a trusted host still needs one
    // more round to pick up credentials.
    if (kind === "password") return;
  }
  throw new Error(AUTH_REQUIRED);
}

const pendingAuth = new Map<string, Promise<void>>();

/**
 * One prompt per host at a time. A single refresh fans out into several commands,
 * and they must share the answer instead of stacking dialogs on top of each other.
 */
function authenticate(host: SSHHost): Promise<void> {
  const key = `${host.username || "-"}@${host.hostname}:${host.port}`;
  const running = pendingAuth.get(key);
  if (running) return running;
  const task = negotiate(host).finally(() => pendingAuth.delete(key));
  pendingAuth.set(key, task);
  return task;
}

async function sshCall<T>(
  command: string,
  args: Record<string, unknown>,
  host?: SSHHost,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (String(error) === "ACCOUNT_REAUTHORIZE")
      window.dispatchEvent(new Event("repoweft:reauthorize"));
    if (!host || !isAuthSignal(String(error))) throw error;
    await authenticate(host);
    signal?.throwIfAborted();
    return invoke<T>(command, args);
  }
}

function readCall<T>(
  repo: Repository,
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return reads.run(
    repoKey(repo),
    JSON.stringify([command, args]),
    async (active) => {
      const requestId = crypto.randomUUID();
      const cancel = () => {
        void invoke("repository_cancel", { requestId }).catch(() => {});
      };
      active.addEventListener("abort", cancel, { once: true });
      try {
        return await sshCall<T>(
          command,
          { ...args, requestId },
          hostOf(repo),
          active,
        );
      } finally {
        active.removeEventListener("abort", cancel);
      }
    },
    signal,
  );
}

// UI components depend on this service; transport and Git arguments stay here and in Rust.
export const gitService = {
  conflict(
    repo: Repository,
    path: string,
    signal?: AbortSignal,
  ): Promise<ConflictVersions> {
    return readCall(
      repo,
      "repository_conflict",
      { location: repo.location, path },
      signal,
    );
  },
  setAuthPrompt(prompt: AuthPrompt | null) {
    promptForAuth = prompt;
  },
  authenticate,
  /**
   * Prepare the connection a terminal session could ride on. Nothing to do when the
   * platform cannot reuse connections: the PTY asks for credentials on its own.
   */
  async warmConnection(host: SSHHost): Promise<void> {
    if (!(await invoke<boolean>("ssh_reuse_enabled"))) return;
    await authenticate(host);
  },
  sshHosts(): Promise<SSHHost[]> {
    return invoke("ssh_config_hosts");
  },
  release(repo: Repository) {
    const key = repoKey(repo);
    gitService.cancelReads(repo);
    snapshots.delete(key);
    details.deletePrefix(`${key}:`);
  },
  cachedSnapshot(repo: Repository): Snapshot | undefined {
    return snapshots.get(repoKey(repo));
  },
  cancelReads(repo: Repository) {
    const scope = repoKey(repo);
    reads.cancel(scope);
    for (const close of [...(diffClosers.get(scope) ?? [])]) close();
    const data = snapshots.get(repoKey(repo));
    if (data) cancelGithubAvatars(data.remotes.map((remote) => remote.url));
  },
  async snapshot(
    repo: Repository,
    signal?: AbortSignal,
    sections?: (keyof Snapshot)[],
    previous?: Snapshot,
    expandUntracked = false,
  ): Promise<Snapshot> {
    const data: Snapshot = repo.demo
      ? structuredClone(sample)
      : await readCall<Snapshot>(
          repo,
          "repository_snapshot",
          {
            location: repo.location,
            sections: sections ?? null,
            expandUntracked,
          },
          signal,
        );
    if (previous && sections) {
      for (const key of [
        "branch",
        "files",
        "commits",
        "branches",
        "remotes",
        "tags",
        "stashes",
        "operation",
        "tracking",
      ] as const) {
        if (!sections.includes(key))
          Object.assign(data, { [key]: previous[key] });
      }
    }
    const key = repoKey(repo);
    snapshots.set(key, data);
    // Runs before any row mounts, so the bulk page answers the whole viewport at once.
    if (!repo.demo)
      warmGithubAvatars(
        data.remotes.map((remote) => remote.url),
        data.commits,
      );
    return data;
  },
  async commitCount(
    repo: Repository,
    currentOnly: boolean,
    signal?: AbortSignal,
  ): Promise<number> {
    if (repo.demo)
      return (await gitService.log(repo, 0, currentOnly, signal)).length;
    return readCall(
      repo,
      "repository_commit_count",
      { location: repo.location, currentOnly },
      signal,
    );
  },
  async log(
    repo: Repository,
    skip: number,
    currentOnly: boolean,
    signal?: AbortSignal,
  ): Promise<Commit[]> {
    if (repo.demo) {
      if (skip) return [];
      if (!currentOnly) return sample.commits;
      const reachable = new Set<string>();
      const pending = [
        sample.branches.find((branch) => branch.current)?.hash ??
          sample.commits[0]?.hash,
      ];
      while (pending.length) {
        const hash = pending.pop();
        if (!hash || reachable.has(hash)) continue;
        reachable.add(hash);
        const commit = sample.commits.find((commit) =>
          commit.hash.startsWith(hash),
        );
        if (commit) {
          reachable.add(commit.hash);
          pending.push(...commit.parents.slice(0, 1));
        }
      }
      return sample.commits.filter((commit) => reachable.has(commit.hash));
    }
    const commits = await readCall<Commit[]>(
      repo,
      "repository_log",
      { location: repo.location, skip, currentOnly },
      signal,
    );
    const data = snapshots.get(repoKey(repo));
    if (data)
      warmGithubAvatars(
        data.remotes.map((remote) => remote.url),
        commits,
      );
    return commits;
  },
  async detail(
    repo: Repository,
    hash: string,
    signal?: AbortSignal,
  ): Promise<CommitDetail> {
    if (repo.demo)
      return {
        ...demoDetail,
        message:
          sample.commits.find((c) => c.hash === hash)?.message +
          "\n\n" +
          demoDetail.message.split("\n\n")[1],
      };
    const key = `${repoKey(repo)}:${hash}`;
    const old = details.get(key);
    if (old) return old;
    const pending = readCall<CommitDetail>(
      repo,
      "repository_detail",
      { location: repo.location, hash },
      signal,
    ).catch((error) => {
      details.delete(key);
      throw error;
    });
    const value = await pending;
    details.set(key, value);
    return value;
  },
  async openDiff(
    repo: Repository,
    path: string,
    staged: boolean,
    hash?: string,
    untracked = false,
    signal?: AbortSignal,
  ): Promise<DiffSource> {
    signal?.throwIfAborted();
    const sessionId = crypto.randomUUID();
    const scope = repoKey(repo);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", close);
      const closers = diffClosers.get(scope);
      closers?.delete(close);
      if (!closers?.size) diffClosers.delete(scope);
      if (!repo.demo)
        void invoke("repository_diff_close", { sessionId }).catch(() => {});
    };
    const closers = diffClosers.get(scope) ?? new Set<() => void>();
    closers.add(close);
    diffClosers.set(scope, closers);
    signal?.addEventListener("abort", close, { once: true });
    try {
      // The bundled demo is small and intentionally works without the native backend.
      const demoLines = repo.demo
        ? demoDiff
            .replaceAll("src/train.py", path)
            .split("\n")
            .map((text) => ({
              text,
              kind: text.startsWith("+")
                ? ("add" as const)
                : text.startsWith("-")
                  ? ("remove" as const)
                  : text.startsWith("@@")
                    ? ("hunk" as const)
                    : ("context" as const),
            }))
        : null;
      const demoPage = (page: number): DiffPage => ({
        start: page * 128,
        lines: demoLines!.slice(page * 128, (page + 1) * 128),
      });
      const document = repo.demo
        ? {
            id: sessionId,
            totalLines: demoLines!.length,
            pageSize: 128,
          }
        : await readCall<DiffDocument>(
            repo,
            "repository_diff_open",
            {
              diff: {
                location: repo.location,
                path,
                staged,
                hash: hash ?? null,
                untracked,
              },
              sessionId,
            },
            signal,
          );
      if (closed) throw new DOMException("Cancelled", "AbortError");
      return {
        ...document,
        readPage: (page, pageSignal) => {
          if (closed || pageSignal?.aborted)
            return Promise.reject(new DOMException("Cancelled", "AbortError"));
          return repo.demo
            ? Promise.resolve(demoPage(page))
            : readCall<DiffPage>(
                repo,
                "repository_diff_page",
                { sessionId, page },
                pageSignal,
              );
        },
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  },
  refreshAfterAction(
    repo: Repository,
    action: Action,
    previous: Snapshot | null,
  ): Promise<Snapshot> {
    const sections: (keyof Snapshot)[] | undefined =
      action.kind === "stage" || action.kind === "unstage"
        ? ["files"]
        : action.kind === "addRemote" || action.kind === "removeRemote"
          ? ["remotes"]
          : action.kind === "deleteBranch" ||
              action.kind === "push" ||
              action.kind === "forcePush"
            ? ["commits", "branches", "tracking"]
            : action.kind === "fetch"
              ? ["commits", "branches", "tracking", "tags"]
              : undefined;
    return gitService.snapshot(
      repo,
      undefined,
      previous ? sections : undefined,
      previous ?? undefined,
    );
  },
  async action(repo: Repository, action: Action): Promise<string> {
    if (!repo.demo)
      return sshCall(
        "repository_action",
        { location: repo.location, action },
        hostOf(repo),
      );
    const paths = action.paths ?? [];
    if (action.kind === "stage")
      sample.files = sample.files.map((f) =>
        paths.includes(f.path)
          ? {
              ...f,
              index:
                f.worktree === "?"
                  ? "A"
                  : f.worktree === " "
                    ? f.index
                    : f.worktree,
              worktree: " ",
            }
          : f,
      );
    else if (action.kind === "unstage")
      sample.files = sample.files.map((f) =>
        paths.includes(f.path)
          ? {
              ...f,
              worktree: f.index === "A" ? "?" : f.index,
              index: f.index === "A" ? "?" : " ",
            }
          : f,
      );
    else if (action.kind === "commit") {
      sample.commits.unshift({
        hash: crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"),
        message: action.value!.split("\n")[0],
        author: "You",
        email: "you@repoweft.local",
        timestamp: Date.now(),
        parents: [sample.commits[0].hash],
        refs: [sample.branch],
      });
      sample.commits[1].refs = sample.commits[1].refs.filter(
        (ref) => ref !== sample.branch,
      );
      sample.files = sample.files.flatMap((f) =>
        f.index !== " " && f.index !== "?"
          ? f.worktree === " "
            ? []
            : [{ ...f, index: " " }]
          : [f],
      );
    } else if (action.kind === "createBranch") {
      sample.branches.forEach((b) => {
        b.current = false;
      });
      sample.branches.push({
        name: action.value!,
        current: true,
        remote: false,
        upstream: "",
        hash: sample.commits[0].hash,
      });
      sample.branch = action.value!;
    } else if (action.kind === "switchBranch") {
      sample.branch = action.value!;
      sample.branches.forEach((b) => {
        b.current = b.name === action.value;
      });
    } else if (action.kind === "deleteBranch")
      sample.branches = sample.branches.filter((b) => b.name !== action.value);
    else if (action.kind === "addRemote")
      sample.remotes.push({ name: action.value!, url: action.extra! });
    else if (action.kind === "removeRemote")
      sample.remotes = sample.remotes.filter((r) => r.name !== action.value);
    else throw new Error("DEMO_UNAVAILABLE");
    return "DEMO_OK";
  },
  create(path: string, url?: string): Promise<void> {
    return sshCall("repository_create", { path, url: url ?? null });
  },
  test(host: SSHHost): Promise<string> {
    return sshCall("ssh_test", { host }, host);
  },
  directories(
    host: SSHHost,
    path: string,
  ): Promise<{ path: string; directories: DirectoryEntry[] }> {
    return sshCall("ssh_directories", { host, path }, host);
  },
  createRemote(host: SSHHost, path: string, url?: string): Promise<string> {
    return sshCall(
      "repository_create_remote",
      { host, path, url: url?.trim() || null },
      host,
    );
  },
  connect(host: SSHHost, password: string, remember: boolean): Promise<void> {
    return invoke("ssh_connect", { host, password, remember });
  },
  trust(host: SSHHost): Promise<void> {
    return invoke("ssh_trust", { host });
  },
  hostKey(host: SSHHost): Promise<string> {
    return invoke("ssh_host_key", { host });
  },
  passwordSaved(host: SSHHost): Promise<boolean> {
    return invoke("ssh_password_saved", { host });
  },
  forgetPassword(host: SSHHost): Promise<void> {
    return invoke("ssh_forget_password", { host });
  },
};
