"use strict";

const DEFAULTS = { threshold: 150, showIndicator: true, closeWithoutParent: false, debug: false };

const threshold = document.getElementById("threshold");
const thresholdValue = document.getElementById("thresholdValue");
const showIndicator = document.getElementById("showIndicator");
const closeWithoutParent = document.getElementById("closeWithoutParent");
const debug = document.getElementById("debug");

browser.storage.local.get(DEFAULTS).then((s) => {
  threshold.value = s.threshold;
  thresholdValue.textContent = s.threshold;
  showIndicator.checked = s.showIndicator;
  closeWithoutParent.checked = s.closeWithoutParent;
  debug.checked = s.debug;
});

threshold.addEventListener("input", () => {
  thresholdValue.textContent = threshold.value;
  browser.storage.local.set({ threshold: Number(threshold.value) });
});
showIndicator.addEventListener("change", () => {
  browser.storage.local.set({ showIndicator: showIndicator.checked });
});
closeWithoutParent.addEventListener("change", () => {
  browser.storage.local.set({ closeWithoutParent: closeWithoutParent.checked });
});
debug.addEventListener("change", () => {
  browser.storage.local.set({ debug: debug.checked });
});
