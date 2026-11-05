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
    const repos = ["alpha", "beta"].map((id) => ({
      id,
      name: id,
      location: { kind: "local", path: `C:/qa/${id}` },
      favorite: false,
      lastOpened: Date.now(),
    }));
    localStorage.setItem("repoweft.v1.locale", JSON.stringify("en"));
    localStorage.setItem("repoweft.v1.accountsWelcomeSeen", "true");
    localStorage.setItem("repoweft.v1.openRepositories", JSON.stringify(repos));
    localStorage.setItem("repoweft.v1.repositories", JSON.stringify(repos));
    const commits = Array.from({ length: 1500 }, (_, i) => ({
      hash: (i + 1).toString(16).padStart(40, "0"),
      parents: i === 1499 ? [] : [(i + 2).toString(16).padStart(40, "0")],
      author: "QA",
      email: "",
      timestamp: Date.now(),
      message: `Commit ${i}`,
      refs: [],
    }));
    const files = Array.from({ length: 10000 }, (_, i) => ({
      path: `src/file${i}.ts`,
      index: " ",
      worktree: "M",
    }));
    const branches = Array.from({ length: 1000 }, (_, i) => ({
      name: i ? `branch-${i}` : "main",
      hash: commits[0].hash,
      remote: false,
      current: i === 0,
      upstream: "",
    }));
    window.qaCalls = [];
    window.qaSlowSnapshot = false;
    window.qaCancelled = [];
    const pending = new Map();
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      invoke: async (command, args = {}) => {
        window.qaCalls.push({ command, args });
        if (command === "accounts_list")
          return { accounts: [], activeId: null };
        if (command === "github_oauth_configuration")
          return { configured: false, installationUrl: null };
        if (command === "ssh_config_hosts") return [];
        if (command === "account_repository_get") return null;
        if (command === "repository_cancel") {
          window.qaCancelled.push(args.requestId);
          pending.get(args.requestId)?.();
          return;
        }
        if (command === "repository_snapshot") {
          if (window.qaSlowSnapshot)
            await new Promise((resolve, reject) => {
              pending.set(args.requestId, () => reject("READ_CANCELLED"));
              setTimeout(resolve, 1200);
            });
          return {
            branch: "main",
            commits: commits.slice(0, 100),
            files,
            branches,
            remotes: [],
          };
        }
        if (command === "repository_log")
          return commits.slice(args.skip, args.skip + 100);
        if (command === "repository_detail")
          return {
            message: "QA commit",
            files: files
              .slice(0, 5000)
              .map((file) => ({ path: file.path, added: "1", deleted: "0" })),
          };
        if (command === "repository_diff")
          return Array.from({ length: 100000 }, (_, i) => `+line ${i}`).join(
            "\n",
          );
        if (command === "repository_action") return "ok";
        return null;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator(".sidebar-repo").first().waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const baselineHeap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  await page.locator(".sidebar-repo").filter({ hasText: "alpha" }).click();
  await page.locator(".commit-row").first().waitFor();
  assert.ok((await page.locator(".file-row").count()) < 60);
  await page.locator(".commit-row").first().click();
  await page.locator(".changed-files button").first().waitFor();
  assert.ok((await page.locator(".changed-files button").count()) < 60);
  await page.locator(".changed-files button").first().click();
  await page.locator(".diff-view pre > div").first().waitFor();
  const diffRows = await page.locator(".diff-view pre > div").count();
  assert.ok(diffRows < 70, `mounted diff rows: ${diffRows}`);
  await page
    .locator(".diff-view")
    .evaluate((element) => (element.scrollTop = element.scrollHeight));
  await page.waitForFunction(() =>
    document.querySelector(".diff-view")?.textContent.includes("line 99999"),
  );
  await page.screenshot({
    path: path.join(tmpdir(), "repoweft-large-diff.png"),
  });
  await page
    .getByRole("button", { name: "Close", exact: true })
    .filter({ visible: true })
    .last()
    .click();
  await page.locator(".branch-selector").click();
  assert.ok((await page.locator(".branch-menu button").count()) < 30);
  await page.locator(".branch-menu input").fill("branch-999");
  await page.getByRole("button", { name: "branch-999", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  // Exercise bounded history forward and backward navigation.
  for (let i = 0; i < 11; i++) {
    const previous = await page.evaluate(
      () =>
        window.qaCalls.filter((call) => call.command === "repository_log")
          .length,
    );
    await page
      .locator(".commit-list-scroll")
      .evaluate((element) => (element.scrollTop = element.scrollHeight));
    await page.waitForFunction(
      (count) =>
        window.qaCalls.filter((call) => call.command === "repository_log")
          .length > count,
      previous,
    );
  }
  await page
    .getByRole("button", { name: "Load previous commits", exact: true })
    .waitFor();
  assert.ok((await page.locator(".commit-row").count()) < 60);
  await page
    .getByRole("button", { name: "Load previous commits", exact: true })
    .click();
  // A slow refresh must leave close controls responsive and cancel its read.
  await page.evaluate(() => (window.qaSlowSnapshot = true));
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Close repository alpha", exact: true })
      .isEnabled(),
    true,
  );
  const started = Date.now();
  await page
    .getByRole("button", { name: "Close repository alpha", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close repository alpha", exact: true })
    .waitFor({ state: "detached" });
  const closeMs = Date.now() - started;
  await page
    .getByRole("button", { name: "Close repository beta", exact: true })
    .click();
  await page.waitForTimeout(1400);
  assert.equal(await page.locator(".open-repository-row").count(), 0);
  assert.equal(await page.locator(".repository-content-pane").count(), 0);
  assert.ok(await page.evaluate(() => window.qaCancelled.length > 0));
  assert.deepEqual(errors, []);
  await cdp.send("HeapProfiler.collectGarbage");
  const closedHeap = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  console.log(
    JSON.stringify(
      {
        diffLines: 100000,
        mountedDiffRows: diffRows,
        workingFiles: 10000,
        detailFiles: 5000,
        branches: 1000,
        closeMs,
        baselineHeap,
        closedHeap,
        screenshot: path.join(tmpdir(), "repoweft-large-diff.png"),
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
