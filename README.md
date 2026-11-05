# RepoWeft

<p align="center"><img src="assets/logo/repoweft-app.svg" width="112" alt="RepoWeft logo" /></p>

基于 **Tauri 2、Rust、React 和 TypeScript** 的 Git 桌面客户端，在一个工作空间里管理本地与 SSH 远程仓库。支持提交历史、文件差异、暂存提交、分支管理和 GitHub 多账号。

## 启动

需要 Node.js 22.18+、pnpm、Rust，以及 Tauri 2 对应平台的构建环境。Windows 需要 Visual Studio C++ Build Tools 和 WebView2。真实仓库操作还需要系统 PATH 中的 Git；SSH 功能需要 OpenSSH。

```powershell
pnpm install
pnpm tauri dev
```

只预览界面：

```powershell
pnpm dev
```

浏览器打开 `http://localhost:1420`，点击首页的“体验演示仓库”。演示仓库与真实仓库隔离，支持本次会话内的暂存、提交和分支操作。Git 网络操作需要桌面应用中的真实仓库。

## 当前功能

- 首页：打开、克隆、初始化仓库，最近列表、收藏、搜索与工作区切换。
- 历史：真实父子关系图、分页加载、行虚拟化、提交搜索、全部/当前分支筛选、提交详情、文件统计与文本 Diff。
- 变更：工作区与暂存区、单文件/全部暂存及取消暂存、未跟踪文本预览、提交摘要与正文。
- 分支：列出本地和远程分支，创建、切换、安全删除本地分支与合并确认。
- 远程：列出、添加和移除 Git remote，Fetch、仅快进 Pull、Push。
- SSH：配置增删改、连接测试、主机指纹确认、密码登录（可选保存）、浏览远程目录、在远程新建或克隆仓库，并直接在远程工作目录执行上述 Git 操作。
- 设置：中英文即时切换、深浅主题、快捷键、操作输出；偏好、最近仓库及 SSH 元信息保存在本机 WebView 存储。
- 字体随应用打包，界面无需外部字体服务。

打开已有仓库时输入工作目录路径，也可以点击文件夹按钮调用系统选择器。`Ctrl+K` 打开命令面板，`Ctrl+O` 打开仓库，`Ctrl+R` 刷新仓库。

## 仓库界面

- 历史页面默认在右侧显示工作区和提交表单。点击 commit 后，右侧切换为该提交的详情；再次点击同一条 commit 可取消选择。
- 点击变更文件，在中间主区域查看 Diff。点击 Diff 标题栏右上角的关闭按钮可回到历史列表。
- 提交详情显示作者，以及提交正文中 `Co-authored-by` 标注的共同作者。
- 左侧固定导航和账号入口，仓库列表独立滚动，支持切换本地与远程仓库。
- 导航文字不参与文本选择，代码差异、提交说明和输入框中的内容仍可选中复制。

## GitHub 账号

点击 **Sign in with GitHub**，复制应用显示的短码，在系统浏览器打开的 GitHub 页面输入并授权后，应用自动连接。设备授权直接使用 GitHub，无需用户创建 PAT，也无需开发者部署授权服务或配置 Client Secret。

支持多 GitHub 账号、默认账号切换和仓库级绑定，保留 PAT 和系统 Git/SSH。Token 对保存在系统凭据库，接近过期时直接向 GitHub 刷新。GitHub 登录身份、提交作者和 SSH 密钥独立管理。私有仓库还需将 GitHub App 安装到对应仓库。

开发者需要在 [RepoWeft GitHub App 设置](https://github.com/settings/apps/repoweftgit) 勾选 **Enable Device Flow** 并保存，现有 Client ID 和 App 名称已内置。PR、Issue 的具体管理界面仍需后续实现。

[完整配置、架构、安全边界与验证步骤](docs/github-app-oauth.md)。

## SSH 使用

复用系统 `ssh`、SSH Agent、`~/.ssh/config` 与 `known_hosts`，支持 SSH 配置中的 ProxyJump。端口设为 `0` 时沿用 SSH 配置。密钥字段只保存路径。

认证先试密钥和 Agent，失败后回退到密码。需要密码时应用弹出输入框，并可勾选「在这台设备上保存密码」：保存后凭据写入系统凭据管理器（Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service），重启应用也能自动登录；不勾选则只保留到应用退出，并清除之前保存的密码。密码经由 askpass helper 读取临时文件传递，不进入命令行参数或进程列表，连接建立后立即删除。

连接复用（`ControlMaster` + `ControlPersist=300`）只在支持它的平台上启用：Windows 版 OpenSSH 没有可用的多路复用实现，启用后握手成功、但 `ControlPersist` 的守护进程会随父进程退场而失效，后续命令连到死 socket，报 `getsockname failed: Not a socket` 或 `Read from remote host …: Unknown error`。因此 Windows 默认一次命令一条连接，凭据来自本次输入的密码或系统凭据管理器；确实需要复用时可设 `REPOWEFT_SSH_MULTIPLEX=1`（`0` 为强制关闭）。其他平台复用一个连接，Git 命令和终端共用，密码只输入一次。任何平台一旦检测到控制 socket 异常，会自动关闭复用并对当前命令重连一次，本次运行内不再尝试。

主机密钥保持严格校验：未知主机会先弹出指纹确认，确认后才写入 `known_hosts`；已记录但发生变化的密钥不会自动信任，只提示手动核实。远程仓库路径必须是绝对路径。

在服务器页面可以直接在远程新建（`git init`）或克隆（`git clone`）仓库：选择父目录、填写名称即可，创建完成后立即打开。

远程 Git 操作通过固定模板与逐参数 Shell 转义执行。仓库始终位于远程主机，推送所需凭证也由远程主机提供。

## 多语言扩展

语言入口为 `src/lib/i18n.tsx`。所有界面组件通过 `useI18n()` 读取文案；中文词条使用 `Record<MessageKey, string>`，缺少翻译会在 TypeScript 构建时报告。日期按所选语言格式化，用户的提交消息、路径和 Git 原始输出保持原文。

增加语言时：扩展 `Locale`，按 `MessageKey` 补齐词典，在 `App.tsx` 中注册，在设置页中添加语言选项。语言偏好自动持久保存。

## 架构

```text
src/components/       页面、对话框、图形与差异界面
src/lib/              多语言、持久状态、独立图布局算法
src/services/         统一 Git 服务和隔离演示数据
src/types.ts          前后端共享的数据契约
src-tauri/src/git.rs  本地/SSH 执行、结构化解析、固定操作白名单
```

UI 不构造 Git 或 SSH 命令。Rust 在后台线程执行命令，按仓库串行化写操作，限制输出大小并设置超时；写操作完成或失败后尝试刷新状态。当前统一使用系统 Git CLI，以复用凭证与 Hooks。

## 验证与打包

```powershell
pnpm build
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --bundles nsis
```

前端测试覆盖线性历史、合并、多父节点和分页边界。Rust 测试覆盖 SSH 参数转义、异常主机名、连接复用参数、密码认证与主机密钥错误的分类、重命名与中文文件名解析，以及临时仓库中的初始化、暂存、提交和分支切换。

Windows 安装包输出到 `src-tauri/target/release/bundle/nsis/`。

## 当前边界

这是第一版可运行实现，尚未覆盖规划中的全部阶段：

- Windows 上每条远程命令各建一条连接，单次刷新会并行发起数次握手；密码主机建议勾选保存。尚未实现后台自动重连与连接状态展示。
- 尚未接入 SQLite、git2、Canvas/Monaco、文件系统监听。图形使用独立布局与 SVG，Diff 使用轻量文本视图；刷新由用户或操作完成触发。
- 尚未实现分支重命名、编辑 remote URL、Stash、Rebase、Cherry-pick、Reset、逐行暂存、冲突解决器和撤销。合并冲突需在外部编辑器解决后回到应用暂存并提交。
- 不支持裸仓库工作区、二进制差异、完整 LFS 状态和非 UTF-8 文件名。远程未跟踪文件需先暂存再查看差异。
- 长操作会显示忙碌状态和最终输出，尚无实时进度或取消功能。超时后需刷新确认仓库状态，远程操作结果可能需要在服务器进一步核对。
- 生产发布尚需代码签名、macOS/Linux 实机验证、大型仓库基准、SSH 测试主机上的完整回归以及凭证失败与网络中断测试。

开发时使用的本地测试仓库均位于系统临时目录，不需要更改用户已有的 Git 配置或仓库。
