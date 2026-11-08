// Popup ↔ content script communication
const $ = (s) => document.querySelector(s);
const btnToggle = $("#btn-toggle");
const btnBg = $("#btn-bg");
const dot = $("#dot");
const statusText = $("#status-text");
const gestureBadge = $("#gesture-badge");
const gestureText = $("#gesture-text");

// Send a message to the active Meet tab's content script (bridge.js)
async function send(msg) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: "https://meet.google.com/*",
  });
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

function updateUI(data) {
  if (!data) {
    dot.className = "dot";
    statusText.textContent = "Open a Google Meet call first";
    gestureBadge.className = "gesture-badge";
    gestureText.textContent = "MediaPipe: Inactive";
    btnToggle.disabled = true;
    btnBg.disabled = true;
    return;
  }
  const vis = data.visible;
  dot.className = "dot " + (vis ? "visible" : "vanished");
  statusText.textContent = vis ? "You are visible" : "You are vanished 🫥";

  if (data.gestureReady) {
    gestureBadge.className = "gesture-badge ready";
    gestureText.textContent = "Gesture Active: 2 fingers to forehead";
  } else {
    gestureBadge.className = "gesture-badge";
    gestureText.textContent = "Gesture: Initializing models…";
  }

  btnToggle.disabled = false;
  btnBg.disabled = false;
  btnBg.querySelector("span:last-child")?.remove();
  if (data.bgCaptured) {
    const check = document.createElement("span");
    check.textContent = " ✔";
    check.style.color = "#3fb950";
    btnBg.appendChild(check);
  }
}

// Initial state query
send({ type: "IT_GET_STATE" }).then(updateUI);

// Listen for state changes broadcast by bridge.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "IT_STATE") updateUI(msg);
});

btnToggle.addEventListener("click", () => send({ type: "IT_TOGGLE" }));
btnBg.addEventListener("click", () => send({ type: "IT_CAPTURE_BG" }));
