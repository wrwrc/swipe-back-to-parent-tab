"use strict";

const DEFAULTS = { closeWithoutParent: false };

// How long after a tab is closed we still match it against a tab a container
// extension created to replace it.
const REOPEN_WINDOW_MS = 3000;
const NEW_TAB_URLS = new Set(["about:newtab", "about:home", "about:privatebrowsing"]);
const CLOSED_PARENTS_MAX = 2000;
const CLOSED_PARENTS_SAVE_DELAY_MS = 1000;
const PRUNE_DELAY_MS = 10000;

// Tab IDs change when the browser restarts, so each tab gets a uid stored as
// a session tab value. The browser keeps those across extension reloads,
// browser restarts and restored closed tabs. A tab's parent is stored the
// same way, as the parent's uid.
//
// We track parents ourselves because openerTabId is not enough on its own:
// - Facebook Container, Google Container and similar extensions "move" a tab
//   into another container by creating a new tab (without openerTabId) and
//   closing the original.
// - When the parent closes, Firefox drops openerTabId; we fall back to the
//   parent's parent instead.
const UID_KEY = "uid";
const PARENT_KEY = "parent";

// The background is an event page that the browser unloads when idle, so
// what we know about each open tab is mirrored to storage.session as
// "tab:<id>" entries. Without that, a tab closed while we're unloaded
// couldn't record its parent when onRemoved wakes us up.
const TAB_PREFIX = "tab:";
const RECENT_KEY = "recentlyRemoved";

// Open tab IDs. The caches below only take entries for these, since an async
// handler can finish after onRemoved has already cleaned its tab up.
const openTabs = new Set();
// Caches of the session values, kept synchronously so they're still known in
// onRemoved.
const uids = new Map(); // tabId -> uid
const parents = new Map(); // tabId -> parent uid
const containers = new Map(); // tabId -> cookieStoreId
// Closed tab uid -> its parent uid, so lookups can walk past closed tabs.
// Saved to storage.local so it survives restarts too. Capped.
let closedParents = new Map();
let saveTimer = 0;
let pruneTimer = 0;
// Tabs closed in the last REOPEN_WINDOW_MS: { tabId, uid, windowId, cookieStoreId, time }.
let recentlyRemoved = [];

// Tabs we've already started closing, so a burst of swipe messages
// (e.g. from several frames) only acts once.
const closing = new Set();

function getTabValue(tabId, key) {
  return browser.sessions.getTabValue(tabId, key).catch(() => undefined);
}

function mirrorEntry(tabId) {
  return { uid: uids.get(tabId), parent: parents.get(tabId), container: containers.get(tabId) };
}

function mirrorTab(tabId) {
  if (!openTabs.has(tabId)) return;
  browser.storage.session.set({ [TAB_PREFIX + tabId]: mirrorEntry(tabId) }).catch(() => {});
}

function setParent(tabId, parentUid) {
  if (!openTabs.has(tabId) || !parentUid || parentUid === uids.get(tabId)) return;
  parents.set(tabId, parentUid);
  browser.sessions.setTabValue(tabId, PARENT_KEY, parentUid).catch(() => {});
  mirrorTab(tabId);
}

// Reads a tab's uid and parent, giving it a uid if it has none yet.
async function loadTab(tab) {
  let uid = await getTabValue(tab.id, UID_KEY);
  if (!uid) {
    uid = crypto.randomUUID();
    await browser.sessions.setTabValue(tab.id, UID_KEY, uid).catch(() => {});
  }
  const parent = await getTabValue(tab.id, PARENT_KEY);
  if (openTabs.has(tab.id)) {
    uids.set(tab.id, uid);
    if (parent) parents.set(tab.id, parent);
  }
  return uid;
}

function trackTab(tab) {
  openTabs.add(tab.id);
  containers.set(tab.id, tab.cookieStoreId);
}

async function uidOf(tabId) {
  if (uids.has(tabId)) return uids.get(tabId);
  // Closed a moment ago, before we got here.
  const removed = recentlyRemoved.find((r) => r.tabId === tabId);
  if (removed) return removed.uid;
  try {
    return await loadTab(await browser.tabs.get(tabId));
  } catch {
    return undefined;
  }
}

async function findTabByUid(uid) {
  for (const [tabId, u] of uids) if (u === uid) return tabId;
  // The browser may have restored a tab's values after we cached them.
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      const u = await getTabValue(tab.id, UID_KEY);
      if (u && openTabs.has(tab.id)) uids.set(tab.id, u);
    })
  );
  for (const [tabId, u] of uids) if (u === uid) return tabId;
  return null;
}

function saveClosedParents() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    browser.storage.local.set({ closedParents: [...closedParents] });
  }, CLOSED_PARENTS_SAVE_DELAY_MS);
}

// Backstop for the caches: drops whatever no longer belongs to an open tab,
// e.g. a tab that closed while the startup query was in flight.
function schedulePrune() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(async () => {
    const now = Date.now();
    recentlyRemoved = recentlyRemoved.filter((r) => now - r.time < REOPEN_WINDOW_MS);
    if (recentlyRemoved.length) schedulePrune();
    const tabs = await browser.tabs.query({});
    // Tab IDs only grow, so anything above the highest ID seen here was
    // created during the query and is left alone.
    const live = new Set(tabs.map((t) => t.id));
    const maxId = Math.max(-1, ...live);
    for (const map of [openTabs, uids, parents, containers]) {
      for (const tabId of map.keys()) {
        if (!live.has(tabId) && tabId <= maxId) map.delete(tabId);
      }
    }
    const mirror = await browser.storage.session.get(null);
    const stale = Object.keys(mirror).filter((key) => {
      if (!key.startsWith(TAB_PREFIX)) return false;
      const tabId = Number(key.slice(TAB_PREFIX.length));
      return !live.has(tabId) && tabId <= maxId;
    });
    await browser.storage.session.remove(stale);
    await browser.storage.session.set({ [RECENT_KEY]: recentlyRemoved });
  }, PRUNE_DELAY_MS);
}

const ready = (async () => {
  const [{ closedParents: saved }, mirror, tabs] = await Promise.all([
    browser.storage.local.get("closedParents"),
    browser.storage.session.get(null),
    browser.tabs.query({}),
  ]);
  closedParents = new Map(saved || []);
  recentlyRemoved = mirror[RECENT_KEY] || [];
  // Woken up again in the same browser session: pick up where we left off.
  // This includes tabs closed while we were unloaded; their onRemoved
  // events are on the way.
  for (const [key, entry] of Object.entries(mirror)) {
    if (!key.startsWith(TAB_PREFIX)) continue;
    const tabId = Number(key.slice(TAB_PREFIX.length));
    if (entry.uid) uids.set(tabId, entry.uid);
    if (entry.parent) parents.set(tabId, entry.parent);
    if (entry.container) containers.set(tabId, entry.container);
  }
  tabs.forEach(trackTab);
  // Only tabs we don't know yet (first start, or after a browser restart,
  // which clears storage.session) need reading from their session values.
  const unknown = tabs.filter((tab) => !uids.has(tab.id));
  await Promise.all(unknown.map(loadTab));
  // Tabs from before we tracked them: use the browser's opener.
  for (const tab of unknown) {
    if (!parents.has(tab.id) && tab.openerTabId != null) {
      setParent(tab.id, uids.get(tab.openerTabId));
    }
  }
  if (unknown.length) {
    const entries = {};
    for (const tab of unknown) entries[TAB_PREFIX + tab.id] = mirrorEntry(tab.id);
    await browser.storage.session.set(entries);
  }
  schedulePrune();
})().catch((err) => console.error("swipe-back-to-parent:", err));

browser.tabs.onCreated.addListener(async (tab) => {
  trackTab(tab);
  await ready;
  await loadTab(tab);
  mirrorTab(tab.id);
  // A restored tab already knows its parent.
  if (parents.has(tab.id)) return;

  if (tab.openerTabId != null) {
    setParent(tab.id, await uidOf(tab.openerTabId));
    return;
  }
  if (NEW_TAB_URLS.has(tab.url)) return;

  // No opener: this may be a container extension reopening a tab. Those put
  // the new tab right next to the original, in a different container.
  const now = Date.now();
  const siblings = await browser.tabs.query({ windowId: tab.windowId });
  const pos = siblings.findIndex((t) => t.id === tab.id);
  if (pos === -1) return;
  const original = [siblings[pos - 1], siblings[pos + 1]].find(
    (t) => t && t.cookieStoreId !== tab.cookieStoreId
  );
  if (original) {
    // If the original closes (now or already), getParent() walks on to its
    // parent. If it stays open (Google Container keeps the search page), it
    // is the parent.
    setParent(tab.id, await uidOf(original.id));
    return;
  }
  // The original may already be gone by the time we got here.
  const removed = recentlyRemoved.find(
    (r) =>
      r.windowId === tab.windowId &&
      r.cookieStoreId !== tab.cookieStoreId &&
      now - r.time < REOPEN_WINDOW_MS
  );
  if (removed) setParent(tab.id, removed.uid);
});

browser.tabs.onRemoved.addListener(async (tabId, { windowId }) => {
  const now = Date.now();
  openTabs.delete(tabId);
  await ready;
  const uid = uids.get(tabId);
  const parent = parents.get(tabId);
  recentlyRemoved = recentlyRemoved.filter((r) => now - r.time < REOPEN_WINDOW_MS);
  recentlyRemoved.push({ tabId, uid, windowId, cookieStoreId: containers.get(tabId), time: now });
  browser.storage.session.remove(TAB_PREFIX + tabId).catch(() => {});
  browser.storage.session.set({ [RECENT_KEY]: recentlyRemoved }).catch(() => {});

  if (uid && parent) {
    closedParents.delete(uid);
    closedParents.set(uid, parent);
    if (closedParents.size > CLOSED_PARENTS_MAX) {
      closedParents.delete(closedParents.keys().next().value);
    }
    saveClosedParents();
  }
  openTabs.delete(tabId);
  uids.delete(tabId);
  parents.delete(tabId);
  containers.delete(tabId);
  schedulePrune();
});

// MV3 lets people take away the access to websites the content script needs.
// Ask for it again through the options page.
browser.runtime.onInstalled.addListener(async () => {
  if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) {
    browser.runtime.openOptionsPage();
  }
});

async function getSettings() {
  return browser.storage.local.get(DEFAULTS);
}

// The nearest open ancestor: if the parent was closed, its parent, and so on.
async function getParent(tabId) {
  await ready;
  let parentUid = (await getTabValue(tabId, PARENT_KEY)) || parents.get(tabId);
  if (!parentUid) {
    try {
      const { openerTabId } = await browser.tabs.get(tabId);
      return openerTabId == null ? null : await browser.tabs.get(openerTabId);
    } catch {
      return null;
    }
  }
  const seen = new Set();
  while (parentUid && !seen.has(parentUid)) {
    seen.add(parentUid);
    const parentId = await findTabByUid(parentUid);
    if (parentId != null && parentId !== tabId) {
      try {
        return await browser.tabs.get(parentId);
      } catch {}
    }
    parentUid = closedParents.get(parentUid);
  }
  return null;
}

async function query(tabId) {
  const [parent, { closeWithoutParent }] = await Promise.all([
    getParent(tabId),
    getSettings(),
  ]);
  return {
    hasParent: !!parent,
    willClose: !!parent || closeWithoutParent,
    parent: parent ? { id: parent.id, url: parent.url, container: parent.cookieStoreId } : null,
    trackedParentUid: parents.get(tabId) ?? null,
  };
}

async function closeToParent(tabId) {
  if (closing.has(tabId)) return;
  closing.add(tabId);
  try {
    const [parent, { closeWithoutParent }] = await Promise.all([
      getParent(tabId),
      getSettings(),
    ]);
    if (!parent && !closeWithoutParent) return;

    if (parent) {
      // Activate the parent first so the browser doesn't pick some other tab
      // when this one goes away.
      const self = await browser.tabs.get(tabId);
      await browser.tabs.update(parent.id, { active: true });
      if (parent.windowId !== self.windowId) {
        await browser.windows.update(parent.windowId, { focused: true });
      }
    }
    await browser.tabs.remove(tabId);
  } catch (err) {
    console.error("swipe-back-to-parent:", err);
  } finally {
    closing.delete(tabId);
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return undefined;
  switch (msg?.type) {
    case "query":
      return query(tabId);
    case "swipe-back":
      return closeToParent(tabId);
  }
  return undefined;
});
