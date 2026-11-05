import type { Snapshot, Repository, CommitDetail } from "../types";

const now = Date.now();
const definitions = [
  [
    "a72e9b1",
    "Improve adapter training",
    "Alex Chen",
    ["main", "origin/main"],
    ["c3f91d2"],
  ],
  ["c3f91d2", "Fix temporal consistency", "Alex Chen", [], ["f42d6e9"]],
  [
    "9e14b8c",
    "Add sketch conditioning",
    "Sarah Park",
    ["feature/adapter"],
    ["f42d6e9"],
  ],
  ["f42d6e9", "Merge feature branch", "Alex Chen", [], ["8a7c3f1", "6d1e2c4"]],
  ["8a7c3f1", "Optimize training loop", "Alex Chen", [], ["1a0b9e7"]],
  ["6d1e2c4", "Refactor data pipeline", "Sarah Park", [], ["1a0b9e7"]],
  ["1a0b9e7", "Initial commit", "Alex Chen", ["v0.1.0"], []],
] as const;
export const demoSnapshot: Snapshot = {
  branch: "main",
  commits: definitions.map(([hash, message, author, refs, parents], i) => ({
    hash: hash.padEnd(40, "0"),
    message,
    author,
    email: `${author.split(" ")[0].toLowerCase()}@repoweft.dev`,
    refs: [...refs],
    parents: parents.map((p) => p.padEnd(40, "0")),
    timestamp: now - [120, 1080, 1440, 2880, 4320, 5760, 7200][i] * 60000,
  })),
  files: [
    { path: "src/train.py", index: " ", worktree: "M" },
    { path: "src/adapter.py", index: "M", worktree: " " },
    { path: "config.json", index: "?", worktree: "?" },
  ],
  branches: [
    {
      name: "main",
      current: true,
      remote: false,
      upstream: "origin/main",
      hash: "a72e9b1",
    },
    {
      name: "feature/adapter",
      current: false,
      remote: false,
      upstream: "",
      hash: "9e14b8c",
    },
    {
      name: "origin/main",
      current: false,
      remote: true,
      upstream: "",
      hash: "a72e9b1",
    },
  ],
  remotes: [
    { name: "origin", url: "git@github.com:alexchen/video-editing.git" },
  ],
};
export const demoRepository: Repository = {
  id: "demo-video",
  name: "video-editing",
  location: { kind: "local", path: "~/projects/video-editing" },
  favorite: true,
  lastOpened: now - 300000,
  demo: true,
};
export const demoDetail: CommitDetail = {
  message:
    "Improve adapter training\n\nImprove the adapter training strategy and stabilise the training process. Add learning rate scheduling and gradient clipping for more consistent results.",
  files: [
    { path: "src/train.py", added: "89", deleted: "12" },
    { path: "src/adapter.py", added: "28", deleted: "30" },
    { path: "config.json", added: "11", deleted: "0" },
  ],
};
export const demoDiff = `diff --git a/src/train.py b/src/train.py
--- a/src/train.py
+++ b/src/train.py
@@ -24,9 +24,15 @@ class AdapterTrainer:
     def configure_optimizer(self):
-        return Adam(self.parameters(), lr=1e-3)
+        optimizer = AdamW(
+            self.parameters(),
+            lr=self.config.learning_rate,
+            weight_decay=0.01,
+        )
+        return optimizer

     def training_step(self, batch):
         loss = self.compute_loss(batch)
+        self.clip_gradients(max_norm=1.0)
         loss.backward()
         return loss
`;
