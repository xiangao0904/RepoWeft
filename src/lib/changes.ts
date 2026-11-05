export function conflicted(file: { index: string; worktree: string }) {
  return (
    file.index === "U" ||
    file.worktree === "U" ||
    ["AA", "DD"].includes(file.index + file.worktree)
  );
}
