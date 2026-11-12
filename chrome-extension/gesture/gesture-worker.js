// ============================================================================
// MediaPipe Gesture Worker (Local Extension Context)
//
// Runs in extension context using bundled MediaPipe Tasks Vision & local models.
// Receives ImageBitmaps from the video call page via postMessage.
// Runs HandLandmarker + FaceDetector.
// Trained heuristic for Goku's Instant Transmission pose:
//   - Index + Middle fingers extended together
//   - Ring + Pinky curled inward
//   - Fingertips placed on forehead / temple
//   - Persistent face tracking memory to survive hand occlusion
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

// HoldGate state — tuned for snappy, reliable recognition
const HOLD_SECONDS = 0.60;     // ~600ms hold (fast anime trigger)
const DROPOUT_GRACE = 0.50;    // 500ms grace period so tracking drops don't reset charge
const RELEASE_SECONDS = 0.35;

let holdStart = null;
let lastPoseTime = -1e9;
let isLocked = false;
let chargeFrac = 0.0;

// Persistent face tracking memory (prevents losing face when hand covers forehead)
let trackedFace = null;
let trackedFaceTime = -1e9;

// Initialize MediaPipe models from local extension files
async function init() {
  try {
    const vision = await FilesetResolver.forVisionTasks("../libs/mediapipe/wasm");

    // Initialize HandLandmarker (GPU first, fallback to CPU)
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        numHands: 2,
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
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
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      });
    }

    // Initialize FaceDetector (GPU first, fallback to CPU)
    try {
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/blaze_face_short_range.tflite",
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.35, // lower threshold to detect faces even with hand touching forehead
      });
    } catch (e) {
      console.warn("[IT Gesture Worker] GPU delegate for FaceDetector failed, using CPU:", e);
      faceDetector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "../models/blaze_face_short_range.tflite",
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.35,
      });
    }

    isReady = true;
    window.parent.postMessage({ type: "GESTURE_READY" }, "*");
    console.log("[IT Gesture Worker] Fast MediaPipe models loaded successfully! ⚡");
  } catch (err) {
    console.error("[IT Gesture Worker] Failed to initialize MediaPipe:", err);
    window.parent.postMessage({ type: "GESTURE_ERROR", error: err.message }, "*");
  }
}

// Distance helper
function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Check if hand matches Goku's Instant Transmission pose on forehead
function checkFingersOnForehead(handLandmarks, faceBoxes, w, h) {
  const pts = handLandmarks.map((p) => ({ x: p.x * w, y: p.y * h }));
  const wrist = pts[0];

  const palm = distance(pts[9], wrist);
  if (palm < 12) return false;

  // 1. Index & Middle finger extended check
  // Compare tip distance from wrist vs knuckle (PIP)
  const indexDistTip = distance(pts[8], wrist);
  const indexDistPip = distance(pts[6], wrist);
  const indexDistMcp = distance(pts[5], wrist);
  const indexExt = (indexDistTip > 1.12 * indexDistPip) || (distance(pts[8], pts[5]) > 1.2 * distance(pts[6], pts[5]));

  const midDistTip = distance(pts[12], wrist);
  const midDistPip = distance(pts[10], wrist);
  const midDistMcp = distance(pts[9], wrist);
  const midExt = (midDistTip > 1.12 * midDistPip) || (distance(pts[12], pts[9]) > 1.2 * distance(pts[10], pts[9]));

  if (!indexExt || !midExt) return false;

  // 2. Index & Middle fingertips held close together
  const tipsTogether = distance(pts[8], pts[12]) < 0.85 * palm;
  if (!tipsTogether) return false;

  // 3. Ring & Pinky finger curled check
  // In Goku's pose, the extended index & middle fingers reach significantly farther out than ring & pinky
  const ringDistTip = distance(pts[16], wrist);
  const pinkyDistTip = distance(pts[20], wrist);

  const ringCurled = (ringDistTip < indexDistTip * 0.92) || (distance(pts[16], pts[13]) < distance(pts[8], pts[5]) * 0.7);
  const pinkyCurled = (pinkyDistTip < midDistTip * 0.90) || (distance(pts[20], pts[17]) < distance(pts[12], pts[9]) * 0.7);

  if (!ringCurled || !pinkyCurled) return false;

  // 4. Forehead / Temple position check
  // Average position of the two active fingertips
  const tipCx = (pts[8].x + pts[12].x) / 2;
  const tipCy = (pts[8].y + pts[12].y) / 2;

  for (const box of faceBoxes) {
    const fx = box.originX;
    const fy = box.originY;
    const fw = box.width;
    const fh = box.height;

    // Generous forehead and temple region
    const left = fx - 0.40 * fw;
    const right = fx + 1.40 * fw;
    const top = fy - 0.60 * fh;
    const bottom = fy + 0.48 * fh;

    if (tipCx >= left && tipCx <= right && tipCy >= top && tipCy <= bottom) {
      return true;
    }
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

// Message handler for incoming frames from page
window.addEventListener("message", async (e) => {
  if (e.data?.type !== "PROCESS_FRAME" || !isReady) return;

  const { bitmap, width, height, timestamp, requestId } = e.data;
  const now = performance.now() / 1000;

  try {
    const faceResult = faceDetector.detect(bitmap);
    const handResult = handLandmarker.detect(bitmap);
    bitmap.close(); // free ImageBitmap memory immediately

    let faceBoxes = (faceResult.detections || []).map((d) => d.boundingBox);

    // Update face tracking memory
    if (faceBoxes.length > 0) {
      trackedFace = faceBoxes[0];
      trackedFaceTime = now;
    } else if (trackedFace && (now - trackedFaceTime < 2.0)) {
      // Use recently tracked face to survive hand occlusion over the forehead
      faceBoxes = [trackedFace];
    }

    let poseDetected = false;
    if (faceBoxes.length > 0 && handResult.landmarks && handResult.landmarks.length > 0) {
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
        requestId,
      },
      "*"
    );
  } catch (err) {
    console.error("[IT Gesture Worker] Detection error:", err);
    try {
      bitmap.close();
    } catch (_) {}
    window.parent.postMessage(
      {
        type: "POSE_RESULT",
        poseDetected: false,
        chargeFrac: 0,
        trigger: false,
        timestamp,
        requestId,
      },
      "*"
    );
  }
});

// Start initialization
init();
