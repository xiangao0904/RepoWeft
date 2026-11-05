import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
const { chromium } = await import(
  process.env.REPOWEFT_PLAYWRIGHT_MODULE
    ? pathToFileURL(path.resolve(process.env.REPOWEFT_PLAYWRIGHT_MODULE)).href
    : "playwright"
);
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, "../dist");
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(
      root,
      "." + (req.url === "/" ? "/index.html" : req.url.split("?")[0]),
    );
    if (!file.startsWith(path.resolve(root) + path.sep))
      throw new Error("invalid path");
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".html")
            ? "text/html"
            : "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--disable-gpu", "--renderer-process-limit=1"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(() => {
    const repo = {
      id: "workflow",
      name: "workflow",
      location: { kind: "local", path: "C:/qa/workflow" },
      favorite: false,
      lastOpened: Date.now(),
    };
    for (const key of ["openRepositories", "repositories"])
      localStorage.setItem(`repoweft.v1.${key}`, JSON.stringify([repo]));
    localStorage.setItem("repoweft.v1.locale", JSON.stringify("en"));
    localStorage.setItem("repoweft.v1.accountsWelcomeSeen", "true");
    const hash = "1".repeat(40);
    window.qaHeadIndex = 0;
    window.qaActions = [];
    window.qaConflict = false;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (command, args = {}) => {
        if (command === "accounts_list")
          return { accounts: [], activeId: null };
        if (command === "github_oauth_configuration")
          return { configured: false, installationUrl: null };
        if (command === "ssh_config_hosts") return [];
        if (command === "repository_snapshot")
          return {
            branch: "main",
            commits: Array.from({ length: 8 }, (_, i) => ({
              hash: String(i + 1).repeat(40),
              parents:
                i === 1
                  ? ["4".repeat(40)]
                  : i < 7
                    ? [String(i + 2).repeat(40)]
                    : [],
              message: [
                "Initial commit",
                "Improve repository history",
                "Add branch navigation",
                "Keep the worktree in sync",
                "Refine conflict resolution",
                "Last published commit",
                "Prepare release notes",
                "Create repository",
              ][i],
              author: "QA",
              email: "",
              timestamp: Date.now() - i * 60000,
              refs:
                i === window.qaHeadIndex
                  ? ["HEAD -> refs/heads/main"]
                  : i === 2
                    ? ["refs/heads/feature/navigation"]
                    : i === 5
                      ? ["refs/remotes/origin/main"]
                      : i === 7
                        ? [
                            "tag: refs/tags/v1",
                            "refs/heads/release",
                            "refs/heads/archive",
                            "refs/remotes/origin/release",
                          ]
                        : [],
            })),
            branches: [
              {
                name: "main",
                current: true,
                remote: false,
                hash: String(window.qaHeadIndex + 1).repeat(40),
                upstream: "origin/main",
              },
              {
                name: "origin/main",
                current: false,
                remote: true,
                hash: "6".repeat(40),
                upstream: "",
              },
            ],
            files: window.qaConflict
              ? [{ path: "conflict.txt", index: "U", worktree: "U" }]
              : [],
            remotes: [
              { name: "origin", url: "https://github.com/owner/repo.git" },
            ],
            tags: ["v1"],
            stashes: [],
            tracking: { ahead: 2, behind: 1 },
            operation: window.qaConflict ? "merge" : null,
          };
        if (command === "repository_detail")
          return { message: "Initial commit\n\nPreserve body", files: [] };
        if (command === "repository_action") {
          window.qaActions.push(args.action);
          if (
            [
              "resolveEdited",
              "resolveOurs",
              "resolveTheirs",
              "resolveDelete",
            ].includes(args.action.kind)
          )
            window.qaConflict = false;
          return "ok";
        }
        if (command === "repository_conflict")
          return { base: "base\n", ours: "ours\n", theirs: "theirs\n" };
        if (command === "account_repository_access")
          return {
            repository: "owner/repo",
            login: "owner",
            method: "oauth",
            status: 200,
            userCanPush: true,
            contentsPermission: "read",
            installationFound: true,
          };
        return null;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator(".sidebar-repo").first().click();
  await page.locator(".commit-row").first().waitFor();
  assert.equal(await page.locator(".ref-legend").count(), 0);
  assert.equal(
    await page
      .locator(".commit-row")
      .first()
      .locator(".ref-local .ref-name")
      .innerText(),
    "main",
  );
  assert.match(
    await page
      .locator(".commit-row")
      .first()
      .locator(".ref-current")
      .getAttribute("title"),
    /2 commits to push/,
  );
  assert.equal(
    await page.locator(".commit-row").first().locator(".lucide-laptop").count(),
    1,
  );
  assert.equal(
    await page
      .locator(".commit-row")
      .nth(5)
      .locator(".ref-remote .ref-name")
      .innerText(),
    "origin/main",
  );
  assert.equal(
    await page.locator(".commit-row").nth(5).locator(".lucide-cloud").count(),
    1,
  );
  assert.equal(
    await page
      .locator(".commit-row")
      .nth(7)
      .locator(".ref-overflow")
      .innerText(),
    "+2",
  );
  assert.equal(
    await page.locator(".commit-ref-rail, .history-columns").count(),
    0,
  );
  const alignment = await page.evaluate(() => {
    const row = document
      .querySelectorAll(".commit-row")[5]
      .getBoundingClientRect();
    const label = document
      .querySelectorAll(".commit-row")[5]
      .querySelector(".ref-remote")
      .getBoundingClientRect();
    const node = document
      .querySelectorAll(".commit-graph > g")[5]
      .querySelector("circle")
      .getBoundingClientRect();
    const message = document
      .querySelectorAll(".commit-row")[5]
      .querySelector(".commit-row-title > strong")
      .getBoundingClientRect();
    const graph = document
      .querySelector(".commit-graph")
      .getBoundingClientRect();
    const list = document.querySelector(".commit-list").getBoundingClientRect();
    return {
      ordered: node.right < message.x && message.right <= label.x,
      graphOffset: graph.x - list.x,
      titleOffset: message.x - list.x,
      rowHeight: row.height,
    };
  });
  assert.ok(alignment.ordered, JSON.stringify(alignment));
  assert.equal(alignment.graphOffset, 0);
  assert.ok(alignment.titleOffset < 110, JSON.stringify(alignment));
  assert.equal(alignment.rowHeight, 44);
  await page.screenshot({
    animations: "disabled",
    path: path.join(tmpdir(), "repoweft-history-actions.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.screenshot({
    animations: "disabled",
    path: path.join(tmpdir(), "repoweft-history-refs-light.png"),
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    window.qaHeadIndex = 3;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".commit-row").nth(3).locator(".ref-current").waitFor();
  assert.equal(
    await page
      .locator(".commit-graph > g")
      .nth(3)
      .locator('circle[r="7"]')
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(".commit-graph > g")
      .first()
      .locator('circle[r="7"]')
      .count(),
    0,
  );
  await page.evaluate(() => {
    window.qaHeadIndex = 0;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".commit-row").first().locator(".ref-current").waitFor();
  const commit = page.locator(".commit-form .primary-button");
  await page.getByRole("textbox", { name: "Summary (required)" }).count();
  await page
    .locator(".commit-form input:not([type=checkbox])")
    .fill("Empty commit");
  assert.equal(await commit.isDisabled(), true);
  await page.getByRole("checkbox", { name: "Allow empty commit" }).check();
  assert.equal(await commit.isEnabled(), true);
  await commit.click();
  await page.waitForFunction(() =>
    window.qaActions.some((a) => a.kind === "commit"),
  );
  assert.equal(
    await page.evaluate(
      () => window.qaActions.find((a) => a.kind === "commit").allowEmpty,
    ),
    true,
  );
  await page.locator(".commit-row").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit commit message" }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Name or commit message" })
      .inputValue(),
    "Initial commit\n\nPreserve body",
  );
  await page
    .getByRole("textbox", { name: "Name or commit message" })
    .fill("Reworded\n\nFull body");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForFunction(() =>
    window.qaActions.some((a) => a.kind === "reword"),
  );
  assert.equal(
    await page.evaluate(
      () => window.qaActions.find((a) => a.kind === "reword").extra,
    ),
    "1".repeat(40),
  );
  await page
    .getByRole("button", { name: "Force push with lease", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      () => window.qaActions.filter((a) => a.kind === "forcePush").length,
    ),
    0,
  );
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForFunction(() =>
    window.qaActions.some((a) => a.kind === "forcePush"),
  );
  await page
    .getByRole("button", { name: "Check push access", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Check push access", exact: true })
    .click();
  await page.locator(".access-report").waitFor();
  assert.match(
    await page.locator(".access-report").innerText(),
    /Contents permission\nread/,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.evaluate(() => {
    window.qaConflict = true;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare and edit resolution", exact: true })
    .click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  const halves = await page
    .locator(".conflict-side")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().width),
    );
  assert.equal(halves.length, 2);
  assert.ok(Math.abs(halves[0] - halves[1]) <= 1);
  await page.screenshot({
    animations: "disabled",
    path: path.join(tmpdir(), "repoweft-conflict-split.png"),
  });
  await page
    .getByRole("button", { name: "Use this version", exact: true })
    .nth(1)
    .click();
  await page.waitForFunction(() =>
    window.qaActions.some((a) => a.kind === "resolveTheirs"),
  );
  await page.evaluate(() => {
    window.qaConflict = true;
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare and edit resolution", exact: true })
    .click();
  await page.getByText("Combine versions manually", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Resolved content", exact: true })
    .fill("combined\n");
  await page.screenshot({
    animations: "disabled",
    path: path.join(tmpdir(), "repoweft-conflict-editor.png"),
  });
  await page.getByRole("button", { name: "Save and stage resolution" }).click();
  await page.waitForFunction(() =>
    window.qaActions.some((a) => a.kind === "resolveEdited"),
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.qaActions.find((a) => a.kind === "resolveEdited").paths,
    ),
    ["conflict.txt"],
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        actions: await page.evaluate(() => window.qaActions),
        errors,
        screenshots: [
          path.join(tmpdir(), "repoweft-history-actions.png"),
          path.join(tmpdir(), "repoweft-conflict-editor.png"),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
