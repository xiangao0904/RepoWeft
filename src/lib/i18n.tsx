import { createContext, useContext } from "react";

export const en = {
  oauthRetrying:
    "Connection interrupted. Retrying while your code is valid\u2026",
  oauthLoadingProfile: "Authorized. Loading your GitHub account\u2026",
  oauthPollTimeout:
    "Timed out while checking GitHub authorization. The app will use your system proxy settings. Check that the proxy allows github.com, then sign in again.",
  oauthPollConnection:
    "Could not connect to GitHub to check authorization after retrying. Check your system proxy and connection, then sign in again.",
  oauthPollUnavailable:
    "GitHub could not return the authorization result after retrying. Wait a moment and sign in again.",
  oauthProfileConnection:
    "Authorization completed, but the app could not reach api.github.com to load your account. Check your system proxy and sign in again.",
  oauthProfileRestricted:
    "GitHub restricted the account lookup. Wait a moment, check organization policies, then sign in again.",

  accountSignIn: "Sign in",
  accountSignInGithub: "Sign in with GitHub",
  accountAddGithub: "Add GitHub account",
  accountSignedOut: "Connect your GitHub account",
  accountManage: "Manage accounts",
  accountLoginDescription:
    "Sign in to access your repositories and keep your accounts in one place.",

  oauthDeviceInstructions:
    "Enter this code at github.com/login/device, then authorize RepoWeft. The app will connect automatically.",
  oauthDeviceAccount: "Authorize with this GitHub account:",
  oauthDeviceCode: "GitHub verification code",
  oauthCopyCode: "Copy code",
  oauthCopied: "Copied",
  oauthCopyFailed: "Could not copy the code. Select and copy it manually.",
  oauthOpenGithub: "Open GitHub authorization page",
  oauthDeviceExpiry:
    "This code expires shortly. Only use the code shown in your own RepoWeft app.",
  oauthDeviceDisabled:
    "GitHub device sign-in is not enabled for RepoWeft yet. The app owner must enable Device Flow in its GitHub App settings. PAT and SSH remain available.",

  accountCredentialChanged:
    "Credentials changed while this operation was running. Refresh the repository and check its state before retrying.",
  accountOAuth: "GitHub App",
  accountPat: "Personal token",
  accountReauthorize: "Reconnect",
  accountReauthorizeHint:
    "Your GitHub credentials are no longer valid. Reconnect the account used by this repository.",
  accountUsePat: "Use saved PAT",
  accountPatMissing:
    "No PAT is saved for this account. Expand the token option to add one.",
  accountWithToken: "Connect with a personal access token",
  accountManageAccess: "Manage repository access",
  accountInstallationHint:
    "Install the RepoWeft GitHub App on the repositories you need. Private organization repositories may require administrator approval and an active SSO session.",
  accountIdentityHint:
    "This selects GitHub credentials only. Commit author and SSH keys remain separately configured.",
  repositoryAccount: "Repository GitHub account",
  accountFollowDefault: "Use default account",
  accountSystemCredentials: "System Git / SSH",
  accountBindingMissing: "Bound account removed \u2014 choose an account",
  oauthNotConfigured:
    "GitHub sign-in is not available in this build yet. You can still connect with a personal access token.",
  oauthWaiting: "Waiting for authorization in your browser\u2026",
  oauthCallbackMessage:
    "GitHub has returned to RepoWeft. You can close this tab and return to the app to check the sign-in result.",
  oauthCancelled: "GitHub sign-in cancelled.",
  oauthDenied:
    "GitHub authorization was declined. You can try again whenever you are ready.",
  oauthTimeout: "Sign-in timed out. Sign in again to get a new code.",
  oauthCallbackBusy:
    "Another sign-in or application is using the sign-in callback port. Close it and try again.",
  oauthBrowserFailed:
    "Could not open your system browser. Check your default browser settings and try again.",
  oauthNetworkFailed:
    "Could not complete GitHub sign-in or refresh. Check your connection and try again.",
  oauthExchangeFailed:
    "GitHub could not complete this authorization. Start sign-in again.",
  oauthAccountMismatch:
    "You authorized a different GitHub account. Reconnect using the account shown in RepoWeft.",
  oauthBusy:
    "A GitHub sign-in is already in progress. Complete or cancel it before trying again.",
  oauthCancelFailed: "Could not cancel sign-in. Please try again.",
  accountRepoAccess:
    "Check that the selected account can access this repository and that the RepoWeft GitHub App is installed for it. Organization access may require approval or SSO.",

  accounts: "GitHub accounts",
  accountsDescription:
    "Connect your GitHub accounts and choose which one to use for private repositories.",
  accountActive: "Active account",
  accountSaved: "Connected",
  accountSwitch: "Switch",
  accountToken: "Personal access token",
  accountTokenHint:
    "Select the repositories you need. Grant Contents read access to clone and pull, and read/write access to push. Organization repositories may also require approval or SSO authorization.",
  accountCreateToken: "Create a GitHub token",
  accountConnect: "Connect GitHub account",
  accountLater: "Continue locally",
  accountInvalidToken:
    "GitHub rejected this token. Check its value, permissions and expiration.",
  accountNetworkFailed:
    "Could not reach GitHub. Check your connection and try again.",
  accountStorageFailed:
    "Could not access the system credential store. Unlock it and try again.",
  accountNotFound:
    "This account is no longer available. Reopen the account manager.",
  accountLimit:
    "You can connect up to 8 accounts. Remove one before adding another.",

  directoryNoAccess: "No access",
  remoteRoot: "Root directory",
  terminal: "Terminal",
  terminalStarting: "Starting terminal…",
  terminalExited: "Terminal session ended",
  terminalRestart: "Restart terminal",
  terminalClose: "Close terminal",
  retry: "Retry",
  searchBranches: "Search branches",
  resizePanels: "Resize panels",
  tagline: "LOCAL & REMOTE, WOVEN TOGETHER",
  sshConfigPort: "0 = use SSH config",
  commits: "commits",
  branchHint: "Create a branch from the current HEAD and switch to it.",
  remoteHint: "Connect this repository to a Git remote.",
  home: "Home",
  workspaces: "Workspaces",
  servers: "SSH servers",
  settings: "Settings",
  history: "History",
  changes: "Changes",
  branches: "Branches",
  remotes: "Remotes",
  welcome: "Your code. Connected.",
  homeDescription: "One workspace for your local and remote repositories.",
  open: "Open repository",
  clone: "Clone repository",
  connect: "Connect SSH server",
  init: "Initialize repository",
  openDescription: "Pick up where your code lives.",
  cloneDescription: "Bring a project to your machine.",
  connectDescription: "Work closer to your remote code.",
  recent: "Recent repositories",
  viewAll: "View all",
  repository: "Repository",
  location: "Location",
  lastOpened: "Last opened",
  local: "Local",
  remote: "Remote",
  favorites: "Favorites",
  all: "All repositories",
  noRepositories: "Your next project starts here.",
  noRepositoriesDescription:
    "Open a repository or clone a project to get started.",
  quickActions: "Quick actions",
  commandMenu: "Command menu",
  ready: "Ready",
  preview: "Interactive preview",
  demo: "Demo workspace",
  demoDescription:
    "Explore the interface with a sample repository. Real Git operations are available in the desktop app.",
  explore: "Explore demo",
  desktopOnly: "Open the desktop app to work with real Git repositories.",
  searchRepos: "Find a repository…",
  searchCommits: "Search commits…",
  allBranches: "All branches",
  currentBranch: "Current branch",
  details: "Details",
  files: "Files",
  filesChanged: "Files changed",
  noCommits: "No commits yet",
  noResults: "No matching results",
  noCommitsDescription: "Your first commit will appear here.",
  loadMore: "Load more commits",
  loadPrevious: "Load previous commits",
  expandUntracked: "Expand untracked folders",
  copyHash: "Copy commit hash",
  copied: "Copied to clipboard",
  author: "Author",
  committed: "Committed",
  parents: "Parents",
  refresh: "Refresh",
  fetch: "Fetch",
  pull: "Pull",
  push: "Push",
  workingTree: "Working tree",
  staged: "Staged changes",
  stageAll: "Stage all",
  unstageAll: "Unstage all",
  stage: "Stage file",
  unstage: "Unstage file",
  clean: "All caught up.",
  cleanDescription: "Your working tree is clean. Time for your next idea.",
  selectFile: "Select a file to view its changes",
  noDiff: "No text diff available. The file may be binary or unchanged.",
  commitSummary: "Summary of your changes",
  commitDescription: "Add a description (optional)",
  commit: "Commit changes",
  commitHint: "Stage your changes and write a summary to commit.",
  newBranch: "New branch",
  branchName: "Branch name",
  switchBranch: "Switch branch",
  deleteBranch: "Delete branch",
  merge: "Merge into current branch",
  current: "Current",
  localBranches: "Local branches",
  remoteBranches: "Remote branches",
  noBranches: "No branches yet",
  addRemote: "Add remote",
  remoteName: "Remote name",
  remoteUrl: "Repository URL",
  noRemotes: "No remotes configured",
  noRemotesDescription: "Connect a remote to fetch, pull, and push your code.",
  remove: "Remove",
  serverTitle: "Your code, wherever it runs.",
  serverDescription:
    "Connect over SSH and work directly on your server. Your repository stays remote.",
  addServer: "Add SSH server",
  editServer: "Edit SSH server",
  noServers: "No servers connected yet",
  noServersDescription:
    "Add a host or an alias from your SSH config to get started.",
  name: "Display name",
  hostname: "Hostname or SSH config alias",
  username: "Username (optional for SSH config)",
  port: "Port",
  identity: "Identity file (optional)",
  sshHint:
    "Uses OpenSSH, your SSH agent, and ~/.ssh/config. Passwords are optional and stay in your system credential manager.",
  sshPasswordTitle: "Password required",
  sshPasswordHint:
    "This server does not accept your keys. Enter the password to continue.",
  password: "Password",
  rememberPassword: "Save this password on this device",
  rememberPasswordHint:
    "Checked: kept in the system credential manager, so it survives a restart. Unchecked: used only until the app closes.",
  sshPasswordWrong: "Authentication failed. Check the password and try again.",
  hostKeyTitle: "Trust this host key?",
  hostKeyHint:
    "This host is not in your known_hosts file yet. Compare the fingerprint with the server before trusting it.",
  hostKeyChanged:
    "The host key differs from the one recorded earlier. Verify the server, then remove the stale entry from known_hosts before connecting.",
  fingerprint: "Fingerprint",
  fingerprintLoading: "Reading host key…",
  trustHost: "Trust and continue",
  sshCancelled: "Connection cancelled.",
  sshAuthRequired:
    "This server requires a password. Add it in the server settings.",
  sshHostKeyRequired: "This host key is not trusted yet.",
  forgetPassword: "Forget saved password",
  passwordSaved: "Password saved",
  newRemote: "New or clone",
  remoteCreateTitle: "New remote repository",
  remoteCreateHint:
    "Choose the parent directory on the server, then initialize or clone the repository.",
  remoteInit: "Initialize",
  remoteClone: "Clone",
  remoteRepoName: "Repository name",
  invalidName: "Enter a name without slashes.",
  remoteTarget: "Will create",
  testConnection: "Test connection",
  connected: "Connection verified",
  configured: "Configured",
  openRemote: "Open remote repository",
  remotePath: "Absolute remote path",
  path: "Repository path",
  browse: "Browse",
  parent: "Parent directory",
  openHere: "Open this repository",
  cancel: "Cancel",
  save: "Save",
  create: "Create",
  confirm: "Confirm",
  openRepositories: "Open repositories",
  closeRepository: "Close repository",
  close: "Close",
  cloneTitle: "Clone a repository",
  clonePath: "Destination folder (must be new or empty)",
  cloneHint:
    "Local GitHub clones use the account selected in the sidebar. Other hosts and SSH workspaces use credentials on the machine running Git.",
  openTitle: "Open a repository",
  openHint: "Choose an existing Git working directory.",
  initTitle: "Initialize a repository",
  initHint: "Create a new Git repository in the selected folder.",
  settingsDescription: "Make this workspace feel like yours.",
  appearance: "Appearance",
  theme: "Theme",
  dark: "Dark",
  light: "Light",
  language: "Language",
  languageDescription: "Choose the language used throughout the app.",
  about: "Built for your flow",
  aboutDescription:
    "A lightweight, open source Git client for local and remote development.",
  shortcuts: "Keyboard shortcuts",
  openShortcut: "Open repository",
  searchShortcut: "Open command menu",
  refreshShortcut: "Refresh repository",
  operationSuccess: "Operation completed",
  operationFailed: "Operation failed",
  working: "Working…",
  deleteBranchWarning:
    "Delete this local branch? Git will refuse if it contains unmerged commits.",
  mergeWarning:
    "Merge this branch into the current branch? Conflicts may need to be resolved in your editor.",
  removeRemoteWarning:
    "Remove this Git remote? This only removes its local configuration.",
  removeServerWarning:
    "Remove this SSH server from RepoWeft? Files on the server will be kept.",
  forget: "Remove from recents",
  favorite: "Toggle favorite",
  invalidPath: "Enter a repository path.",
  unknownError: "Something went wrong. Please try again.",
  searchCommands: "What would you like to do?",
  justNow: "Just now",
  minutesAgo: "{n} min ago",
  hoursAgo: "{n} hr ago",
  daysAgo: "{n}d ago",
  emptyDirectory: "No subdirectories",
  offline: "Not tested",
  branch: "Branch",
  back: "Back",
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  operationLog: "Operation output",
  noOperations: "Git command output will appear here.",
  demoNotice: "Demo data · changes are saved for this session only",
  unavailableDemo: "This action needs a real repository in the desktop app.",
  connectionFailed:
    "Connection failed. Check your SSH configuration and trusted host keys.",
} as const;

export type MessageKey = keyof typeof en;
export type Locale = "en" | "zh-CN";
export const zh: Record<MessageKey, string> = {
  oauthRetrying: "连接暂时中断，正在短码有效期内重试…",
  oauthLoadingProfile: "授权成功，正在读取 GitHub 账号…",
  oauthPollTimeout:
    "查询 GitHub 授权结果超时。应用会使用系统代理，请确认代理允许访问 github.com 后重新登录。",
  oauthPollConnection:
    "重试后仍无法连接 GitHub 查询授权结果，请检查系统代理和网络后重新登录。",
  oauthPollUnavailable: "重试后 GitHub 仍未返回授权结果，请稍后重新登录。",
  oauthProfileConnection:
    "已完成授权，但应用无法连接 api.github.com 读取账号，请检查系统代理后重新登录。",
  oauthProfileRestricted:
    "GitHub 限制了账号查询，请稍后重试，并检查组织的访问策略。",

  accountSignIn: "登录账户",
  accountSignInGithub: "使用 GitHub 登录",
  accountAddGithub: "添加 GitHub 账号",
  accountSignedOut: "连接你的 GitHub 账号",
  accountManage: "管理账户",
  accountLoginDescription: "登录后访问你的仓库，并在这里统一管理账号。",

  oauthDeviceInstructions:
    "在 github.com/login/device 输入下方短码，确认授权 RepoWeft 后，应用会自动连接。",
  oauthDeviceAccount: "请使用此 GitHub 账号授权：",
  oauthDeviceCode: "GitHub 验证短码",
  oauthCopyCode: "复制短码",
  oauthCopied: "已复制",
  oauthCopyFailed: "无法复制短码，请选中后手动复制。",
  oauthOpenGithub: "打开 GitHub 授权页面",
  oauthDeviceExpiry:
    "此短码会在几分钟后过期，请仅使用你自己的 RepoWeft 应用中显示的短码。",
  oauthDeviceDisabled:
    "RepoWeft 尚未启用 GitHub 设备授权，应用所有者需要在 GitHub App 设置中开启 Enable Device Flow。你仍可使用 PAT 或 SSH。",

  accountCredentialChanged:
    "操作期间凭据发生了变化，请刷新仓库并确认状态后再重试。",
  accountOAuth: "GitHub App",
  accountPat: "个人令牌",
  accountReauthorize: "重新授权",
  accountReauthorizeHint: "GitHub 凭据已失效，请为此仓库使用的账号重新授权。",
  accountUsePat: "使用已保存的 PAT",
  accountPatMissing: "此账号没有已保存的 PAT，请展开令牌登录选项添加。",
  accountWithToken: "使用个人访问令牌连接",
  accountManageAccess: "管理仓库访问权限",
  accountInstallationHint:
    "请将 RepoWeft GitHub App 安装到需要访问的仓库。组织的私有仓库可能还需要管理员批准和有效的 SSO 会话。",
  accountIdentityHint:
    "此选项仅选择 GitHub 凭据。提交作者和 SSH 密钥分别配置。",
  repositoryAccount: "仓库使用的 GitHub 账号",
  accountFollowDefault: "跟随默认账号",
  accountSystemCredentials: "系统 Git / SSH",
  accountBindingMissing: "绑定账号已移除，请重新选择",
  oauthNotConfigured:
    "当前版本尚未配置 GitHub 授权登录，你仍可使用个人访问令牌连接。",
  oauthWaiting: "正在等待浏览器授权…",
  oauthCallbackMessage:
    "GitHub 已返回 RepoWeft，你可以关闭此页面，回到应用查看登录结果。",
  oauthCancelled: "已取消 GitHub 登录。",
  oauthDenied: "GitHub 授权已被拒绝，你可以随时重试。",
  oauthTimeout: "登录已超时，请重新点击 GitHub 登录。",
  oauthCallbackBusy: "其他登录流程或应用正在占用授权回调端口，请关闭后重试。",
  oauthBrowserFailed: "无法打开系统浏览器，请检查默认浏览器设置后重试。",
  oauthNetworkFailed: "无法完成 GitHub 登录或刷新凭据，请检查网络后重试。",
  oauthExchangeFailed: "GitHub 未能完成此次授权，请重新登录。",
  oauthAccountMismatch:
    "你授权了其他 GitHub 账号，请使用 RepoWeft 中显示的账号重新授权。",
  oauthBusy: "已有 GitHub 登录正在进行，请完成或取消后重试。",
  oauthCancelFailed: "无法取消登录，请重试。",
  accountRepoAccess:
    "请检查选中账号是否有权访问此仓库，并确认 RepoWeft GitHub App 已安装到该仓库。组织访问可能需要管理员批准或 SSO 授权。",

  accounts: "GitHub 账号",
  accountsDescription: "连接 GitHub 账号，并选择访问私有仓库时使用的账号。",
  accountActive: "当前账号",
  accountSaved: "已连接",
  accountSwitch: "切换",
  accountToken: "个人访问令牌",
  accountTokenHint:
    "请选择需要访问的仓库。克隆和拉取需要 Contents 读取权限，推送需要读写权限。组织仓库还可能需要管理员批准或 SSO 授权。",
  accountCreateToken: "创建 GitHub 令牌",
  accountConnect: "连接 GitHub 账号",
  accountLater: "先使用本地仓库",
  accountInvalidToken: "GitHub 拒绝了此令牌，请检查令牌内容、权限和有效期。",
  accountNetworkFailed: "无法连接 GitHub，请检查网络后重试。",
  accountStorageFailed: "无法访问系统凭据库，请解锁后重试。",
  accountNotFound: "此账号已不可用，请重新打开账号管理。",
  accountLimit: "最多可连接 8 个账号，请先移除一个账号。",

  directoryNoAccess: "无访问权限",
  remoteRoot: "根目录",
  terminal: "终端",
  terminalStarting: "正在启动终端…",
  terminalExited: "终端会话已结束",
  terminalRestart: "重启终端",
  terminalClose: "关闭终端",
  retry: "重试",
  searchBranches: "搜索分支",
  resizePanels: "调整面板大小",
  tagline: "连接本地与远程，让代码井然有序",
  sshConfigPort: "0 = 使用 SSH 配置",
  commits: "次提交",
  branchHint: "从当前 HEAD 创建新分支，并切换到该分支。",
  remoteHint: "为当前仓库配置 Git 远程地址。",
  home: "首页",
  workspaces: "工作区",
  servers: "SSH 服务器",
  settings: "设置",
  history: "提交历史",
  changes: "文件变更",
  branches: "分支",
  remotes: "远程仓库",
  welcome: "代码。随时连接。",
  homeDescription: "本地与远程仓库的统一工作区。",
  open: "打开仓库",
  clone: "克隆仓库",
  connect: "连接 SSH 服务器",
  init: "初始化仓库",
  openDescription: "从代码所在的地方，继续创作。",
  cloneDescription: "把项目带到你的电脑上。",
  connectDescription: "直接管理服务器上的代码。",
  recent: "最近使用的仓库",
  viewAll: "查看全部",
  repository: "仓库",
  location: "位置",
  lastOpened: "上次打开",
  local: "本地",
  remote: "远程",
  favorites: "已收藏",
  all: "全部仓库",
  noRepositories: "下一个项目，从这里开始。",
  noRepositoriesDescription: "打开已有仓库，或克隆一个项目，开始你的工作。",
  quickActions: "快捷操作",
  commandMenu: "命令面板",
  ready: "就绪",
  preview: "交互预览",
  demo: "演示工作区",
  demoDescription: "通过示例仓库体验界面。桌面应用支持操作真实 Git 仓库。",
  explore: "体验演示仓库",
  desktopOnly: "请在桌面应用中操作真实 Git 仓库。",
  searchRepos: "搜索仓库…",
  searchCommits: "搜索提交…",
  allBranches: "全部分支",
  currentBranch: "当前分支",
  details: "详情",
  files: "文件",
  filesChanged: "变更文件",
  noCommits: "还没有提交",
  noResults: "没有找到匹配结果",
  noCommitsDescription: "第一次提交后，历史记录会显示在这里。",
  loadMore: "加载更多提交",
  loadPrevious: "加载前面的提交",
  expandUntracked: "展开未跟踪文件夹",
  copyHash: "复制提交哈希",
  copied: "已复制到剪贴板",
  author: "作者",
  committed: "提交时间",
  parents: "父提交",
  refresh: "刷新",
  fetch: "获取",
  pull: "拉取",
  push: "推送",
  workingTree: "工作目录",
  staged: "暂存区",
  stageAll: "暂存全部",
  unstageAll: "取消全部暂存",
  stage: "暂存文件",
  unstage: "取消暂存",
  clean: "一切就绪。",
  cleanDescription: "工作目录很干净，开始下一个灵感吧。",
  selectFile: "选择一个文件，查看具体变更",
  noDiff: "没有可显示的文本差异，文件可能是二进制文件或没有变更。",
  commitSummary: "简要说明这次修改",
  commitDescription: "补充详细说明（可选）",
  commit: "提交变更",
  commitHint: "暂存文件并填写摘要，即可创建提交。",
  newBranch: "新建分支",
  branchName: "分支名称",
  switchBranch: "切换分支",
  deleteBranch: "删除分支",
  merge: "合并到当前分支",
  current: "当前",
  localBranches: "本地分支",
  remoteBranches: "远程分支",
  noBranches: "还没有分支",
  addRemote: "添加远程仓库",
  remoteName: "远程名称",
  remoteUrl: "仓库地址",
  noRemotes: "尚未配置远程仓库",
  noRemotesDescription: "添加远程仓库后，即可获取、拉取和推送代码。",
  remove: "移除",
  serverTitle: "代码在哪里，工作区就在哪里。",
  serverDescription: "通过 SSH 直接管理服务器上的仓库，代码始终保留在远程。",
  addServer: "添加 SSH 服务器",
  editServer: "编辑 SSH 服务器",
  noServers: "还没有连接服务器",
  noServersDescription: "添加服务器地址或 SSH 配置别名，开始远程开发。",
  name: "显示名称",
  hostname: "主机地址或 SSH 配置别名",
  username: "用户名（使用 SSH 别名时可留空）",
  port: "端口",
  identity: "密钥文件路径（可选）",
  sshHint:
    "使用系统 OpenSSH、SSH Agent 和 ~/.ssh/config。可选择保存密码，凭据存放在系统凭据管理器中。",
  sshPasswordTitle: "需要密码",
  sshPasswordHint: "这台服务器没有接受你的密钥，请输入密码后继续。",
  password: "密码",
  rememberPassword: "在这台设备上保存密码",
  rememberPasswordHint:
    "勾选后存入系统凭据管理器，重启应用也不用再输。取消勾选则只在本次运行期间保留，重启后需要重新输入。",
  sshPasswordWrong: "认证失败，请检查密码后重试。",
  hostKeyTitle: "信任这台服务器的主机密钥？",
  hostKeyHint:
    "该主机密钥还不在 known_hosts 中。请先与服务器核对指纹，再决定是否信任。",
  hostKeyChanged:
    "主机密钥与之前记录的不一致。请先与服务器核实，再从 known_hosts 中移除旧记录。",
  fingerprint: "指纹",
  fingerprintLoading: "正在读取主机密钥…",
  trustHost: "信任并继续",
  sshCancelled: "已取消连接。",
  sshAuthRequired: "这台服务器需要密码，请重新连接。",
  sshHostKeyRequired: "这台服务器的主机密钥尚未信任。",
  forgetPassword: "清除已保存的密码",
  passwordSaved: "已保存密码",
  newRemote: "新建或克隆",
  remoteCreateTitle: "新建远程仓库",
  remoteCreateHint: "在服务器上选择父目录，然后初始化或克隆仓库。",
  remoteInit: "初始化",
  remoteClone: "克隆",
  remoteRepoName: "仓库名称",
  invalidName: "请填写不含斜杠的仓库名称。",
  remoteTarget: "将创建",
  testConnection: "测试连接",
  connected: "连接已验证",
  configured: "已配置",
  openRemote: "打开远程仓库",
  remotePath: "远程绝对路径",
  path: "仓库路径",
  browse: "浏览",
  parent: "上级目录",
  openHere: "打开此仓库",
  cancel: "取消",
  save: "保存",
  create: "创建",
  confirm: "确认",
  openRepositories: "已打开的仓库",
  closeRepository: "关闭仓库",
  close: "关闭",
  cloneTitle: "克隆仓库",
  clonePath: "目标目录（须为空或尚未创建）",
  cloneHint:
    "本机克隆 GitHub 仓库时使用侧栏选中的账号。其他站点和 SSH 工作区使用 Git 所在机器的凭据。",
  openTitle: "打开仓库",
  openHint: "选择一个已有的 Git 工作目录。",
  initTitle: "初始化仓库",
  initHint: "在选定目录中创建新的 Git 仓库。",
  settingsDescription: "让工作区更合你的习惯。",
  appearance: "外观",
  theme: "主题",
  dark: "深色",
  light: "浅色",
  language: "界面语言",
  languageDescription: "切换应用各个页面使用的语言。",
  about: "为顺畅开发而生",
  aboutDescription: "轻量、开源的 Git 客户端，让本地与远程开发同样顺手。",
  shortcuts: "键盘快捷键",
  openShortcut: "打开仓库",
  searchShortcut: "打开命令面板",
  refreshShortcut: "刷新当前仓库",
  operationSuccess: "操作已完成",
  operationFailed: "操作失败",
  working: "正在处理…",
  deleteBranchWarning:
    "确定删除这个本地分支吗？如果存在尚未合并的提交，Git 会阻止删除。",
  mergeWarning:
    "将这个分支合并到当前分支吗？如果出现冲突，需要在编辑器中解决。",
  removeRemoteWarning: "移除这个远程仓库吗？此操作只删除本地远程配置。",
  removeServerWarning:
    "从 RepoWeft 中移除这台 SSH 服务器吗？服务器上的文件会保留。",
  forget: "从最近列表移除",
  favorite: "切换收藏状态",
  invalidPath: "请填写仓库路径。",
  unknownError: "操作遇到了问题，请重试。",
  searchCommands: "你想做些什么？",
  justNow: "刚刚",
  minutesAgo: "{n} 分钟前",
  hoursAgo: "{n} 小时前",
  daysAgo: "{n} 天前",
  emptyDirectory: "没有子目录",
  offline: "尚未测试",
  branch: "分支",
  back: "返回",
  modified: "已修改",
  added: "已添加",
  deleted: "已删除",
  renamed: "已重命名",
  untracked: "未跟踪",
  operationLog: "操作输出",
  noOperations: "Git 命令的执行结果会显示在这里。",
  demoNotice: "演示数据 · 修改仅在本次会话中保留",
  unavailableDemo: "请在桌面应用中打开真实仓库后使用此功能。",
  connectionFailed: "连接失败，请检查 SSH 配置与主机密钥信任状态。",
};

export const I18nContext = createContext<{
  locale: Locale;
  t: (key: MessageKey) => string;
}>({ locale: "en", t: (key) => en[key] });
export function useI18n() {
  return useContext(I18nContext);
}
/** Turn transport signals into user-facing text. */
export function errorText(
  error: unknown,
  t: (key: MessageKey) => string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  switch (message) {
    case "ACCOUNT_CREDENTIAL_CHANGED":
      return t("accountCredentialChanged");
    case "ACCOUNT_REAUTHORIZE":
      return t("accountReauthorizeHint");
    case "ACCOUNT_PAT_MISSING":
      return t("accountPatMissing");
    case "ACCOUNT_INVALID_TOKEN":
      return t("accountInvalidToken");
    case "ACCOUNT_NETWORK_FAILED":
      return t("accountNetworkFailed");
    case "ACCOUNT_NOT_FOUND":
      return t("accountNotFound");
    case "ACCOUNT_LIMIT":
      return t("accountLimit");
    case "ACCOUNT_DESKTOP_ONLY":
      return t("desktopOnly");
    case "OAUTH_DEVICE_DISABLED":
      return t("oauthDeviceDisabled");
    case "OAUTH_NOT_CONFIGURED":
      return t("oauthNotConfigured");
    case "OAUTH_BUSY":
      return t("oauthBusy");
    case "OAUTH_CANCELLED":
      return t("oauthCancelled");
    case "OAUTH_DENIED":
      return t("oauthDenied");
    case "OAUTH_TIMEOUT":
      return t("oauthTimeout");
    case "OAUTH_CALLBACK_BUSY":
      return t("oauthCallbackBusy");
    case "OAUTH_CALLBACK_FAILED":
      return t("oauthExchangeFailed");
    case "OAUTH_INVALID_RESPONSE":
      return t("oauthExchangeFailed");
    case "OAUTH_BROWSER_FAILED":
      return t("oauthBrowserFailed");
    case "OAUTH_POLL_TIMEOUT":
      return t("oauthPollTimeout");
    case "OAUTH_POLL_CONNECTION":
      return t("oauthPollConnection");
    case "OAUTH_POLL_UNAVAILABLE":
      return t("oauthPollUnavailable");
    case "OAUTH_PROFILE_CONNECTION":
      return t("oauthProfileConnection");
    case "OAUTH_PROFILE_RESTRICTED":
      return t("oauthProfileRestricted");
    case "OAUTH_NETWORK_FAILED":
      return t("oauthNetworkFailed");
    case "OAUTH_EXCHANGE_FAILED":
      return t("oauthExchangeFailed");
    case "OAUTH_ACCOUNT_MISMATCH":
      return t("oauthAccountMismatch");
    case "ACCOUNT_STORAGE_FAILED":
      return t("accountStorageFailed");
    case "SSH_AUTH_CANCELLED":
      return t("sshCancelled");
    case "REPOWEFT_AUTH_REQUIRED":
      return t("sshAuthRequired");
    case "REPOWEFT_HOST_KEY_UNKNOWN":
      return t("sshHostKeyRequired");
    case "REPOWEFT_HOST_KEY_CHANGED":
      return t("hostKeyChanged");
    default:
      if (
        /repository not found|requested URL returned error: 403/i.test(message)
      )
        return `${message}\n${t("accountRepoAccess")}`;
      return message;
  }
}
export function relativeTime(
  timestamp: number,
  locale: Locale,
  t: (key: MessageKey) => string,
) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return t("justNow");
  if (minutes < 60) return t("minutesAgo").replace("{n}", String(minutes));
  if (minutes < 1440)
    return t("hoursAgo").replace("{n}", String(Math.floor(minutes / 60)));
  if (minutes < 10080)
    return t("daysAgo").replace("{n}", String(Math.floor(minutes / 1440)));
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
