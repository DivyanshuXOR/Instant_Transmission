// ============================================================================
// Instant Transmission — Bridge (ISOLATED world content script)
//
// 1. Bridges messages between popup (chrome.runtime) and camera-hook.js (MAIN)
// 2. Injects the extension URL into the page so MAIN world can create the
//    gesture-worker iframe via chrome.runtime.getURL.
// ============================================================================
(() => {
  "use strict";

  // Pass extension URL to MAIN world
  window.postMessage(
    {
      type: "IT_INIT_CONFIG",
      workerUrl: chrome.runtime.getURL("gesture/gesture-worker.html"),
    },
    "*"
  );

  // popup → page
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type?.startsWith("IT_")) {
      window.postMessage(msg, "*");

      // If popup asks for state, wait briefly for reply from MAIN world
      if (msg.type === "IT_GET_STATE") {
        const handler = (e) => {
          if (e.data?.type === "IT_STATE") {
            window.removeEventListener("message", handler);
            sendResponse(e.data);
          }
        };
        window.addEventListener("message", handler);
        return true;
      }
    }
  });

  // page → popup (forward state changes)
  window.addEventListener("message", (e) => {
    if (e.data?.type === "IT_STATE") {
      chrome.runtime.sendMessage(e.data).catch(() => {});
    }
  });
})();
