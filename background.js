"use strict";

const DEFAULTS = { closeWithoutParent: false };

// How long after a tab is closed we still match it against a tab a container
// extension created to replace it.
const REOPEN_WINDOW_MS = 3000;
const NEW_TAB_URLS = new Set(["about:newtab", "about:home", "about:privatebrowsing"]);

// tabId -> parent tabId. Seeded from openerTabId, but tracked here because
// openerTabId is not enough on its own:
// - Facebook Container, Google Container and similar extensions "move" a tab
//   into another container by creating a new tab (without openerTabId) and
//   closing the original.
// - When the parent closes, Firefox drops openerTabId; we fall back to the
//   parent's parent instead.
const parents = new Map();
// Closed tabId -> its parent, so lookups can walk past closed tabs. Capped.
const closedParents = new Map();
const CLOSED_PARENTS_MAX = 2000;
// tabId -> cookieStoreId, kept synchronously so it's still known in onRemoved.
const containers = new Map();
// Tabs closed in the last REOPEN_WINDOW_MS: { id, windowId, cookieStoreId, parent, time }.
let recentlyRemoved = [];

// Tabs we've already started closing, so a burst of swipe messages
// (e.g. from several frames) only acts once.
const closing = new Set();

function remember(tab) {
  containers.set(tab.id, tab.cookieStoreId);
  if (tab.openerTabId != null && tab.openerTabId !== tab.id) {
    parents.set(tab.id, tab.openerTabId);
  }
}

browser.tabs.query({}).then((tabs) => tabs.forEach(remember));

browser.tabs.onCreated.addListener(async (tab) => {
  remember(tab);
  if (tab.openerTabId != null || NEW_TAB_URLS.has(tab.url)) return;

  // No opener: this may be a container extension reopening a tab. Those put
  // the new tab right next to the original, in a different container.
  const now = Date.now();
  const siblings = await browser.tabs.query({ windowId: tab.windowId });
  const pos = siblings.findIndex((t) => t.id === tab.id);
  if (pos === -1 || parents.has(tab.id)) return;
  const original = [siblings[pos - 1], siblings[pos + 1]].find(
    (t) => t && t.cookieStoreId !== tab.cookieStoreId
  );
  if (original) {
    // If the original closes (now or already), getParent() walks on to its
    // parent. If it stays open (Google Container keeps the search page), it
    // is the parent.
    parents.set(tab.id, original.id);
    return;
  }
  // The original may already be gone by the time we got here.
  const removed = recentlyRemoved.find(
    (r) =>
      r.windowId === tab.windowId &&
      r.cookieStoreId !== tab.cookieStoreId &&
      now - r.time < REOPEN_WINDOW_MS
  );
  if (removed?.parent != null) parents.set(tab.id, removed.parent);
});

browser.tabs.onRemoved.addListener((tabId, { windowId }) => {
  const parent = parents.get(tabId);
  const now = Date.now();
  recentlyRemoved = recentlyRemoved.filter((r) => now - r.time < REOPEN_WINDOW_MS);
  recentlyRemoved.push({ id: tabId, windowId, cookieStoreId: containers.get(tabId), parent, time: now });

  closedParents.set(tabId, parent);
  if (closedParents.size > CLOSED_PARENTS_MAX) {
    closedParents.delete(closedParents.keys().next().value);
  }
  parents.delete(tabId);
  containers.delete(tabId);
});

async function getSettings() {
  return browser.storage.local.get(DEFAULTS);
}

// The nearest open ancestor: if the parent was closed, its parent, and so on.
async function getParent(tabId) {
  let parentId = parents.get(tabId);
  if (parentId == null) {
    try {
      parentId = (await browser.tabs.get(tabId)).openerTabId;
    } catch {
      return null;
    }
  }
  const seen = new Set([tabId]);
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    try {
      return await browser.tabs.get(parentId);
    } catch {
      parentId = closedParents.get(parentId);
    }
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
    trackedParentId: parents.get(tabId) ?? null,
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
