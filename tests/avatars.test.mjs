import test from "node:test";
import assert from "node:assert/strict";
import {
  githubRepository,
  githubIdentity,
  freshAvatar,
  createAvatarResolver,
} from "../src/lib/avatars.ts";
const hash = "a".repeat(40);
const tick = () => new Promise((done) => setTimeout(done, 0));
function memoryStorage() {
  const items = new Map();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  };
}
const response = () =>
  new Response(
    JSON.stringify({
      author: { avatar_url: "https://avatars.githubusercontent.com/u/123?v=4" },
    }),
  );
const page = (authors) =>
  new Response(
    JSON.stringify(
      authors.map(([email, id]) => ({
        sha: hash,
        commit: { author: { email } },
        author: id
          ? { avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4` }
          : null,
      })),
    ),
  );
const commits = (...emails) =>
  emails.map((email, index) => ({
    email,
    hash: String(index).padStart(40, "0"),
  }));
test("GitHub remotes and noreply identities resolve without guessing display names", () => {
  for (const remote of [
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ])
    assert.equal(githubRepository(remote), "owner/repo");
  assert.equal(
    githubRepository("https://github.com.evil.test/owner/repo"),
    null,
  );
  assert.equal(
    githubIdentity("123+twilightfox@users.noreply.github.com"),
    "https://avatars.githubusercontent.com/u/123",
  );
  assert.equal(
    githubIdentity("alice@users.noreply.github.com"),
    "https://github.com/alice.png",
  );
  assert.equal(githubIdentity("alice@example.com"), null);
});
test("avatar URLs refresh every fifteen minutes without bypassing the cache per render", () => {
  assert.equal(
    freshAvatar("https://avatars.githubusercontent.com/u/1?v=4", 1000),
    freshAvatar("https://avatars.githubusercontent.com/u/1?v=4", 2000),
  );
  assert.notEqual(
    freshAvatar("https://avatars.githubusercontent.com/u/1", 1000),
    freshAvatar("https://avatars.githubusercontent.com/u/1", 900001),
  );
});
test("one author shares one request across rows and commit details", async () => {
  let calls = 0;
  const { resolve } = createAvatarResolver(async () => {
    calls++;
    return response();
  });
  const values = await Promise.all(
    Array.from({ length: 30 }, () =>
      resolve("alice@example.com", "owner/repo", hash),
    ),
  );
  assert.equal(calls, 1);
  assert.ok(
    values.every((value) =>
      value.includes("avatars.githubusercontent.com/u/123"),
    ),
  );
  await resolve("123+alice@users.noreply.github.com", "owner/repo", hash);
  assert.equal(calls, 1);
});
test("avatar requests have bounded concurrency", async () => {
  let active = 0,
    peak = 0;
  const { resolve } = createAvatarResolver(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((done) => setTimeout(done, 5));
    active--;
    return response();
  });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      resolve(`${i}@example.com`, "owner/repo", hash),
    ),
  );
  assert.equal(peak, 2);
});
test("API rate limits stop subsequent requests and failures allow local fallbacks", async () => {
  let calls = 0;
  const { resolve } = createAvatarResolver(async () => {
    calls++;
    return new Response("", { status: 403 });
  });
  assert.equal(await resolve("one@example.com", "owner/repo", hash), null);
  assert.equal(await resolve("two@example.com", "owner/repo", hash), null);
  assert.equal(calls, 1);
  assert.equal(await resolve("three@example.com", null, hash), null);
});
test("untrusted avatar hosts and malformed commit hashes are ignored", async () => {
  let calls = 0;
  const { resolve } = createAvatarResolver(async () => {
    calls++;
    return new Response(
      JSON.stringify({ author: { avatar_url: "https://evil.test/avatar" } }),
    );
  });
  assert.equal(
    await resolve("alice@example.com", "owner/repo", "invalid"),
    null,
  );
  assert.equal(calls, 0);
  assert.equal(await resolve("alice@example.com", "owner/repo", hash), null);
});
test("a rate-limited API uses verified page metadata instead of the old email avatar", async () => {
  let apiCalls = 0;
  let pageCalls = 0;
  const { resolve } = createAvatarResolver(
    async () => {
      apiCalls++;
      return new Response("", { status: 403 });
    },
    async () => {
      pageCalls++;
      return "https://avatars.githubusercontent.com/u/123?v=4";
    },
  );
  assert.match(
    await resolve("alice@example.com", "owner/repo", hash),
    /avatars\.githubusercontent\.com\/u\/123/,
  );
  assert.match(
    await resolve("bob@example.com", "owner/repo", hash),
    /avatars\.githubusercontent\.com\/u\/123/,
  );
  assert.equal(apiCalls, 1);
  assert.equal(pageCalls, 2);
});
test("verified authors are reused across repositories, restarts and unpushed local commits", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return response();
  };
  const first = createAvatarResolver(fetcher, undefined, storage);
  await first.resolve("alice@example.com", "owner/first", hash);
  await first.resolve("alice@example.com", "owner/second", hash);
  await tick();
  const restarted = createAvatarResolver(fetcher, undefined, storage);
  assert.match(
    await restarted.resolve(" Alice@Example.com ", null, "unpushed"),
    /avatars\.githubusercontent\.com\/u\/123/,
  );
  assert.equal(calls, 1);
});
test("one bulk page answers every visible author and is stored once per account", async () => {
  const storage = memoryStorage();
  let bulk = 0,
    single = 0;
  const { resolve, warm } = createAvatarResolver(
    async (url) => {
      if (String(url).includes("per_page=100")) {
        bulk++;
        return page([
          ["alice@work.example", 7],
          ["alice@home.example", 7],
          ["bob@example.com", 8],
          ["carol@example.com", 9],
          ["dave@example.com", null],
        ]);
      }
      single++;
      return response();
    },
    undefined,
    storage,
  );
  const history = commits(
    "alice@work.example",
    "alice@home.example",
    "bob@example.com",
    "carol@example.com",
    "dave@example.com",
  );
  await warm("owner/repo", history);
  const resolved = await Promise.all(
    history.map((commit) => resolve(commit.email, "owner/repo", commit.hash)),
  );
  assert.equal(bulk, 1);
  assert.equal(single, 0);
  assert.match(resolved[0], /u\/7/);
  assert.match(resolved[1], /u\/7/);
  assert.match(resolved[2], /u\/8/);
  assert.equal(resolved[4], null);
  await tick();
  const stored = JSON.parse(storage.getItem("repoweft.avatar.identities.v4"));
  assert.equal(Object.keys(stored.emails).length, 4);
  assert.equal(Object.keys(stored.urls).length, 3);
});
test("one or two unknown authors keep the cheaper per-commit lookup", async () => {
  let bulk = 0,
    single = 0;
  const { resolve, warm } = createAvatarResolver(async (url) => {
    if (String(url).includes("per_page=100")) bulk++;
    else single++;
    return response();
  });
  const history = commits("alice@example.com", "bob@example.com");
  await warm("owner/repo", history);
  await Promise.all(
    history.map((commit) => resolve(commit.email, "owner/repo", commit.hash)),
  );
  assert.equal(bulk, 0);
  assert.equal(single, 2);
});
test("a rate-limited bulk page falls back without spending per-commit requests", async () => {
  let bulk = 0,
    single = 0,
    fallbacks = 0;
  const storage = memoryStorage();
  const { warm } = createAvatarResolver(
    async (url) => {
      if (String(url).includes("per_page=100")) {
        bulk++;
        return new Response("", {
          status: 429,
          headers: { "retry-after": "3600" },
        });
      }
      single++;
      return response();
    },
    async () => {
      fallbacks++;
      return null;
    },
    storage,
  );
  await warm("owner/repo", commits("a@x.com", "b@x.com", "c@x.com"));
  assert.equal(bulk, 1);
  assert.equal(single, 0);
  assert.ok(
    Number(storage.getItem("repoweft.avatar.rateLimitUntil")) >
      Date.now() + 3_000_000,
  );
  assert.equal(fallbacks, 0);
});
test("older per-repository avatar mappings migrate to new repositories without network requests", async () => {
  const storage = memoryStorage();
  storage.setItem(
    "repoweft.avatar.v2.owner/old:alice@example.com",
    JSON.stringify({
      url: "https://avatars.githubusercontent.com/u/123?v=4",
      expires: Date.now() + 10000,
    }),
  );
  const { resolve } = createAvatarResolver(
    async () => {
      throw new Error("Must not request");
    },
    undefined,
    storage,
  );
  assert.match(
    await resolve("alice@example.com", "owner/new", hash),
    /avatars\.githubusercontent\.com\/u\/123/,
  );
});
test("failed lookups in one repository do not suppress another repository's author lookup", async () => {
  let calls = 0;
  const { resolve } = createAvatarResolver(async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 404 }) : response();
  });
  assert.equal(
    await resolve("alice@example.com", "owner/unpushed", hash),
    null,
  );
  assert.match(
    await resolve("alice@example.com", "owner/published", hash),
    /avatars\.githubusercontent\.com\/u\/123/,
  );
  assert.equal(calls, 2);
});
test("rate-limit cooldown survives restarts and honours Retry-After", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("", {
      status: 429,
      headers: { "retry-after": "3600" },
    });
  };
  await createAvatarResolver(fetcher, undefined, storage).resolve(
    "alice@example.com",
    "owner/one",
    hash,
  );
  assert.ok(
    Number(storage.getItem("repoweft.avatar.rateLimitUntil")) >=
      Date.now() + 3590_000,
  );
  await createAvatarResolver(fetcher, undefined, storage).resolve(
    "bob@example.com",
    "owner/two",
    hash,
  );
  assert.equal(calls, 1);
});
