"use strict";

// Runs background.js in a VM against a mock of the browser.* APIs it uses.
// Run with `node --test`. The cache cleanup test waits for the real 10 s
// prune delay.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

// Tab IDs only grow, across mocks too, like the browser's.
let nextId = 1;

function makeBrowser(tabs = [], store = {}, session = {}) {
  const listeners = { created: [], removed: [], message: [], installed: [] };
  const event = (kind) => ({ addListener: (f) => listeners[kind].push(f) });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const snap = (t) => {
    const { values, ...rest } = t;
    return { ...rest, index: tabs.filter((x) => x.windowId === t.windowId).indexOf(t) };
  };
  const find = (id) => {
    const t = tabs.find((t) => t.id === id);
    if (!t) throw new Error("Invalid tab ID");
    return t;
  };
  const b = {
    storage: {
      local: {
        get: async (d) =>
          typeof d === "string" ? (d in store ? { [d]: store[d] } : {}) : { ...d, ...store },
        set: async (o) => Object.assign(store, clone(o)),
      },
      session: {
        get: async (k) => (k == null ? clone(session) : k in session ? { [k]: session[k] } : {}),
        set: async (o) => Object.assign(session, clone(o)),
        remove: async (k) => {
          for (const x of [].concat(k)) delete session[x];
        },
      },
    },
    permissions: { contains: async () => true },
    sessions: {
      getTabValue: async (id, k) => {
        b._reads++;
        return find(id).values[k];
      },
      setTabValue: async (id, k, v) => {
        find(id).values[k] = v;
      },
    },
    windows: { update: async () => {} },
    runtime: { onMessage: event("message"), onInstalled: event("installed"), openOptionsPage() {} },
    tabs: {
      onCreated: event("created"),
      onRemoved: event("removed"),
      query: async (q) =>
        tabs.filter((t) => q.windowId == null || t.windowId === q.windowId).map(snap),
      get: async (id) => snap(find(id)),
      update: async (id, p) => {
        if (p.active) tabs.forEach((t) => (t.active = t.id === id));
      },
      remove: async (id) => {
        const t = find(id);
        tabs.splice(tabs.indexOf(t), 1);
        // Firefox drops openerTabId when the opener closes.
        for (const x of tabs) if (x.openerTabId === id) x.openerTabId = undefined;
        listeners.removed.forEach((f) => f(id, { windowId: t.windowId }));
      },
    },
  };
  b._create = (p) => {
    const t = {
      id: nextId++,
      windowId: 1,
      url: "about:blank",
      cookieStoreId: "firefox-default",
      active: false,
      values: {},
      ...p,
    };
    delete t.index;
    tabs.splice(p.index ?? tabs.length, 0, t);
    listeners.created.forEach((f) => f(snap(t)));
    return t;
  };
  b._send = async (tabId, msg, frameId = 0) =>
    (
      await Promise.all(
        listeners.message.map((f) => f({ historyLength: 1, ...msg }, { tab: { id: tabId }, frameId }))
      )
    )[0];
  // onRemoved for a tab that's already gone from the tab list.
  b._fireRemoved = (id, windowId) => listeners.removed.forEach((f) => f(id, { windowId }));
  b._tabs = tabs;
  b._store = store;
  b._session = session;
  b._reads = 0;
  return b;
}

// Runs a fresh copy of background.js, as on install, browser restart,
// extension reload or the event page waking up.
function load(b) {
  const ctx = vm.createContext({
    browser: b,
    console,
    Date,
    Map,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => crypto.randomUUID() },
  });
  vm.runInContext(src, ctx);
  b._eval = (e) => vm.runInContext(e, ctx);
  return b;
}

// load(), then let startup finish.
async function start(b) {
  load(b);
  await tick();
  return b;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// The query response doesn't say which tab the parent is, so ask getParent().
async function parentId(b, tabId) {
  return (await b._eval(`getParent(${tabId})`))?.id ?? null;
}

test("parents across container reopens, restarts and event page wakes", async (t) => {
  const b = await start(makeBrowser());
  const P = b._create({ url: "https://a.com", active: true });
  await tick();

  // Facebook Container: reopen next to the original in another container,
  // without an opener, then close the original.
  const X = b._create({ openerTabId: P.id });
  await tick();
  const Y = b._create({ index: 1, cookieStoreId: "firefox-container-3" });
  await b.tabs.remove(X.id);
  await tick();
  // Same, but the original closes before our onCreated handler gets to it.
  const X2 = b._create({ openerTabId: P.id });
  await tick();
  const Y2 = b._create({ index: 2, cookieStoreId: "firefox-container-3" });
  await b.tabs.remove(X2.id);
  await tick();
  // Google Container: the original stays open.
  const S = b._create({ cookieStoreId: "firefox-container-9" });
  await tick();
  const Y3 = b._create({ index: b._tabs.indexOf(S) + 1 });
  await tick();
  const M = b._create({ openerTabId: P.id });
  await tick();
  const C = b._create({ openerTabId: M.id });
  await tick();

  await t.test("FB-style reopen -> P", async () => {
    assert.equal(await parentId(b, Y.id), P.id);
  });
  await t.test("FB-style reopen, original closed first -> P", async () => {
    assert.equal(await parentId(b, Y2.id), P.id);
  });
  await t.test("Google-style reopen -> S", async () => {
    assert.equal(await parentId(b, Y3.id), S.id);
  });

  await b.tabs.remove(M.id);
  await tick(1200); // let closedParents save

  // Browser restart: same tabs with new IDs and no openers. Session tab values
  // and storage.local are kept; storage.session is cleared.
  const restored = b._tabs.map((tab) => ({
    ...tab,
    id: nextId++ + 1000,
    openerTabId: undefined,
    values: { ...tab.values },
  }));
  const ids = new Map(b._tabs.map((tab, i) => [tab.id, restored[i].id]));
  const nid = (tab) => ids.get(tab.id);
  const b2 = await start(makeBrowser(restored, b._store));

  await t.test("restart: FB-reopened tab -> P", async () => {
    assert.equal(await parentId(b2, nid(Y)), nid(P));
  });
  await t.test("restart: Google tab -> S", async () => {
    assert.equal(await parentId(b2, nid(Y3)), nid(S));
  });
  await t.test("restart: closed parent -> grandparent P", async () => {
    assert.equal(await parentId(b2, nid(C)), nid(P));
  });
  await t.test("restart: swipe activates P and closes C", async () => {
    await b2._send(nid(C), { type: "swipe-back" });
    assert.equal(restored.find((tab) => tab.active)?.id, nid(P));
    assert.ok(!restored.some((tab) => tab.id === nid(C)));
  });

  // Extension reload: same tab IDs, storage.session kept.
  const b3 = await start(makeBrowser(restored, b2._store, b2._session));
  await t.test("extension reload: Y2 -> P", async () => {
    assert.equal(await parentId(b3, nid(Y2)), nid(P));
  });

  // The event page is unloaded while idle, then a tab closes and wakes it up.
  // The tab is already gone by then.
  const mid = b3._create({ openerTabId: nid(P) });
  await tick();
  const kid = b3._create({ openerTabId: mid.id });
  await tick();
  restored.splice(restored.indexOf(mid), 1);
  const b5 = load(makeBrowser(restored, b3._store, b3._session));
  b5._fireRemoved(mid.id, 1);
  await tick();

  await t.test("event page woken by onRemoved: child -> grandparent P", async () => {
    assert.equal(await parentId(b5, kid.id), nid(P));
  });
  const b6 = await start(makeBrowser(restored, b5._store, b5._session));
  await t.test("event page wake doesn't re-read known tabs", () => {
    assert.equal(b6._reads, 0);
  });
  await t.test("session mirror has one entry per open tab", () => {
    const entries = Object.keys(b6._session).filter((k) => k.startsWith("tab:"));
    assert.equal(entries.length, restored.length);
  });
});

test("first page detection", async (t) => {
  const b = await start(makeBrowser());
  const P = b._create({
    url: "https://container",
    cookieStoreId: "firefox-container-1",
    active: true,
  });
  await tick();
  const T = b._create({ openerTabId: P.id, cookieStoreId: "firefox-container-1" });
  await tick();
  await b._send(T.id, { type: "first-entry", entryKey: "k0" });
  // Subframes don't report.
  await b._send(T.id, { type: "first-entry", entryKey: "iframe" }, 5);
  // A later report (history.length lagging on page 2) doesn't replace it.
  await b._send(T.id, { type: "first-entry", entryKey: "k1" });
  // Spread: objects from the VM fail deepEqual on their prototype.
  const query = async (entryKey) => ({
    ...(await b._send(T.id, { type: "query", historyLength: 2, entryKey })),
  });

  await t.test("second page (cross-site) is not closed", async () => {
    assert.equal((await query("k1")).willClose, false);
  });
  await t.test("back on first page -> close to parent", async () => {
    assert.deepEqual(await query("k0"), {
      hasPreviousPage: false,
      hasParent: true,
      willClose: true,
    });
  });
  await t.test("query response carries only booleans", async () => {
    assert.deepEqual(await query("k1"), { hasPreviousPage: true, willClose: false });
  });
  await t.test("no entry key (unknown) is not closed", async () => {
    assert.equal((await query(null)).willClose, false);
  });
  await t.test("swipe on second page keeps tab", async () => {
    await b._send(T.id, { type: "swipe-back", historyLength: 2, entryKey: "k1" });
    assert.ok(b._tabs.some((tab) => tab.id === T.id));
  });

  const b2 = await start(makeBrowser(b._tabs, b._store, b._session));
  await t.test("first entry survives event page unload", async () => {
    const res = await b2._send(T.id, { type: "query", historyLength: 3, entryKey: "k0" });
    assert.equal(res.willClose, true);
  });
  await t.test("swipe on first page closes tab and activates parent", async () => {
    await b2._send(T.id, { type: "swipe-back", historyLength: 3, entryKey: "k0" });
    assert.ok(!b2._tabs.some((tab) => tab.id === T.id));
    assert.equal(b2._tabs.find((tab) => tab.active)?.id, P.id);
  });

  // The first page was never reported on load, but was swiped on while it
  // was the only entry.
  const T2 = b2._create({ openerTabId: P.id });
  await tick();
  await b2._send(T2.id, { type: "query", historyLength: 1, entryKey: "q0" });
  const query2 = (entryKey) => b2._send(T2.id, { type: "query", historyLength: 2, entryKey });
  await t.test("key learned from one-entry swipe: page 2 kept", async () => {
    assert.equal((await query2("q1")).willClose, false);
  });
  await t.test("key learned from one-entry swipe: back on page 1 closes", async () => {
    assert.equal((await query2("q0")).willClose, true);
  });
});

test("caches only keep open tabs", async (t) => {
  const b = await start(makeBrowser());
  const root = b._create({ url: "https://root" });
  await tick();
  // Many tabs closed while their onCreated handlers are still running.
  for (let i = 0; i < 200; i++) {
    const tab = b._create({ openerTabId: root.id });
    if (i % 2) await tick(0);
    await b.tabs.remove(tab.id);
    const reopened = b._create({ cookieStoreId: "firefox-container-1" });
    await b.tabs.remove(reopened.id);
  }
  // Past the prune delay and the reopen window.
  await tick(10500);
  const [uids, parents, containers, recentlyRemoved, closedParents, closing] = b._eval(
    "[uids.size, parents.size, containers.size, recentlyRemoved.length, closedParents.size, closing.size]"
  );

  await t.test("caches only hold open tabs", () => {
    assert.deepEqual({ uids, parents, containers, closing }, {
      uids: 1,
      parents: 0,
      containers: 1,
      closing: 0,
    });
  });
  await t.test("recentlyRemoved emptied", () => {
    assert.equal(recentlyRemoved, 0);
  });
  await t.test("closedParents capped", () => {
    assert.ok(closedParents <= 2000);
  });
  await t.test("session mirror pruned", () => {
    assert.equal(Object.keys(b._session).filter((k) => k.startsWith("tab:")).length, 1);
    assert.deepEqual(b._session.recentlyRemoved, []);
  });
});
