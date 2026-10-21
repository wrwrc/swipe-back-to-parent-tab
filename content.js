"use strict";

// On macOS, a two-finger horizontal trackpad swipe reaches the page as a
// stream of pixel-mode wheel events. Swiping the fingers to the right
// ("back") produces negative deltaX. Firefox only turns the gesture into a
// history navigation when there is a page to go back to, so when there
// isn't, we recognise the same gesture here and ask the background script
// to close the tab and return to its parent.

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

  function hasPreviousPage() {
    if (history.length > 1) {
      // The Navigation API (when available) can tell "at the first entry
      // with forward entries" apart from "has a back entry".
      const nav = window.top === window ? window.navigation : null;
      if (nav && typeof nav.canGoBack === "boolean" && !nav.canGoBack) {
        // Iframe navigations also count as back history for Firefox.
        return document.getElementsByTagName("iframe").length > 0;
      }
      return true;
    }
    return false;
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
      const previousPage = hasPreviousPage();
      const scrollsLeft = targetScrollsLeft(event);
      eligible = !modifier && !previousPage && !scrollsLeft;
      log("gesture start", {
        eligible,
        modifier,
        previousPage,
        scrollsLeft,
        historyLength: history.length,
        canGoBack: window.navigation?.canGoBack,
        deltaMode: event.deltaMode,
      });
      if (eligible) {
        browser.runtime.sendMessage({ type: "query" }).then(
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

    if (progress >= 1 && willClose !== false) {
      log("threshold reached; asking background to close tab");
      fired = true;
      indicator.hide();
      browser.runtime.sendMessage({ type: "swipe-back" }).catch(() => {});
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
