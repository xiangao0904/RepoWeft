import { invoke } from "@tauri-apps/api/core";

const AVATAR_HOST = "avatars.githubusercontent.com";
const IDENTITIES = "repoweft.avatar.identities.v4";
const LEGACY_IDENTITIES = "repoweft.avatar.identities.v3";
const RATE_LIMIT = "repoweft.avatar.rateLimitUntil";
const LIMIT = 256;
// Below this many unknown authors, one bulk page costs more requests than it saves.
const BULK_THRESHOLD = 3;
const TTL = 900_000;

// GitHub identities are resolved from verified commit metadata, never display-name guesses.
export function githubRepository(remote: string): string | null {
  const match = remote.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)\/?$/i,
  );
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : null;
}
export function githubIdentity(email: string): string | null {
  const match = email
    .trim()
    .match(
      /^(?:(\d+)\+)?([a-z\d](?:[a-z\d-]*[a-z\d])?)@users\.noreply\.github\.com$/i,
    );
  if (!match) return null;
  return match[1]
    ? `https://avatars.githubusercontent.com/u/${match[1]}`
    : `https://github.com/${match[2]}.png`;
}
export function freshAvatar(url: string, now = Date.now()): string {
  const result = new URL(url);
  result.searchParams.set("s", "48");
  result.searchParams.set("repoweft", `v2-${Math.floor(now / 900_000)}`);
  return result.toString();
}
type AvatarStorage = Pick<Storage, "getItem" | "setItem" | "key" | "length">;
function browserStorage(): AvatarStorage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
function trustedAvatar(url: unknown): url is string {
  try {
    return (
      typeof url === "string" &&
      new URL(url).protocol === "https:" &&
      new URL(url).hostname === AVATAR_HOST
    );
  } catch {
    return false;
  }
}
// The numeric account id inside an avatar URL survives avatar and username changes.
function avatarIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname === AVATAR_HOST) {
      const match = parsed.pathname.match(/^\/u\/(\d+)\/?$/);
      return match ? `u/${match[1]}` : null;
    }
    if (parsed.hostname === "github.com") {
      const match = parsed.pathname.match(/^\/([^/]+)\.png$/);
      return match ? `login/${match[1].toLowerCase()}` : null;
    }
    return null;
  } catch {
    return null;
  }
}
// A slow bulk page must not hold the fallback path hostage.
const WARM_WAIT = 1200;
function settled(promise: Promise<void>): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, WARM_WAIT);
    void promise.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}
export function createAvatarResolver(
  fetcher: typeof fetch = fetch,
  fallback?: (repository: string, hash: string) => Promise<string | null>,
  storage: AvatarStorage | undefined = browserStorage(),
) {
  const cache = new Map<
    string,
    { expires: number; value: Promise<string | null> }
  >();
  const urls = new Map<string, string>();
  const emails = new Map<string, string>();
  const unresolved = new Set<string>();
  let scheduled = false;
  function persist() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        storage?.setItem(
          IDENTITIES,
          JSON.stringify({
            emails: Object.fromEntries(emails),
            urls: Object.fromEntries(urls),
          }),
        );
      } catch {
        /* Storage is optional. */
      }
    }, 0);
  }
  function remember(email: string, url: string) {
    if (!email || !trustedAvatar(url)) return;
    const identity = avatarIdentity(url) ?? `email/${email}`;
    urls.delete(identity);
    if (urls.size >= LIMIT) urls.delete(urls.keys().next().value!);
    urls.set(identity, url);
    emails.delete(email);
    if (emails.size >= LIMIT) emails.delete(emails.keys().next().value!);
    emails.set(email, identity);
    persist();
  }
  function known(email: string): string | null {
    const identity = emails.get(email);
    return (identity && urls.get(identity)) || null;
  }
  let restored = false;
  try {
    const saved = JSON.parse(storage?.getItem(IDENTITIES) || "null");
    if (saved?.emails && saved?.urls) {
      for (const [identity, url] of Object.entries(saved.urls))
        if (identity && trustedAvatar(url)) urls.set(identity, url);
      for (const [email, identity] of Object.entries(saved.emails))
        if (email && typeof identity === "string" && urls.has(identity))
          emails.set(email, identity);
      restored = true;
    }
  } catch {
    /* Storage is optional. */
  }
  if (!restored)
    try {
      // Reuse successful matches from earlier versions, including other repositories.
      const saved = JSON.parse(storage?.getItem(LEGACY_IDENTITIES) || "{}");
      for (const [email, url] of Object.entries(saved))
        if (email && trustedAvatar(url)) remember(email, url);
      for (let index = 0; index < (storage?.length ?? 0); index++) {
        const key = storage?.key(index);
        if (!key?.startsWith("repoweft.avatar.v2.")) continue;
        const saved = JSON.parse(storage?.getItem(key) || "null");
        const email = key
          .slice(key.indexOf(":") + 1)
          .trim()
          .toLowerCase();
        if (email.includes("@") && trustedAvatar(saved?.url))
          remember(email, saved.url);
      }
    } catch {
      /* Storage is optional. */
    }
  let active = 0;
  const waiting: (() => void)[] = [];
  let blockedUntil = 0;
  try {
    blockedUntil = Number(storage?.getItem(RATE_LIMIT)) || 0;
  } catch {
    /* Storage is optional. */
  }
  function rateLimited(response: { headers: Headers }) {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    const retry = response.headers.get("retry-after");
    const retryAt = retry
      ? /^\d+$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry)
      : 0;
    blockedUntil = Math.max(Date.now() + 60_000, reset || 0, retryAt || 0);
    try {
      storage?.setItem(RATE_LIMIT, String(blockedUntil));
    } catch {
      /* Storage is optional. */
    }
  }
  const warming = new Map<string, Promise<void>>();
  const warmed = new Map<string, number>();
  async function warm(
    repository: string | null,
    commits: { email: string; hash: string }[],
  ): Promise<void> {
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return;
    const running = warming.get(repository);
    if (running) return running;
    if (Date.now() < blockedUntil) return;
    const until = warmed.get(repository);
    if (until && until > Date.now()) return;
    const missing = new Set<string>();
    for (const commit of commits) {
      const email = commit.email.trim().toLowerCase();
      if (
        !email ||
        githubIdentity(email) ||
        known(email) ||
        unresolved.has(email)
      )
        continue;
      missing.add(email);
    }
    if (missing.size < BULK_THRESHOLD) return;
    const task = (async () => {
      try {
        const response = await fetcher(
          `https://api.github.com/repos/${repository}/commits?per_page=100`,
          {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/vnd.github+json" },
          },
        );
        if (response.status === 403 || response.status === 429) {
          rateLimited(response);
          return;
        }
        if (!response.ok) return;
        const page = await response.json();
        if (!Array.isArray(page)) return;
        // One page carries both the commit sha and the verified account behind it.
        for (const item of page) {
          const email = String(item?.commit?.author?.email ?? "")
            .trim()
            .toLowerCase();
          const url = item?.author?.avatar_url;
          if (!trustedAvatar(url)) {
            if (email && !item?.author) unresolved.add(email);
            continue;
          }
          if (!email) continue;
          remember(email, url);
          const key = `${repository}:${email}`;
          if (!cache.has(key))
            cache.set(key, {
              expires: Date.now() + TTL,
              value: Promise.resolve(freshAvatar(url)),
            });
        }
        if (unresolved.size > LIMIT) unresolved.clear();
        warmed.set(repository, Date.now() + TTL);
      } catch {
        /* Offline or blocked; per-commit lookups still resolve the visible rows. */
      }
    })();
    warming.set(repository, task);
    void task.then(() => {
      if (warming.get(repository) === task) warming.delete(repository);
    });
    return task;
  }
  async function resolve(
    email: string,
    repository: string | null,
    hash: string,
  ): Promise<string | null> {
    const normalized = email.trim().toLowerCase();
    const direct = githubIdentity(email);
    if (direct) return freshAvatar(direct);
    // Let a bulk page settle first: it usually answers every visible row at once.
    const running = repository ? warming.get(repository) : undefined;
    if (running) await settled(running);
    const cached = known(normalized);
    if (cached) return freshAvatar(cached);
    if (unresolved.has(normalized)) return null;
    if (
      !repository ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !/^[a-f\d]{40,64}$/i.test(hash)
    )
      return null;
    const key = `${repository}:${normalized || hash}`;
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return old.value;
    if (waiting.length >= 32) return null;
    const value = (async () => {
      if (active >= 2) await new Promise<void>((done) => waiting.push(done));
      else active++;
      try {
        if (Date.now() < blockedUntil)
          return fallback ? await fallback(repository, hash) : null;
        const response = await fetcher(
          `https://api.github.com/repos/${repository}/commits/${hash}`,
          {
            signal: AbortSignal.timeout(5000),
            headers: { Accept: "application/vnd.github+json" },
          },
        );
        if (response.status === 403 || response.status === 429)
          rateLimited(response);
        if (!response.ok)
          return fallback ? await fallback(repository, hash) : null;
        const data = await response.json();
        const url = data.author?.avatar_url;
        if (!trustedAvatar(url)) {
          if (data?.author === null) {
            if (unresolved.size > LIMIT) unresolved.clear();
            unresolved.add(normalized);
          }
          return null;
        }
        return freshAvatar(url);
      } catch {
        return fallback
          ? await fallback(repository, hash).catch(() => null)
          : null;
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    })().then((url) => {
      if (!url) {
        const entry = cache.get(key);
        if (entry) entry.expires = Date.now() + 60_000;
      }
      if (url) remember(normalized, url);
      return url ? freshAvatar(url) : null;
    });
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + TTL, value });
    return value;
  }
  return { resolve, warm };
}
const github = createAvatarResolver(fetch, async (repository, hash) => {
  if (!("__TAURI_INTERNALS__" in globalThis)) return null;
  return invoke<string | null>("github_commit_avatar", { repository, hash });
});
export const resolveGithubAvatar = github.resolve;
export function warmGithubAvatars(
  remotes: string[],
  commits: { email: string; hash: string }[],
): void {
  const repository =
    remotes.map((remote) => githubRepository(remote)).find(Boolean) ?? null;
  if (repository) void github.warm(repository, commits);
}
const gravatars = new Map<string, Promise<string>>();
export function gravatar(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  let pending = gravatars.get(normalized);
  if (!pending) {
    pending = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(normalized))
      .then(
        (hash) =>
          `https://www.gravatar.com/avatar/${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}?s=48&d=404`,
      );
    if (gravatars.size >= 256) gravatars.delete(gravatars.keys().next().value!);
    gravatars.set(normalized, pending);
  }
  return pending;
}
