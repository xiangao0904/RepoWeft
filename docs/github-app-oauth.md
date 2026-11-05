# GitHub App 设备授权

RepoWeft 直接连接 GitHub 完成 OAuth 设备授权和 Token 刷新，无需运营授权服务、配置 Client Secret 或生成 Private Key。普通用户点击 Sign in with GitHub，复制应用显示的短码，在系统浏览器的 GitHub 页面输入短码并确认。应用检测授权结果，保存账号并自动连接。

## 开发者配置一次

当前默认 Client ID 为 `Iv23li8CYshl2Yf2vXzf`，App slug 为 `repoweftgit`。

1. 打开 [RepoWeft GitHub App 设置](https://github.com/settings/apps/repoweftgit)。
2. 勾选 **Enable Device Flow** 并保存。
3. 保持用户 Token 过期开启；应用请求 `offline_access`，获得可轮换的 Token 对。
4. 不需要开启安装时的浏览器 OAuth 跳转（Request user authorization during installation）。设备授权不使用 Callback URL；之前填写的本机回调可以移除。
5. 用户通过账号管理中的 Manage repository access，将 App 安装到需要访问的仓库。组织可能要求管理员批准或有效 SSO 会话。

Contents 读写用于 Git 和 Release/Tag；Pull requests 读写用于 PR；Issues 读写用于 Issue。权限配置不代表相应界面已经实现，当前应先验证登录和 Git 操作。PR 和 Issue 管理仍需开发具体界面与 API 调用。

可选的公开配置覆盖：`REPOWEFT_GITHUB_CLIENT_ID`、`REPOWEFT_GITHUB_APP_SLUG`。生产构建使用编译时配置，调试构建允许运行时覆盖。桌面应用不再读取 `REPOWEFT_OAUTH_BROKER_URL`。

## 用户登录

点击 Sign in with GitHub 后，应用显示短码并打开 `https://github.com/login/device`。只输入自己在应用里发起登录时显示的短码。若浏览器没有自动打开，可以点击 Open GitHub authorization page 或手动访问此地址。

等待期间可取消。短码过期或授权被拒绝后可以重新发起。多账号可以反复登录添加；重新连接已有账号时，应用提示期望的用户名，并在 GitHub 授权后校验稳定的数字 ID，选错账号不会覆盖原账号。

授权和安装分别处理：登录后若无法访问私有仓库，检查当前账号、仓库绑定、App 安装范围、组织批准和 SSO 状态。

## 凭据与安全边界

Rust 直接调用固定的 GitHub HTTPS 端点，禁止自动重定向。设备登录只向 React 发送用户短码、固定的 GitHub 验证页面、过期时间和期望用户名。Device Code、Access Token 和 Refresh Token 不进入 React 或 WebView 存储，也不记录日志。

轮询遵守 GitHub 的 interval；authorization_pending 继续等待，slow_down 至少增加五秒间隔；拒绝、过期、网络错误分别显示提示。取消会中止请求和等待。设备流程不使用 PKCE 或本机回调监听。

OAuth Token 对保存在系统凭据库 `repoweft.github / oauth:<GitHub user ID>`。接近过期时，后台直接向 GitHub 刷新，刷新请求仅包含 Client ID、Refresh Token 和 grant_type。刷新和账号修改共用锁，新 Token 对一次写入系统凭据库后才能提供给 Git。网络故障保留已有凭据；Refresh Token 被拒绝或过期时要求重新授权。上游轮换成功但响应丢失时，可能需要重新授权。

旧浏览器流程保存的 Token 需要重新登录一次；它们不能按设备授权方式无 Secret 刷新。旧 PAT 账号兼容读取，已保存 PAT、仓库绑定和 SSH 配置保留。

仓库的 `repoweft.githubAccount` 本机配置优先于默认账号；System Git / SSH 使用系统凭据。移除绑定账号后不自动改用其他账号。GitHub 身份、`user.name`、`user.email`、签名与 SSH 密钥分别管理。远程 SSH 工作区和终端使用执行机器自己的凭据，不上传本机 GitHub Token。

Git 明确认证失败会提示重新连接；写操作不自动重试。移除账号只删除本机凭据，GitHub 端授权可在 GitHub Settings → Applications 中撤销。

仓库中的 `oauth-broker/` 是之前浏览器回调方案的独立服务代码，当前设备登录不调用它，也无需部署。

## 验证

```powershell
pnpm build
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml -j 1 --config profile.test.package.repoweft.debug=0
```

自动测试覆盖轮询等待与减速、拒绝和过期、取消、验证地址校验、无 Secret 刷新参数、旧 Token 迁移、PAT 兼容、仓库绑定与 Git helper 隔离。真实设备授权、系统凭据库保存和私有仓库 Clone/Fetch/Pull/Push 仍需使用真实 GitHub 账号回归。

参考：[GitHub App 设备授权](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)、[刷新用户 Token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)。
