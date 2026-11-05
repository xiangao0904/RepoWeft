export interface DirectoryEntry {
  path: string;
  accessible: boolean;
}
export interface SSHHost {
  id: string;
  name: string;
  hostname: string;
  username: string;
  port: number;
  identityFile: string;
}

export type Location =
  | { kind: "local"; path: string }
  | { kind: "ssh"; path: string; host: SSHHost };
/** A connection-time question the UI has to answer before an SSH call can continue. */
export interface AuthRequest {
  host: SSHHost;
  kind: "password" | "hostKey";
  /** True when a known host presented a different key. Never offer to trust it. */
  changed: boolean;
  /** True when a previous password was rejected. */
  retry: boolean;
}
export type AuthPrompt = (request: AuthRequest) => Promise<boolean | null>;
export interface Repository {
  id: string;
  name: string;
  location: Location;
  favorite: boolean;
  lastOpened: number;
  demo?: boolean;
}
export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  timestamp: number;
  message: string;
  refs: string[];
}
export interface FileChange {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}
export interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  hash: string;
}
export interface Remote {
  name: string;
  url: string;
}
export interface Snapshot {
  branch: string;
  commits: Commit[];
  files: FileChange[];
  branches: Branch[];
  remotes: Remote[];
}
export type GitAction =
  | "stage"
  | "unstage"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "createBranch"
  | "switchBranch"
  | "deleteBranch"
  | "merge"
  | "addRemote"
  | "removeRemote";
export interface Action {
  kind: GitAction;
  paths?: string[];
  value?: string;
  extra?: string;
}
export interface CommitFile {
  path: string;
  added: string;
  deleted: string;
}
export interface CommitDetail {
  message: string;
  files: CommitFile[];
}
