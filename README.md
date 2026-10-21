# Swipe Back to Parent Tab (Firefox)

On macOS, a two-finger swipe right normally goes back a page. When the tab has
**no previous page** (for example, a link you opened in a new tab), Firefox
ignores the swipe. With this extension, that swipe **closes the tab and switches
to the tab that opened it** (its parent). This works for container and
non-container tabs, including when the parent is in a different container or
window.

If the tab has back history, Firefox's normal swipe-back still happens and the
extension does nothing.

## How it works

- `content.js` watches the pixel-mode `wheel` events that a trackpad swipe sends
  to the page. It treats the input as a swipe when all of these are true:
  - the movement is mostly horizontal and toward "back" (negative `deltaX`),
  - nothing under the pointer can scroll further left,
  - the page didn't call `preventDefault()`,
  - the tab has no previous page. That is the case when `history.length` is
    1, or when the tab is back on its first page after going back. For the
    second case, the content script reports the Navigation API key of the
    tab's first page, and the swipe compares it with the current page's key.
    It doesn't use `navigation.canGoBack`, because that only counts pages
    from the same site. If the extension can't tell, it does nothing and the
    browser handles the swipe.
- `background.js` keeps track of each tab's parent, starting from
  `tabs.Tab.openerTabId`, which Firefox sets no matter which container a tab
  is in. It also handles these cases:
  - **Tabs moved into a container by another extension.** Facebook Container,
    Google Container and similar extensions reopen the tab in another
    container and drop the opener. If a tab with no opener appears right next
    to a tab in a different container, that neighbour is treated as its
    parent. If the neighbour then closes (it was the tab being replaced), the
    new tab takes over the neighbour's parent. Multi-Account Containers keeps
    the opener on its own.
  - **Parent closed.** The tab falls back to its grandparent.

  When you swipe, the script switches to the parent first and then closes the
  tab.
- Parent links are saved with each tab using `browser.sessions.setTabValue`,
  so they survive extension reloads and updates, browser restarts, and closed
  tabs being restored. Because tab IDs change when the browser restarts, each
  tab gets its own stable ID, and the parent is stored by that ID. The list of
  closed tabs' parents, used for the grandparent fallback, is kept in
  `storage.local`. It keeps the 2,000 most recent entries.
- The extension uses Manifest V3. Its background script is an event page,
  which the browser unloads when it has been idle for a while. To bridge
  that, what it knows about each open tab is copied to `storage.session`, so
  a tab that closes while the script is unloaded still records its parent.

## Install

Temporary install (lasts until Firefox restarts):

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `manifest.json`.

Permanent install: either sign `dist/*.zip` through AMO (you can list it as
unlisted or self-distributed), or use Firefox Developer Edition/Nightly with
`xpinstall.signatures.required = false` and install the zip from
`about:addons` → gear menu → **Install Add-on From File…**.

Developing: run `npx web-ext run` for live reload, `npx web-ext lint` to lint,
and `npx web-ext build -a dist` to build the zip.

Publishing to AMO: `amo-metadata.json` holds the listing details and the notes
for reviewers. Bump `version` in `manifest.json`, then run:

```sh
npx web-ext sign --channel=listed --amo-metadata=amo-metadata.json \
  --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
```

Use `--channel=unlisted` to get a signed `.xpi` without a public listing.
`web-ext-config.mjs` keeps the repo-only files out of the package.

## Site access

Manifest V3 lets you turn off an extension's access to websites, for example
from the extension's **Permissions** tab in `about:addons`. Without that
access, swiping does nothing. If access is missing when the extension is
installed or updated, the options page opens with an **Allow** button. The
options page shows that button whenever access is missing.

## Options

- **Swipe distance**: how far you swipe before the tab closes (default 150px).
- **Show indicator**: shows a ✕ bubble that slides in from the left edge as you
  swipe.
- **Also close tabs that have no parent tab**: this is off by default, so a tab
  with no parent and no history stays open.
- **Debug logging**: writes what the extension decides on each swipe to the
  page's Web Console (⌥⌘K).

## Requirements and limitations

- Firefox 140 or later, or a browser built on it such as Zen.
- Zen already has a built-in "close tab on back with no history" setting
  (`zen.tabs.close-on-back-with-no-history`, on by default). It only applies
  while the tab still has an *owner*: the tab must have been opened in the
  foreground, and you must not have switched to another tab since. In that case
  Zen handles the swipe and closes the tab itself. This extension covers the
  other cases, such as background tabs, tabs you have switched away from and
  back to, and tabs reopened in a container.
- In macOS System Settings → Trackpad → More Gestures, "Swipe between pages"
  must use two fingers (this is the default).
- Firefox doesn't let extensions run on privileged pages, so the swipe doesn't
  work on `about:` pages (such as the New Tab page), `addons.mozilla.org`, other
  extensions' pages, or `view-source:` pages.
- A tab opened with ⌘T or from the address bar has no opener, so it has no
  parent tab.
