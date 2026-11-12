// ============================================================================
// Instant Transmission — Bridge (ISOLATED world content script)
//
// 1. Bridges messages between popup (chrome.runtime) and camera-hook.js (MAIN)
// 2. Injects the extension URL into the page so MAIN world can create the
//    gesture-worker iframe via chrome.runtime.getURL.
// ============================================================================
(() => {
  "use strict";

  const workerUrl = chrome.runtime.getURL("gesture/gesture-worker.html");

  // Pass extension URL to MAIN world
  window.postMessage(
    {
      type: "IT_INIT_CONFIG",
      workerUrl,
    },
    "*"
  );

  // MAIN world can request the config again if its listener was installed
  // after the initial document_start message.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.type === "IT_REQUEST_CONFIG") {
      window.postMessage({ type: "IT_INIT_CONFIG", workerUrl }, "*");
    }
  });

  // popup → page
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type?.startsWith("IT_")) {
      // If popup asks for state, wait briefly for reply from MAIN world
      if (msg.type === "IT_GET_STATE") {
        const handler = (e) => {
          if (e.source === window && e.data?.type === "IT_STATE") {
            window.removeEventListener("message", handler);
            sendResponse(e.data);
          }
        };
        window.addEventListener("message", handler);
        window.postMessage(msg, "*");
        setTimeout(() => {
          window.removeEventListener("message", handler);
        }, 1200);
        return true;
      }

      // If popup captures background, return result
      if (msg.type === "IT_CAPTURE_BG") {
        const handler = (e) => {
          if (e.source === window && e.data?.type === "IT_CAPTURE_BG_REPLY") {
            window.removeEventListener("message", handler);
            sendResponse(e.data);
          }
        };
        window.addEventListener("message", handler);
        window.postMessage(msg, "*");
        setTimeout(() => {
          window.removeEventListener("message", handler);
        }, 1500);
        return true;
      }

      window.postMessage(msg, "*");
    }
  });

  // page → popup (forward state changes)
  window.addEventListener("message", (e) => {
    if (e.data?.type === "IT_STATE") {
      chrome.runtime.sendMessage(e.data).catch(() => {});
    }
  });
})();
