// ============================================================================
// MediaPipe Gesture Worker (Local Extension Context)
//
// Runs in extension context using bundled MediaPipe Tasks Vision & local models.
// Receives ImageBitmaps from the Meet page via postMessage.
// Runs HandLandmarker + FaceDetector.
// Tests if 2 fingers (index + middle) touch the forehead box.
// Posts back: { type: "POSE_RESULT", poseDetected, chargeFrac, trigger }
// ============================================================================

import {
  FilesetResolver,
  HandLandmarker,
  FaceDetector,
} from "../libs/mediapipe/vision_bundle.mjs";

let handLandmarker = null;
let faceDetector = null;
let isReady = false;

// HoldGate state
const HOLD_SECONDS = 1.0;
const DROPOUT_GRACE = 0.25;
const RELEASE_SECONDS = 0.4;

let holdStart = null;
let lastPoseTime = -1e9;
let isLocked = false;
let chargeFrac = 0.0;

// Initialize MediaPipe models from local extension files
async function init() {
  try {
    const vision = await FilesetResolver.forVisionTasks("../libs/mediapipe/wasm");

    // Initialize HandLandmarker with GPU first, fallback to CPU
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        numHands: 2,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    } catch (e) {
      console.warn("[IT Gesture Worker] GPU delegate for HandLandmarker failed, using CPU:", e);
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/hand_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        numHands: 2,
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
    }

    // Initialize FaceDetector with GPU first, fallback to CPU
    try {
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/blaze_face_short_range.tflite",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
    } catch (e) {
      console.warn("[IT Gesture Worker] GPU delegate for FaceDetector failed, using CPU:", e);
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/blaze_face_short_range.tflite",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
    }

    isReady = true;
    window.parent.postMessage({ type: "GESTURE_READY" }, "*");
    console.log("[IT Gesture Worker] Local MediaPipe models loaded successfully! ⚡");
  } catch (err) {
    console.error("[IT Gesture Worker] Failed to initialize MediaPipe:", err);
    window.parent.postMessage({ type: "GESTURE_ERROR", error: err.message }, "*");
  }
}

// Check if index + middle fingers are together, extended, and on a forehead
function checkFingersOnForehead(handLandmarks, faceBoxes, w, h) {
  const pts = handLandmarks.map((p) => ({ x: p.x * w, y: p.y * h }));
  const wrist = pts[0];
  const dist = (i) => Math.hypot(pts[i].x - wrist.x, pts[i].y - wrist.y);

  const palm = dist(9);
  if (palm < 10) return false;

  // Index (8 vs 6) and Middle (12 vs 10) extended
  const indexExt = dist(8) > 1.15 * dist(6);
  const midExt = dist(12) > 1.15 * dist(10);

  // Ring (16 vs 14) and Pinky (20 vs 18) curled
  const ringCurl = dist(16) < 1.05 * dist(14);
  const pinkyCurl = dist(20) < 1.05 * dist(18);

  // Index & Middle fingertips close together
  const tipsTogether = Math.hypot(pts[8].x - pts[12].x, pts[8].y - pts[12].y) < 0.6 * palm;

  if (!(indexExt && midExt && ringCurl && pinkyCurl && tipsTogether)) {
    return false;
  }

  // Check against forehead region of detected faces
  const tips = [pts[8], pts[12]];
  for (const box of faceBoxes) {
    const fx = box.originX;
    const fy = box.originY;
    const fw = box.width;
    const fh = box.height;

    // Expand upward and sideways for forehead / temple region
    const left = fx - 0.2 * fw;
    const right = fx + 1.2 * fw;
    const top = fy - 0.35 * fh;
    const bottom = fy + 0.45 * fh;

    const onForehead = tips.every(
      (t) => t.x > left && t.x < right && t.y > top && t.y < bottom
    );
    if (onForehead) return true;
  }

  return false;
}

// Update the hold timer gate
function updateGate(poseDetected, now) {
  if (poseDetected) {
    if (now - lastPoseTime > DROPOUT_GRACE) {
      holdStart = null;
    }
    lastPoseTime = now;

    if (isLocked) {
      chargeFrac = 0.0;
      return false;
    }

    if (holdStart === null) {
      holdStart = now;
    }

    const elapsed = now - holdStart;
    chargeFrac = Math.min(elapsed / HOLD_SECONDS, 1.0);

    if (elapsed >= HOLD_SECONDS) {
      holdStart = null;
      isLocked = true;
      chargeFrac = 0.0;
      return true; // TRIGGER!
    }
    return false;
  }

  const gap = now - lastPoseTime;
  if (gap > DROPOUT_GRACE) {
    holdStart = null;
    chargeFrac = 0.0;
  }
  if (isLocked && gap >= RELEASE_SECONDS) {
    isLocked = false;
  }
  return false;
}

// Message handler for incoming frames from Meet page
window.addEventListener("message", async (e) => {
  if (e.data?.type !== "PROCESS_FRAME" || !isReady) return;

  const { bitmap, width, height, timestamp } = e.data;
  const now = performance.now() / 1000;

  try {
    const faceResult = faceDetector.detect(bitmap);
    const handResult = handLandmarker.detect(bitmap);
    bitmap.close(); // free ImageBitmap memory immediately

    let poseDetected = false;
    const faceBoxes = (faceResult.detections || []).map((d) => d.boundingBox);

    if (faceBoxes.length > 0 && handResult.landmarks) {
      poseDetected = handResult.landmarks.some((hand) =>
        checkFingersOnForehead(hand, faceBoxes, width, height)
      );
    }

    const trigger = updateGate(poseDetected, now);

    window.parent.postMessage(
      {
        type: "POSE_RESULT",
        poseDetected,
        chargeFrac,
        trigger,
        timestamp,
      },
      "*"
    );
  } catch (err) {
    console.error("[IT Gesture Worker] Detection error:", err);
    try {
      bitmap.close();
    } catch (_) {}
  }
});

// Start initialization
init();
