"use strict";

// On macOS, a two-finger horizontal trackpad swipe reaches the page as a
// stream of pixel-mode wheel events. Swiping the fingers to the right
// ("back") produces negative deltaX. The browser turns the gesture into a
// history navigation when there is a page to go back to; when there isn't,
// we recognise the same gesture here and ask the background script to close
// the tab and return to its parent.

(() => {
  if (window.__swipeBackToParent) return;
  window.__swipeBackToParent = true;

  const DEFAULTS = { threshold: 150, showIndicator: true, debug: false };
  // A pause this long between wheel events ends the gesture (momentum
  // scrolling keeps events flowing while the fingers are "still moving").
  const GESTURE_GAP_MS = 200;
  // Ignore gestures that are mostly vertical.
  const HORIZONTAL_RATIO = 1.5;

  let settings = { ...DEFAULTS };
  browser.storage.local.get(DEFAULTS).then((s) => (settings = s), () => {});
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
  });

  // Per-gesture state.
  let active = false; // a gesture is in progress
  let eligible = false; // this gesture may close the tab
  let fired = false;
  let accX = 0;
  let accY = 0;
  let willClose = null; // background's answer: null = pending
  let idleTimer = 0;

  function log(...args) {
    if (settings.debug) console.log("[swipe-back-to-parent]", ...args);
  }

  function toPixels(delta, mode) {
    if (mode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
    if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerWidth;
    return delta;
  }

  // Whether there is a page to go back to is decided with the background:
  // - history.length counts the tab's whole session history, including other
  //   sites, so 1 means there is no previous page.
  // - With more entries we may still be on the first one, after going back.
  //   history.length can't tell, and navigation.canGoBack only sees
  //   same-origin entries (it is false right after following a link to
  //   another site). So the top frame reports the Navigation API key of the
  //   tab's first entry, which stays the same when you come back to it, and
  //   the background compares it with the current entry's key.
  const isTop = window.top === window;

  function historyInfo() {
    let entryKey = null;
    try {
      if (isTop) entryKey = window.navigation?.currentEntry?.key ?? null;
    } catch {}
    return { historyLength: history.length, entryKey };
  }

  // Only real pages count: a new tab's initial about:blank is replaced by the
  // page it opens. history.length and navigation.currentEntry aren't
  // reliable while the page is still loading, so check once it has loaded.
  // The background also records the key from swipes on a one-entry tab, and
  // keeps only the first key it gets per tab.
  if (isTop && location.protocol !== "about:") {
    window.addEventListener(
      "load",
      () => {
        const info = historyInfo();
        log("first page check on load", info);
        if (info.historyLength === 1 && info.entryKey) {
          browser.runtime.sendMessage({ type: "first-entry", entryKey: info.entryKey }).catch(() => {});
        }
      },
      { once: true }
    );
  }

  function canScrollLeft(el) {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) return false;
    const rtl = getComputedStyle(el).direction === "rtl";
    return rtl ? el.scrollLeft > -max + 1 : el.scrollLeft > 1;
  }

  // True if the wheel would scroll something to the left instead of
  // being a navigation swipe.
  function targetScrollsLeft(event) {
    const root = document.scrollingElement || document.documentElement;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (node === root) break;
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      if (canScrollLeft(node)) return true;
    }
    return root ? canScrollLeft(root) : false;
  }

  function endGesture() {
    active = false;
    eligible = false;
    fired = false;
    accX = 0;
    accY = 0;
    willClose = null;
    indicator.hide();
  }

  function onWheel(event) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(endGesture, GESTURE_GAP_MS);

    if (!active) {
      active = true;
      // Decide once, at the start, whether this gesture can be ours.
      const modifier = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey; // ctrl = pinch-zoom
      const scrollsLeft = targetScrollsLeft(event);
      eligible = !modifier && !scrollsLeft;
      log("gesture start", {
        eligible,
        modifier,
        scrollsLeft,
        ...historyInfo(),
        deltaMode: event.deltaMode,
      });
      if (eligible) {
        browser.runtime.sendMessage({ type: "query", ...historyInfo() }).then(
          (res) => {
            log("background says", res);
            if (active && eligible) willClose = !!res?.willClose;
            if (!willClose) indicator.hide();
          },
          (err) => {
            log("query failed", err);
            willClose = false;
          }
        );
      }
    }
    if (!eligible || fired) return;

    // The page handled the wheel itself (carousel, map, ...).
    if (event.defaultPrevented) {
      log("page called preventDefault(); ignoring gesture");
      eligible = false;
      indicator.hide();
      return;
    }

    accX = Math.min(0, accX + toPixels(event.deltaX, event.deltaMode));
    accY += toPixels(event.deltaY, event.deltaMode);
    if (Math.abs(accY) > 10 && Math.abs(accY) * HORIZONTAL_RATIO > Math.abs(accX)) {
      log("gesture is mostly vertical; ignoring", { accX, accY });
      eligible = false;
      indicator.hide();
      return;
    }

    const threshold = Math.max(30, Number(settings.threshold) || DEFAULTS.threshold);
    const progress = Math.min(1, -accX / threshold);
    if (willClose && settings.showIndicator) indicator.show(progress);

    if (progress >= 1 && willClose) {
      log("threshold reached; asking background to close tab");
      fired = true;
      indicator.hide();
      browser.runtime.sendMessage({ type: "swipe-back", ...historyInfo() }).catch(() => {});
    }
  }

  // Bubble phase on window so page handlers have had their chance to call
  // preventDefault().
  window.addEventListener("wheel", onWheel, { passive: true });

  const indicator = (() => {
    let host = null;
    let arrow = null;

    function create() {
      host = document.createElement("swipe-back-to-parent-indicator");
      host.style.cssText =
        "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          .arrow {
            position: fixed;
            top: 50vh;
            left: 0;
            width: 48px;
            height: 48px;
            margin-top: -24px;
            border-radius: 50%;
            background: rgba(60, 60, 64, .85);
            box-shadow: 0 2px 8px rgba(0, 0, 0, .3);
            display: flex;
            align-items: center;
            justify-content: center;
            transform: translateX(-56px);
            opacity: 0;
            transition: background-color 120ms;
          }
          .arrow.ready { background: rgba(0, 96, 223, .95); }
          svg { width: 24px; height: 24px; }
        </style>
        <div class="arrow">
          <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </div>`;
      arrow = shadow.querySelector(".arrow");
    }

    return {
      show(progress) {
        if (!host) create();
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
        arrow.style.transform = `translateX(${-56 + progress * 72}px)`;
        arrow.style.opacity = String(Math.min(1, progress * 2));
        arrow.classList.toggle("ready", progress >= 1);
      },
      hide() {
        if (host?.isConnected) host.remove();
      },
    };
  })();
})();
