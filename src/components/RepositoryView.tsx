import { VirtualList, VirtualDiff } from "./VirtualList";
import { appendHistory } from "../lib/windowing";
import { isReadCancelled } from "../lib/requests";
import { createPageGate } from "../lib/paging";
import {
  memo,
  useEffect,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Globe2,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  Action,
  Commit,
  CommitDetail,
  DiffSource,
  FileChange,
  Repository,
  Snapshot,
} from "../types";
import { relativeTime, useI18n, errorText, type MessageKey } from "../lib/i18n";
import { gitService } from "../services/git";
import { Avatar, Splitter, BranchBadge, Empty, Modal } from "./ui";
import { CommitGraph } from "./CommitGraph";
import { githubRepository } from "../lib/avatars";
import { layoutGraph } from "../lib/graph";

import {
  CommitActions,
  ConflictEditor,
  OperationStatus,
  WorkspaceTools,
  conflicted,
} from "./GitTools";
import { useStored } from "../lib/storage";

export type RepoTab = "history" | "changes" | "branches" | "remotes";
export interface RepoViewProps {
  terminal?: ReactNode;
  repo: Repository;
  data: Snapshot;
  tab: RepoTab;
  busy: boolean;
  onAction: (action: Action) => Promise<boolean>;
  onExpandUntracked: () => Promise<void>;
  onPrompt: (type: "branch" | "remote") => void;
  onConfirm: (message: MessageKey, action: Action) => void;
  notify: (message: string, error?: boolean) => void;
}

export function RepositoryView(props: RepoViewProps) {
  if (props.tab === "history")
    return <History {...props} key={props.repo.id} />;
  return (
    <div className="repository-center-column">
      {props.tab === "changes" ? (
        <Changes {...props} key={props.repo.id} />
      ) : (
        <RepositoryLists {...props} />
      )}
      {props.terminal}
    </div>
  );
}

function RepositorySync({ data }: { data: Snapshot }) {
  const { t } = useI18n();
  const branch = data.branches.find((b) => b.current);
  const upstream = data.branches.find(
    (b) => b.remote && b.name === branch?.upstream,
  );
  return (
    <div className="ref-legend">
      <span className="ref-local">
        {t("localRef")}: {data.branch} <code>{branch?.hash.slice(0, 7)}</code>
      </span>
      <span className="ref-remote">
        {t("remoteRef")}: {branch?.upstream || t("noUpstream")}{" "}
        <code>{upstream?.hash.slice(0, 7)}</code>
      </span>
      {data.tracking && (
        <strong>
          {data.tracking.ahead} {t("aheadCommits")} · {data.tracking.behind}{" "}
          {t("behindCommits")}
        </strong>
      )}
      <small>{t("refLegend")}</small>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  commit: c,
  selected,
  githubRepo,
  onSelect,
  onContext,
  remoteNames,
}: {
  onContext: (commit: Commit) => void;
  remoteNames: string[];
  commit: Commit;
  selected: boolean;
  githubRepo: string | null;
  onSelect: (commit: Commit) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <button
      className={`commit-row ${selected ? "selected" : ""}`}
      onClick={() => onSelect(c)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(c);
      }}
    >
      <div className="commit-row-title">
        <strong>{c.message}</strong>
        {c.refs.map((ref) => (
          <BranchBadge
            key={ref}
            name={ref}
            remote={
              ref.startsWith("refs/remotes/") ||
              remoteNames.some((name) => ref.startsWith(`${name}/`))
            }
          />
        ))}
      </div>
      <div className="commit-meta">
        <Avatar
          name={c.author}
          email={c.email}
          githubRepo={githubRepo}
          hash={c.hash}
        />
        <span>{c.author}</span>
        <span className="meta-dot">·</span>
        <code>{c.hash.slice(0, 7)}</code>
        <span className="meta-dot">·</span>
        <span>{relativeTime(c.timestamp, locale, t)}</span>
      </div>
    </button>
  );
});

function History(props: RepoViewProps) {
  const { repo, data, notify } = props;
  const { t, locale } = useI18n();
  const [actionCommit, setActionCommit] = useState<Commit | null>(null);
  const openActions = useCallback(
    (commit: Commit) => {
      void gitService
        .detail(repo, commit.hash)
        .then((detail) =>
          setActionCommit({ ...commit, message: detail.message }),
        )
        .catch((error) => notify(errorText(error, t), true));
    },
    [repo, notify, t],
  );
  const remoteNames = useMemo(
    () => data.remotes.map((r) => r.name),
    [data.remotes],
  );
  const [commits, setCommits] = useState(data.commits);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query.trim().toLowerCase());
  const [currentOnly, setCurrentOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(data.commits.length === 100);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailTab, setDetailTab] = useState<"details" | "files">("details");
  const [file, setFile] = useState<string | null>(null);
  const [workingDiff, setWorkingDiff] = useState<{
    path: string;
    staged: boolean;
    untracked: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const pageGate = useRef(createPageGate());
  const pageAbort = useRef<AbortController | null>(null);
  const offset = useRef(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const selectCommit = useCallback(
    (commit: Commit) =>
      setSelected((old) => (old?.hash === commit.hash ? null : commit)),
    [],
  );
  useEffect(
    () => () => {
      pageGate.current.invalidate();
      pageAbort.current?.abort();
    },
    [],
  );
  const [pageError, setPageError] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [inspectorWidth, setInspectorWidth] = useStored("inspectorWidth", 350);
  const layoutRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = 44;
  const githubRepo = useMemo(
    () =>
      data.remotes.map((r) => githubRepository(r.url)).find(Boolean) ?? null,
    [data.remotes],
  );
  const [viewportHeight, setViewportHeight] = useState(880);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewportHeight(Math.ceil(entry.contentRect.height)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query, currentOnly, data.branch]);
  useEffect(() => {
    const request = pageGate.current.invalidate();
    pageAbort.current?.abort();
    const controller = new AbortController();
    pageAbort.current = controller;
    offset.current = 0;
    setHistoryOffset(0);
    let cancelled = false;
    setPageError(false);
    if (!currentOnly) {
      setCommits(data.commits);
      setHasMore(data.commits.length === 100);
      setSelected(
        (old) => data.commits.find((c) => c.hash === old?.hash) ?? null,
      );
      setLoading(false);
      return;
    }
    setLoading(true);
    void gitService
      .log(repo, 0, currentOnly, controller.signal)
      .then((next) => {
        if (cancelled || !pageGate.current.isCurrent(request)) return;
        setCommits(next);
        setHasMore(next.length === 100);
        setSelected((old) => next.find((c) => c.hash === old?.hash) ?? null);
      })
      .catch((error) => {
        if (!cancelled && !isReadCancelled(error)) notify(String(error), true);
      })
      .finally(() => {
        if (!cancelled && pageGate.current.isCurrent(request))
          setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      pageGate.current.invalidate();
    };
  }, [repo, data.commits, currentOnly, notify]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    setFile(null);
    if (selected)
      gitService
        .detail(repo, selected.hash, controller.signal)
        .then((value) => {
          if (!cancelled) setDetail(value);
        })
        .catch((error) => {
          if (!cancelled) setDetailError(String(error));
        });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [repo, selected?.hash]);
  const loadMore = useCallback(async () => {
    if (loading || !hasMore || pageError) return;
    const request = pageGate.current.begin();
    if (request === null) return;
    setLoading(true);
    try {
      const controller = new AbortController();
      pageAbort.current = controller;
      const next = await gitService.log(
        repo,
        offset.current + commits.length,
        currentOnly,
        controller.signal,
      );
      if (pageGate.current.isCurrent(request)) {
        const window = appendHistory(commits, next, offset.current);
        offset.current = window.offset;
        setHistoryOffset(window.offset);
        setCommits(window.items);
        if (window.removed && scrollRef.current) {
          scrollRef.current.scrollTop = Math.max(
            0,
            scrollRef.current.scrollTop - window.removed * rowHeight,
          );
          setScrollTop(scrollRef.current.scrollTop);
        }
        setHasMore(next.length === 100);
      }
    } catch (error) {
      if (pageGate.current.isCurrent(request) && !isReadCancelled(error)) {
        setPageError(true);
        notify(String(error), true);
      }
    } finally {
      if (pageGate.current.finish(request)) {
        setLoading(false);
      }
    }
  }, [repo, commits, currentOnly, loading, hasMore, pageError, notify]);
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore || pageError) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry.isIntersecting &&
          (!searchQuery ||
            (scrollRef.current &&
              scrollRef.current.scrollHeight > scrollRef.current.clientHeight))
        )
          void loadMore();
      },
      { root: scrollRef.current, rootMargin: "0px 0px 440px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, hasMore, pageError, searchQuery]);
  const visible = useMemo(
    () =>
      commits.filter((c) =>
        `${c.message} ${c.author} ${c.hash}`
          .toLowerCase()
          .includes(searchQuery),
      ),
    [commits, searchQuery],
  );
  const graph = useMemo(
    () =>
      layoutGraph(
        currentOnly
          ? visible.map((commit) => ({
              ...commit,
              parents: commit.parents.slice(0, 1),
            }))
          : visible,
      ),
    [visible, currentOnly],
  );
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight) - 6),
    Math.max(0, visible.length - 30),
  );
  const end = Math.min(
    visible.length,
    start + Math.ceil(viewportHeight / rowHeight) + 12,
  );
  return (
    <div
      ref={layoutRef}
      className="history-layout density-compact"
      style={{ "--commit-height": `${rowHeight}px` } as CSSProperties}
    >
      {actionCommit && (
        <CommitActions
          commit={actionCommit}
          busy={props.busy}
          onAction={props.onAction}
          onClose={() => setActionCommit(null)}
        />
      )}
      <div className="repository-center-column">
        <OperationStatus {...props} />
        <WorkspaceTools {...props} />
        <RepositorySync data={data} />
        {!selected &&
          workingDiff &&
          (data.files.some(
            (f) => f.path === workingDiff.path && conflicted(f),
          ) ? (
            <ConflictEditor
              key={workingDiff.path}
              repo={repo}
              path={workingDiff.path}
              busy={props.busy}
              onAction={props.onAction}
              onClose={() => setWorkingDiff(null)}
            />
          ) : (
            <section className="history-main-diff file-diff-panel">
              <header>
                <strong>{workingDiff.path}</strong>
                <button
                  className="icon-button diff-close"
                  title={t("close")}
                  aria-label={t("close")}
                  onClick={() => setWorkingDiff(null)}
                >
                  <X size={16} />
                </button>
              </header>
              <Diff repo={repo} {...workingDiff} />
            </section>
          ))}
        {selected && file && (
          <section className="history-main-diff file-diff-panel">
            <header>
              <FileText size={16} />
              <strong title={file}>{file}</strong>
              <button
                className="icon-button diff-close"
                title={t("close")}
                aria-label={t("close")}
                onClick={() => setFile(null)}
              >
                <X size={16} />
              </button>
            </header>
            <Diff
              key={`${selected.hash}:${file}`}
              repo={repo}
              path={file}
              staged={false}
              hash={selected.hash}
            />
          </section>
        )}
        <section
          className="history-panel"
          style={
            (selected && file) || (!selected && workingDiff)
              ? { display: "none" }
              : undefined
          }
        >
          <div className="history-filters">
            <BranchSwitcher {...props} />
            <div className="segmented-control" aria-label={t("branches")}>
              {[false, true].map((value) => (
                <button
                  key={String(value)}
                  aria-pressed={currentOnly === value}
                  onClick={() => {
                    if (value === currentOnly) return;
                    pageGate.current.invalidate();
                    setCommits([]);
                    setHasMore(false);
                    setSelected(null);
                    setLoading(true);
                    setCurrentOnly(value);
                  }}
                >
                  {t(value ? "currentBranch" : "allBranches")}
                </button>
              ))}
            </div>
            <div className="search-field">
              <Search size={14} />
              <input
                aria-label={t("searchCommits")}
                placeholder={t("searchCommits")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div
            ref={scrollRef}
            className="commit-list-scroll"
            onScroll={(e) => {
              const top =
                Math.floor(e.currentTarget.scrollTop / rowHeight) * rowHeight;
              setScrollTop((previous) => (previous === top ? previous : top));
            }}
          >
            {historyOffset > 0 && (
              <button
                className="text-button"
                disabled={loading}
                onClick={async () => {
                  const token = pageGate.current.begin();
                  if (token === null) return;
                  setLoading(true);
                  const controller = new AbortController();
                  pageAbort.current = controller;
                  try {
                    const previousOffset = Math.max(0, offset.current - 100);
                    const previous = await gitService.log(
                      repo,
                      previousOffset,
                      currentOnly,
                      controller.signal,
                    );
                    if (!pageGate.current.isCurrent(token)) return;
                    offset.current = previousOffset;
                    setHistoryOffset(previousOffset);
                    setCommits((items) =>
                      [...previous, ...items].slice(0, 1000),
                    );
                    setHasMore(true);
                    setPageError(false);
                    if (scrollRef.current) scrollRef.current.scrollTop = 0;
                    setScrollTop(0);
                  } catch (error) {
                    if (!isReadCancelled(error)) notify(String(error), true);
                  } finally {
                    if (pageGate.current.finish(token)) setLoading(false);
                  }
                }}
              >
                {t("loadPrevious")}
              </button>
            )}
            {loading && !commits.length ? (
              <div
                className="diff-loading"
                role="status"
                aria-label={t("working")}
              >
                <LoaderCircle size={20} className="spin" />
              </div>
            ) : !visible.length ? (
              <Empty
                icon={<GitCommitHorizontal size={30} />}
                title={t(query ? "noResults" : "noCommits")}
                description={!query ? t("noCommitsDescription") : undefined}
              />
            ) : (
              <div
                className="commit-list"
                style={{ "--graph-width": `${graph.width}px` } as CSSProperties}
              >
                <CommitGraph
                  graph={graph}
                  start={start}
                  end={end}
                  rowHeight={rowHeight}
                />
                <div className="commit-rows">
                  <div style={{ height: start * rowHeight, flexShrink: 0 }} />
                  {visible.slice(start, end).map((c) => (
                    <CommitRow
                      key={c.hash}
                      commit={c}
                      selected={selected?.hash === c.hash}
                      githubRepo={githubRepo}
                      onSelect={selectCommit}
                      onContext={openActions}
                      remoteNames={remoteNames}
                    />
                  ))}
                  <div
                    style={{
                      height: (visible.length - end) * rowHeight,
                      flexShrink: 0,
                    }}
                  />
                </div>
              </div>
            )}
            {hasMore && (
              <div
                ref={sentinelRef}
                className="history-load-sentinel"
                role="status"
              >
                {loading && (
                  <LoaderCircle
                    size={16}
                    className="spin"
                    aria-label={t("working")}
                  />
                )}
                {pageError && (
                  <button
                    className="text-button"
                    onClick={() => setPageError(false)}
                  >
                    {t("retry")}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="panel-footer">
            <GitCommitHorizontal size={13} />
            <span>
              {commits.length} {t("commits")}
            </span>
            <span className="footer-spacer" />
            <span>{t(currentOnly ? "currentBranch" : "allBranches")}</span>
          </div>
        </section>
        {props.terminal}
      </div>
      <Splitter
        orientation="vertical"
        onResize={(delta) =>
          setInspectorWidth((width) =>
            Math.max(
              260,
              Math.min(
                (layoutRef.current?.clientWidth ?? 1000) * 0.65,
                width - delta,
              ),
            ),
          )
        }
      />
      <aside className="history-inspector" style={{ width: inspectorWidth }}>
        {selected ? (
          <section className="commit-details">
            <div className="detail-tabs">
              <button
                className={detailTab === "details" ? "active" : ""}
                onClick={() => {
                  setDetailTab("details");
                  setFile(null);
                }}
              >
                {t("details")}
              </button>
              <button
                className={detailTab === "files" ? "active" : ""}
                onClick={() => setDetailTab("files")}
              >
                {t("files")} <span>{detail?.files.length ?? 0}</span>
              </button>
            </div>
            {!selected ? (
              <Empty title={t("noCommits")} />
            ) : (
              <div className="details-body">
                <h2>{selected.message}</h2>
                <button
                  className="secondary-button"
                  disabled={props.busy}
                  onClick={() => openActions(selected)}
                >
                  {t("commitActions")}
                </button>
                <div className="hash-line">
                  <code>{selected.hash.slice(0, 7)}</code>
                  <button
                    className="icon-button"
                    title={t("copyHash")}
                    aria-label={t("copyHash")}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(selected.hash)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1600);
                        })
                        .catch((e) => notify(String(e), true));
                    }}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <dl className="commit-properties">
                  <dt>{t("author")}</dt>
                  <dd>
                    <Avatar
                      name={selected.author}
                      email={selected.email}
                      githubRepo={githubRepo}
                      hash={selected.hash}
                    />
                    {selected.author}
                  </dd>
                  {(
                    detail?.message.match(/^Co-authored-by:\s*.+$/gim) ?? []
                  ).map((line) => {
                    const match =
                      /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line);
                    return (
                      match && (
                        <dd key={match[2]} className="coauthor">
                          <Avatar name={match[1]} email={match[2]} />
                          {match[1]}
                        </dd>
                      )
                    );
                  })}
                  <dt>{t("committed")}</dt>
                  <dd
                    title={new Date(selected.timestamp).toLocaleString(locale)}
                  >
                    {relativeTime(selected.timestamp, locale, t)}
                  </dd>
                </dl>
                {detailError ? (
                  <p className="inline-error">{detailError}</p>
                ) : !detail ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <>
                    {detailTab === "details" && (
                      <>
                        <p className="commit-message">
                          {detail.message
                            .split("\n")
                            .slice(1)
                            .join("\n")
                            .trim() || selected.message}
                        </p>
                        <div className="detail-ref-list">
                          {selected.refs.map((ref) => (
                            <BranchBadge
                              key={ref}
                              name={ref}
                              remote={remoteNames.some((name) =>
                                ref.startsWith(`${name}/`),
                              )}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    <div className="section-label">
                      {t("filesChanged")}
                      <span className="count">{detail.files.length}</span>
                    </div>
                    <VirtualList
                      className="changed-files"
                      items={detail.files}
                      rowHeight={32}
                      render={(f) => (
                        <button
                          key={f.path}
                          className={file === f.path ? "active" : ""}
                          onClick={() => {
                            setFile(f.path);
                            setDetailTab("files");
                          }}
                        >
                          <FileText size={15} />
                          <span title={f.path}>{f.path}</span>
                          <b className="addition">+{f.added}</b>
                          <b className="deletion">−{f.deleted}</b>
                        </button>
                      )}
                    />
                    <div className="diff-stats">
                      <span className="addition">
                        +
                        {detail.files.reduce(
                          (sum, f) => sum + (Number(f.added) || 0),
                          0,
                        )}
                      </span>
                      <span className="deletion">
                        −
                        {detail.files.reduce(
                          (sum, f) => sum + (Number(f.deleted) || 0),
                          0,
                        )}
                      </span>
                      <span>
                        {detail.files.length} {t("files").toLowerCase()}
                      </span>
                    </div>
                  </>
                )}
                <div className="parents">
                  <span>{t("parents")}</span>
                  {selected.parents.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        const parent = commits.find((c) => c.hash === p);
                        if (parent) setSelected(parent);
                      }}
                      disabled={!commits.some((c) => c.hash === p)}
                    >
                      <code>{p.slice(0, 7)}</code>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="quick-commit">
            <Changes
              {...props}
              onPreview={(path, staged, untracked) =>
                setWorkingDiff({ path, staged, untracked })
              }
            />
          </section>
        )}
      </aside>
    </div>
  );
}

function Diff({
  repo,
  path,
  staged,
  hash,
  untracked = false,
  compact = false,
}: {
  repo: Repository;
  path: string;
  staged: boolean;
  hash?: string;
  untracked?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState<DiffSource | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setSource(null);
    setError("");
    gitService
      .openDiff(repo, path, staged, hash, untracked, controller.signal)
      .then((result) => {
        if (!cancelled) setSource(result);
        else result.close();
      })
      .catch((e) => {
        if (!cancelled && !isReadCancelled(e)) setError(errorText(e, t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [repo, path, staged, hash, untracked, t]);
  if (loading)
    return (
      <div className="diff-loading">
        <LoaderCircle className="spin" size={20} />
      </div>
    );
  if (error) return <p className="inline-error">{error}</p>;
  if (!source?.totalLines)
    return <Empty icon={<FileCode2 />} title={t("noDiff")} />;
  return <VirtualDiff key={source.id} source={source} compact={compact} />;
}

function Changes({
  repo,
  data,
  busy,
  onAction,
  onExpandUntracked,
  onConfirm,
  notify,
  onPreview,
}: RepoViewProps & {
  onPreview?: (path: string, staged: boolean, untracked: boolean) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<{
    file: FileChange;
    staged: boolean;
  } | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [amend, setAmend] = useState(false);
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const head =
    data.branches.find((b) => b.current)?.hash ??
    data.commits.find((c) => c.refs.includes("HEAD"))?.hash;
  useEffect(() => {
    if (!amend || !head) return;
    const controller = new AbortController();
    void gitService
      .detail(repo, head, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        const [title, ...body] = detail.message.split("\n");
        setSummary(title);
        setDescription(body.join("\n").trim());
      })
      .catch((error) => {
        if (!controller.signal.aborted) notify(errorText(error, t), true);
      });
    return () => controller.abort();
  }, [amend, head, repo, notify, t]);
  const conflicts = data.files.filter(conflicted);
  const staged = data.files.filter(
    (f) => !conflicted(f) && f.index !== " " && f.index !== "?",
  );
  const unstaged = data.files.filter(
    (f) => !conflicted(f) && (f.worktree !== " " || f.index === "?"),
  );
  useEffect(() => {
    setSelected(null);
  }, [data.files]);
  function fileGroup(files: FileChange[], isStaged: boolean) {
    return (
      <section className="file-group">
        <header>
          <h3>
            <ChevronDown size={13} />
            {t(isStaged ? "staged" : "workingTree")}
            <span className="count">{files.length}</span>
          </h3>
          <button
            className="text-button"
            disabled={busy || !files.length}
            onClick={() =>
              void onAction({
                kind: isStaged ? "unstage" : "stage",
                paths: files.flatMap((f) => [
                  f.path,
                  ...(f.originalPath ? [f.originalPath] : []),
                ]),
              })
            }
          >
            {t(isStaged ? "unstageAll" : "stageAll")}
          </button>
        </header>
        <VirtualList
          items={files}
          rowHeight={44}
          render={(f) => (
            <div
              key={f.path}
              className={`file-row ${selected?.file.path === f.path && selected.staged === isStaged ? "selected" : ""}`}
            >
              <button
                onClick={() => {
                  if (f.index === "?" && f.path.endsWith("/")) {
                    void onExpandUntracked();
                    return;
                  }
                  setSelected({ file: f, staged: isStaged });
                  onPreview?.(f.path, isStaged, f.index === "?");
                }}
              >
                <span className={`file-status ${f.index === "?" ? "new" : ""}`}>
                  {f.index === "?" ? "U" : isStaged ? f.index : f.worktree}
                </span>
                <FileText size={14} />
                <span>{f.path}</span>
              </button>
              {!isStaged && (
                <button
                  className="icon-button danger-hover"
                  disabled={busy}
                  title={t("discard")}
                  aria-label={`${t("discard")} ${f.path}`}
                  onClick={() =>
                    onConfirm("discardWarning", {
                      kind: "discard",
                      paths: [f.path],
                      extra: f.index === "?" ? "untracked" : undefined,
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              )}
              <button
                className="icon-button"
                disabled={busy}
                title={t(isStaged ? "unstage" : "stage")}
                aria-label={`${t(isStaged ? "unstage" : "stage")} ${f.path}`}
                onClick={() =>
                  void onAction({
                    kind: isStaged ? "unstage" : "stage",
                    paths: [
                      f.path,
                      ...(f.originalPath ? [f.originalPath] : []),
                    ],
                  })
                }
              >
                {isStaged ? <Minus size={15} /> : <Plus size={15} />}
              </button>
            </div>
          )}
        />
      </section>
    );
  }
  return (
    <div className="changes-layout">
      <div className="staging-panel">
        {!onPreview && (
          <OperationStatus
            data={data}
            busy={busy}
            onAction={onAction}
            onConfirm={onConfirm}
          />
        )}
        <div className="staging-files">
          {!!conflicts.length && (
            <section className="conflict-panel">
              <h3>{t("conflicts")}</h3>
              {conflicts.map((f) => (
                <div key={f.path}>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelected({ file: f, staged: false });
                      if (!onPreview) setConflictPath(f.path);
                      onPreview?.(f.path, false, false);
                    }}
                  >
                    {f.path}
                  </button>
                  <div className="conflict-choices">
                    <button
                      disabled={busy || !!repo.demo}
                      onClick={() => {
                        if (onPreview) onPreview(f.path, false, false);
                        else setConflictPath(f.path);
                      }}
                    >
                      {t("editConflict")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void onAction({ kind: "stage", paths: [f.path] })
                      }
                    >
                      {t("stage")}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
          {!data.files.length ? (
            <Empty
              icon={<Check size={26} />}
              title={t("clean")}
              description={t("cleanDescription")}
            />
          ) : (
            <>
              {data.files.some(
                (f) => f.index === "?" && f.path.endsWith("/"),
              ) && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void onExpandUntracked()}
                >
                  {t("expandUntracked")}
                </button>
              )}
              {fileGroup(unstaged, false)}
              {fileGroup(staged, true)}
            </>
          )}
        </div>
        <form
          className="commit-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (
              busy ||
              conflicts.length ||
              !summary.trim() ||
              (!staged.length && !allowEmpty && !amend)
            )
              return;
            const action: Action = {
              kind: amend ? "amend" : "commit",
              allowEmpty,
              value:
                summary.trim() +
                (description.trim() ? `\n\n${description.trim()}` : ""),
            };
            if (amend) {
              setAmend(false);
              onConfirm("amendWarning", action);
              return;
            }
            void onAction(action).then((ok) => {
              if (ok) {
                setSummary("");
                setDescription("");
              }
            });
          }}
        >
          <div className="commit-on-branch">
            <GitBranch size={14} />
            <span>{data.branch}</span>
          </div>
          <input
            aria-label={t("commitSummary")}
            placeholder={t("commitSummary")}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            required
          />
          <textarea
            aria-label={t("commitDescription")}
            placeholder={t("commitDescription")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          <label className="empty-commit-option">
            <input
              type="checkbox"
              checked={amend}
              disabled={!!data.operation || !head}
              onChange={(e) => setAmend(e.target.checked)}
            />
            {t("amend")}
          </label>
          <label className="empty-commit-option">
            <input
              type="checkbox"
              checked={allowEmpty}
              onChange={(e) => setAllowEmpty(e.target.checked)}
            />
            {t("allowEmpty")}
          </label>
          <button
            className="primary-button"
            disabled={
              busy ||
              (!staged.length && !allowEmpty && !amend) ||
              !summary.trim() ||
              !!conflicts.length
            }
          >
            <GitCommitHorizontal size={16} />
            {t(amend ? "amend" : "commit")}
            <span className="count">{staged.length}</span>
          </button>
          <p>{t("commitHint")}</p>
        </form>
      </div>
      <section className="file-diff-panel" hidden={Boolean(onPreview)}>
        {conflictPath && !onPreview ? (
          <ConflictEditor
            key={conflictPath}
            repo={repo}
            path={conflictPath}
            busy={busy}
            onAction={onAction}
            onClose={() => setConflictPath(null)}
          />
        ) : selected && !onPreview ? (
          <>
            <header>
              <FileCode2 size={16} />
              <strong>{selected.file.path}</strong>
              <span className="subtle">
                {t(selected.staged ? "staged" : "workingTree")}
              </span>
            </header>
            <Diff
              key={`${selected.file.path}:${selected.staged}`}
              repo={repo}
              path={selected.file.path}
              staged={selected.staged}
              untracked={selected.file.index === "?"}
            />
          </>
        ) : (
          <Empty icon={<FileCode2 size={32} />} title={t("selectFile")} />
        )}
      </section>
    </div>
  );
}

function RepositoryLists({
  data,
  tab,
  busy,
  onAction,
  onPrompt,
  onConfirm,
}: RepoViewProps) {
  const { t } = useI18n();
  const [renameBranch, setRenameBranch] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  return (
    <div className="repository-list-page">
      {renameBranch && (
        <Modal
          title={t("renameBranch")}
          onClose={() => {
            if (!busy) setRenameBranch(null);
          }}
        >
          <form
            className="modal-content git-operation-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void onAction({
                kind: "renameBranch",
                value: renameBranch,
                extra: branchName.trim(),
              }).then((ok) => {
                if (ok) setRenameBranch(null);
              });
            }}
          >
            <input
              required
              autoFocus
              aria-label={t("branch")}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
            />
            <button
              className="primary-button"
              disabled={busy || !branchName.trim()}
            >
              {t("confirm")}
            </button>
          </form>
        </Modal>
      )}
      <div className="page-title-row">
        <div>
          <span className="eyebrow">{t("repository")}</span>
          <h1>{t(tab)}</h1>
        </div>
        <button
          className="primary-button"
          onClick={() => onPrompt(tab === "branches" ? "branch" : "remote")}
        >
          <Plus size={15} />
          {t(tab === "branches" ? "newBranch" : "addRemote")}
        </button>
      </div>
      {tab === "branches" ? (
        [false, true].map((remote) => (
          <section key={String(remote)} className="list-section">
            <h3 className="section-label">
              {t(remote ? "remoteBranches" : "localBranches")}
              <span className="count">
                {data.branches.filter((b) => b.remote === remote).length}
              </span>
            </h3>
            <div className="surface-list">
              <VirtualList
                items={data.branches.filter((b) => b.remote === remote)}
                rowHeight={84}
                render={(b) => (
                  <div key={b.name} className="branch-list-row">
                    <span className={`list-icon ${b.current ? "accent" : ""}`}>
                      <GitBranch size={19} />
                    </span>
                    <div className="list-row-main">
                      <strong>
                        {b.name}
                        {b.current && (
                          <span className="branch-badge">{t("current")}</span>
                        )}
                      </strong>
                      <span>{b.upstream || b.hash.slice(0, 7)}</span>
                    </div>
                    {!remote && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setRenameBranch(b.name);
                          setBranchName(b.name);
                        }}
                      >
                        {t("renameBranch")}
                      </button>
                    )}
                    {remote && (
                      <button
                        className="secondary-button"
                        disabled={busy}
                        onClick={() =>
                          void onAction({ kind: "trackBranch", value: b.name })
                        }
                      >
                        {t("trackBranch")}
                      </button>
                    )}
                    {!remote && !b.current && (
                      <div className="row-actions">
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() =>
                            void onAction({
                              kind: "switchBranch",
                              value: b.name,
                            })
                          }
                        >
                          {t("switchBranch")}
                        </button>
                        <button
                          className="icon-button"
                          disabled={busy}
                          title={t("merge")}
                          aria-label={`${t("merge")} ${b.name}`}
                          onClick={() =>
                            onConfirm("mergeWarning", {
                              kind: "merge",
                              value: b.name,
                            })
                          }
                        >
                          <GitMerge size={16} />
                        </button>
                        <button
                          className="icon-button danger-hover"
                          disabled={busy}
                          title={t("deleteBranch")}
                          aria-label={`${t("deleteBranch")} ${b.name}`}
                          onClick={() =>
                            onConfirm("deleteBranchWarning", {
                              kind: "deleteBranch",
                              value: b.name,
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              />
              {!data.branches.some((b) => b.remote === remote) && (
                <div className="list-empty">{t("noBranches")}</div>
              )}
            </div>
          </section>
        ))
      ) : (
        <div className="surface-list">
          {data.remotes.length ? (
            <VirtualList
              items={data.remotes}
              rowHeight={84}
              render={(r) => (
                <div className="remote-list-row" key={r.name}>
                  <span className="list-icon accent">
                    <Globe2 size={21} />
                  </span>
                  <div className="list-row-main">
                    <strong>{r.name}</strong>
                    <code>{r.url}</code>
                  </div>
                  <button
                    className="icon-button danger-hover"
                    aria-label={`${t("remove")} ${r.name}`}
                    disabled={busy}
                    onClick={() =>
                      onConfirm("removeRemoteWarning", {
                        kind: "removeRemote",
                        value: r.name,
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            />
          ) : (
            <Empty
              icon={<Globe2 size={28} />}
              title={t("noRemotes")}
              description={t("noRemotesDescription")}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function RepoActions({
  busy,
  onAction,
  onRefresh,
  onConfirm,
}: {
  busy: boolean;
  onAction: (action: Action) => Promise<boolean>;
  onRefresh: () => void;
  onConfirm: (message: MessageKey, action: Action) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="repo-actions">
      <button
        className="icon-button"
        disabled={busy}
        title={t("refresh")}
        aria-label={t("refresh")}
        onClick={onRefresh}
      >
        <RefreshCw size={15} className={busy ? "spin" : ""} />
      </button>
      <span className="toolbar-divider" />
      <button disabled={busy} onClick={() => void onAction({ kind: "fetch" })}>
        <RefreshCw size={14} />
        {t("fetch")}
      </button>
      <button disabled={busy} onClick={() => void onAction({ kind: "pull" })}>
        <ArrowDown size={15} />
        {t("pull")}
      </button>
      <button disabled={busy} onClick={() => void onAction({ kind: "push" })}>
        <ArrowUp size={15} />
        {t("push")}
      </button>
      <button
        disabled={busy}
        onClick={() => onConfirm("forcePushWarning", { kind: "forcePush" })}
      >
        {t("forcePush")}
      </button>
    </div>
  );
}

function BranchSwitcher({ data, busy, onAction }: RepoViewProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const branches = data.branches.filter(
    (b) => !b.remote && b.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className="branch-switcher"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        className="branch-selector"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
      >
        <GitBranch size={14} />
        {data.branch}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="branch-menu">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchBranches")}
            aria-label={t("searchBranches")}
          />
          <div>
            <VirtualList
              items={branches}
              maxHeight="240px"
              rowHeight={36}
              render={(b) => (
                <button
                  key={b.name}
                  disabled={busy || b.current}
                  onClick={() => {
                    void onAction({ kind: "switchBranch", value: b.name }).then(
                      (ok) => {
                        if (ok) setOpen(false);
                      },
                    );
                  }}
                >
                  <GitBranch size={14} />
                  <span>{b.name}</span>
                  {b.current && <Check size={14} />}
                </button>
              )}
            />
            {!branches.length && <p>{t("noResults")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
