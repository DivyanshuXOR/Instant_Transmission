// Popup ↔ content script communication
const $ = (s) => document.querySelector(s);
const btnToggle = $("#btn-toggle");
const btnBg = $("#btn-bg");
const dot = $("#dot");
const statusText = $("#status-text");
const gestureBadge = $("#gesture-badge");
const gestureText = $("#gesture-text");
const popupToast = $("#popup-toast");
const platformLabel = $("#platform-name");

let toastTimer = null;
function showToast(text, isSuccess = false) {
  if (!popupToast) return;
  popupToast.textContent = text;
  popupToast.className = "popup-toast" + (isSuccess ? " success" : "");
  popupToast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    popupToast.style.display = "none";
  }, 3500);
}

// Detect which platform the current tab is on
const PLATFORM_NAMES = {
  "meet.google.com": "Google Meet",
  "zoom.us": "Zoom",
  "teams.microsoft.com": "Microsoft Teams",
  "teams.live.com": "Microsoft Teams",
  "discord.com": "Discord",
  "web.whatsapp.com": "WhatsApp",
  "ome.tv": "OmeTV",
  "minichat.com": "Minichat",
  "chatrandom.com": "Chatrandom",
  "coomeet.com": "CooMeet",
  "meet.jit.si": "Jitsi Meet",
  "onjitsi.com": "Jitsi Meet",
  "app.slack.com": "Slack",
  "messenger.com": "Messenger",
  "webex.com": "Webex",
  "whereby.com": "Whereby",
  "around.co": "Around",
  "gather.town": "Gather",
  "loom.com": "Loom",
};

function detectPlatform(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    for (const [domain, name] of Object.entries(PLATFORM_NAMES)) {
      if (hostname === domain || hostname.endsWith("." + domain)) {
        return name;
      }
    }
  } catch {}
  return null;
}

// Send a message to the active tab's content script (bridge.js)
async function send(msg) {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return null;

    // Show platform name badge if detected
    const platform = detectPlatform(tab.url);
    if (platformLabel) {
      if (platform) {
        platformLabel.textContent = platform;
        platformLabel.style.display = "inline";
      } else {
        platformLabel.style.display = "none";
      }
    }

    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (err) {
    return null;
  }
}

function updateUI(data) {
  if (!data) {
    dot.className = "dot";
    statusText.textContent = "Open a video call (or refresh)";
    gestureBadge.className = "gesture-badge";
    gestureText.textContent = "Extension: Waiting for page";
    btnToggle.disabled = true;
    btnBg.disabled = true;
    return;
  }

  btnToggle.disabled = false;
  btnBg.disabled = false;

  const vis = data.visible;
  dot.className = "dot " + (vis ? "visible" : "vanished");

  if (!data.cameraActive) {
    statusText.textContent = "Turn on camera in call 📷";
  } else {
    statusText.textContent = vis ? "You are visible" : "You are vanished 🫥";
  }

  if (data.gestureReady) {
    gestureBadge.className = "gesture-badge ready";
    gestureText.textContent = "Gesture Active: 2 fingers to forehead";
  } else {
    gestureBadge.className = "gesture-badge";
    gestureText.textContent = "Gesture: Initializing models…";
  }

  btnBg.innerHTML = '<span class="btn-icon">📸</span> Capture Background';
  if (data.bgCaptured) {
    const check = document.createElement("span");
    check.textContent = " ✔";
    check.style.color = "#3fb950";
    check.style.fontWeight = "bold";
    btnBg.appendChild(check);
  }
}

// Initial state query
send({ type: "IT_GET_STATE" }).then(updateUI);

// Listen for state changes broadcast by bridge.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "IT_STATE") updateUI(msg);
});

btnToggle.addEventListener("click", async () => {
  const res = await send({ type: "IT_TOGGLE" });
  if (res === null) {
    showToast("Please refresh the video call page first!");
  }
});

btnBg.addEventListener("click", async () => {
  btnBg.disabled = true;
  btnBg.innerHTML = '<span class="btn-icon">⏳</span> Capturing...';
  const res = await send({ type: "IT_CAPTURE_BG" });

  if (res && res.success) {
    showToast("Background captured successfully! 📸", true);
    btnBg.disabled = false;
    btnBg.innerHTML = '<span class="btn-icon">📸</span> Capture Background <span style="color:#3fb950;font-weight:bold">✔</span>';
  } else {
    btnBg.disabled = false;
    btnBg.innerHTML = '<span class="btn-icon">📸</span> Capture Background';
    const err = (res && res.error) || "Turn on your camera in the call first!";
    showToast(err);
  }
});
