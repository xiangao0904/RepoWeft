import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Action,
  AuthPrompt,
  DirectoryEntry,
  Commit,
  CommitDetail,
  Repository,
  Snapshot,
  SSHHost,
} from "../types";
import { demoDetail, demoDiff, demoSnapshot } from "./demo";
import { warmGithubAvatars } from "../lib/avatars";

export const desktop = isTauri();
let sample: Snapshot = structuredClone(demoSnapshot);

const snapshots = new Map<string, Snapshot>();
const details = new Map<string, Promise<CommitDetail>>();
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
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (String(error) === "ACCOUNT_REAUTHORIZE")
      window.dispatchEvent(new Event("repoweft:reauthorize"));
    if (!host || !isAuthSignal(String(error))) throw error;
    await authenticate(host);
    return invoke<T>(command, args);
  }
}

// UI components depend on this service; transport and Git arguments stay here and in Rust.
export const gitService = {
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
  cachedSnapshot(repo: Repository): Snapshot | undefined {
    return snapshots.get(repoKey(repo));
  },
  async snapshot(repo: Repository): Promise<Snapshot> {
    const data: Snapshot = repo.demo
      ? structuredClone(sample)
      : await sshCall(
          "repository_snapshot",
          { location: repo.location },
          hostOf(repo),
        );
    const key = repoKey(repo);
    snapshots.delete(key);
    if (snapshots.size >= 8) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, data);
    // Runs before any row mounts, so the bulk page answers the whole viewport at once.
    if (!repo.demo)
      warmGithubAvatars(
        data.remotes.map((remote) => remote.url),
        data.commits,
      );
    return data;
  },
  async log(
    repo: Repository,
    skip: number,
    currentOnly: boolean,
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
    const commits = await sshCall<Commit[]>(
      "repository_log",
      { location: repo.location, skip, currentOnly },
      hostOf(repo),
    );
    const data = snapshots.get(repoKey(repo));
    if (data)
      warmGithubAvatars(
        data.remotes.map((remote) => remote.url),
        commits,
      );
    return commits;
  },
  async detail(repo: Repository, hash: string): Promise<CommitDetail> {
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
    const pending = sshCall<CommitDetail>(
      "repository_detail",
      { location: repo.location, hash },
      hostOf(repo),
    ).catch((error) => {
      details.delete(key);
      throw error;
    });
    if (details.size >= 64) details.delete(details.keys().next().value!);
    details.set(key, pending);
    return pending;
  },
  async diff(
    repo: Repository,
    path: string,
    staged: boolean,
    hash?: string,
    untracked = false,
  ): Promise<string> {
    return repo.demo
      ? demoDiff.replaceAll("src/train.py", path)
      : sshCall(
          "repository_diff",
          {
            location: repo.location,
            path,
            staged,
            hash: hash ?? null,
            untracked,
          },
          hostOf(repo),
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
