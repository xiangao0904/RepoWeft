# Git workflows and coverage

RepoWeft runs these operations through the installed Git client for local repositories and through Git on the selected SSH host for remote workspaces.

## Available controls

- History keeps the original commit list layout, with branch and tag labels on the metadata line after the author, abbreviated hash, and timestamp. Commit titles and metadata keep a consistent left alignment. Labels only occupy space on rows that have references; no separate reference column is reserved. Computer and cloud icons distinguish local branches from remote tracking branches; a check marks the current branch. Ahead/behind counts appear in the current branch tooltip. Remote tracking references represent the last fetched state.
- Right-click a commit, or select it and open Commit actions, to open a compact grouped menu next to the pointer or button. The menu supports keyboard navigation, viewport edge positioning, and dismissal on outside clicks or scrolling. Creating a branch or lightweight tag and editing a commit message use a compact top input without dimming the worktree. Enter confirms names, Ctrl/Command+Enter saves multiline messages, and Escape cancels. Other actions open a focused confirmation. The actions let you create a branch or lightweight tag, check out a detached revision, reset the current branch, revert, cherry-pick, merge, rebase, or edit its message.
- Reset offers soft, mixed, and hard modes with an explanation before execution.
- Editing the latest message preserves staged and unstaged changes using a message-only amend. Older messages are replayed in a temporary worktree, preserving the original index, working files, and untracked files. The original branch is updated only after the replay succeeds, the final file tree matches, and the temporary worktree is removed. An attached branch with no operation in progress is required. Older histories containing merges are rejected before rewriting. After a successful rewrite of a commit contained in fetched remote branches, a separate prompt offers to keep the edit locally or force push to a selected remote branch. The expected remote object ID is captured before rewriting and remains pinned even if a later fetch updates tracking refs. The push also checks that the local branch and rewritten head have not changed.
- Changes supports staging, unstaging, discarding unstaged changes, empty commits, and amending the latest commit with staged changes. A nonempty message is always required.
- Conflict selection opens inside the main worktree area. Equal left and right panes show ours and theirs, each with a button that saves and stages that version. A collapsed manual editor supports combined resolutions and viewing the common ancestor. Binary or oversized files retain whole-file resolution controls.
- Merge, rebase, cherry-pick, and revert expose continue and abort controls; applicable operations also support skipping a commit. Rebase reverses the intuitive meaning of ours/theirs, so the comparison explains those roles.
- The workspace tools section lists local tags and stashes, publishes the current branch, pushes tags to a selected remote, and supports stash creation, apply, pop, and deletion.
- Branches can be renamed, switched, created, safely deleted, merged, and checked out from remote tracking branches.
- Fetch updates all remotes, prunes deleted tracking branches, and fetches tags. Pull uses fast-forward only.
- Force push explicitly names the configured upstream branch and its expected object ID. Git rejects the push when that remote branch has changed since the last fetch. It never falls back to an unconditional force push.

## GitHub access checks

The repository account control includes Check push access. It checks the selected remote's push URL, the credentials selected for this repository, the repository API response, and GitHub App installation Contents permissions when available. Credentials stay in Rust. Requests use fixed GitHub API endpoints and reject redirects.

A repository owner still needs to grant the app Contents read/write permission and installation access to the repository. After changing app permissions, existing installations may need to approve them. Repository selection, branch rules, workflow permissions, and SSO can independently block a push. System Git / SSH uses the user's existing credential setup and is never silently selected as a fallback.

The diagnostic is read-only. It does not test by pushing, change GitHub settings, or establish that a later push must succeed.

## Remaining parity work

The implemented controls cover the core workflows above. They do not yet cover every feature in Git or other Git clients. Remaining areas include general interactive rebase plans (squash, fixup, drop, reorder and merge-preserving history edits), reflog recovery, linked worktree management, submodule/LFS management, line/hunk staging, blame, signing configuration, and hosting-provider PR/issue workflows. Reverting or cherry-picking merge commits currently requires choosing a mainline parent through the terminal.

## Verification

- `pnpm build`
- `pnpm test`
- `cargo test --manifest-path src-tauri/Cargo.toml -j 1 --config profile.test.package.repoweft.debug=0`
- `node tests/git-workflows-ui.mjs` and `node tests/performance-ui.mjs` with Playwright installed, or `REPOWEFT_PLAYWRIGHT_MODULE` pointing at its `index.mjs`.

Rust tests use temporary repositories and local bare remotes to verify history rewrites, empty commits, branch/tag actions, resets, amended trees, literal file paths, conflict resolution, stash round trips, branch publication, and lease rejection. Browser tests verify action arguments, confirmation boundaries, access reports, and inline equal-width conflict panes. Real GitHub credentials and SSH servers still require live validation.

References: [Git push leases](https://git-scm.com/docs/git-push), [GitHub App user permissions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [GitKraken history editing](https://help.gitkraken.com/gitkraken-desktop/interactive-rebase/).
