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
  - the tab has no previous page (`history.length`, plus the Navigation API's
    `canGoBack` when Firefox has it).
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
  tab. Parents worked out this way are kept only in memory. They are lost
  when the extension reloads, and tabs then fall back to `openerTabId`.

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
