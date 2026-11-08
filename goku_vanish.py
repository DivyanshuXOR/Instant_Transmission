"""Instant Transmission for Google Meet.

Hold two fingers (index + middle) against your forehead for ~1 second and you
vanish from the video with a Goku-style Instant Transmission effect: charging
aura, afterimage streak, white flash, and particle disintegration.  Do it again
to reappear (particles coalesce).

Pipeline: webcam -> MediaPipe (face + hand + person mask) -> effect ->
pyvirtualcam ("OBS Virtual Camera") -> pick that camera in Google Meet.

Usage:
    pip install -r requirements.txt
    python goku_vanish.py
    python goku_vanish.py --sound teleport.mp3
    python goku_vanish.py --list-audio          # find your VB-Cable device name
    python goku_vanish.py --sound teleport.mp3 --audio-device "CABLE Input"

Controls (preview window):
    Q / Esc  = quit
    SPACE    = recapture background
    B        = toggle background update (auto-refine)
"""
from __future__ import annotations

import argparse
import math
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent / "models"
_BASE = "https://storage.googleapis.com/mediapipe-models/"
MODELS = {
    "hand": ("hand_landmarker.task",
             _BASE + "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"),
    "face": ("blaze_face_short_range.tflite",
             _BASE + "face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"),
    "seg": ("selfie_segmenter_landscape.tflite",
            _BASE + "image_segmenter/selfie_segmenter_landscape/float16/latest/"
                    "selfie_segmenter_landscape.tflite"),
}
DETECT_WIDTH = 640          # detectors run on a downscaled copy for speed
RELEASE_SECONDS = 0.4       # pose must be dropped this long before it can re-trigger
DROPOUT_GRACE = 0.25        # tolerate brief tracking losses while holding the pose


# --------------------------------------------------------------------------- pose
def fingers_on_forehead(hand, faces, w: int, h: int) -> bool:
    """True if index+middle fingertips are extended, together, and on a forehead box.

    hand: 21 normalized landmarks. faces: list of (x, y, w, h) boxes in pixels.
    """
    pts = np.array([(p.x * w, p.y * h) for p in hand], np.float32)
    if not np.isfinite(pts).all():
        return False
    wrist = pts[0]
    dist = lambda i: float(np.linalg.norm(pts[i] - wrist))
    palm = dist(9)
    if palm < 10:
        return False
    extended = dist(8) > 1.15 * dist(6) and dist(12) > 1.15 * dist(10)
    curled = dist(16) < 1.05 * dist(14) and dist(20) < 1.05 * dist(18)
    together = np.linalg.norm(pts[8] - pts[12]) < 0.6 * palm
    if not (extended and curled and together):
        return False
    tips = pts[[8, 12]]
    for fx, fy, fw, fh in faces:
        # Detector box covers brows-to-chin; stretch it up and sideways to the hairline.
        left, right = fx - 0.2 * fw, fx + 1.2 * fw
        top, bottom = fy - 0.3 * fh, fy + 0.45 * fh
        if np.all((tips[:, 0] > left) & (tips[:, 0] < right)
                  & (tips[:, 1] > top) & (tips[:, 1] < bottom)):
            return True
    return False


class HoldGate:
    """Fires once after the pose is held; then needs a release before firing again."""

    def __init__(self, hold_seconds: float):
        self.hold = hold_seconds
        self.start: float | None = None
        self.last_pose = -1e9
        self.locked = False
        self.charge_frac = 0.0     # 0..1 — how far through the hold we are

    def update(self, pose: bool, now: float) -> bool:
        if pose:
            if now - self.last_pose > DROPOUT_GRACE:
                self.start = None
            self.last_pose = now
            if self.locked:
                self.charge_frac = 0.0
                return False
            if self.start is None:
                self.start = now
            elapsed = now - self.start
            self.charge_frac = min(elapsed / self.hold, 1.0)
            if elapsed >= self.hold:
                self.start, self.locked = None, True
                self.charge_frac = 0.0
                return True
            return False
        gap = now - self.last_pose
        if gap > DROPOUT_GRACE:
            self.start = None
            self.charge_frac = 0.0
        if self.locked and gap >= RELEASE_SECONDS:
            self.locked = False
        return False


# ------------------------------------------------------------------- aura overlay
class AuraOverlay:
    """Draw an energy-charging aura around the person's silhouette."""

    @staticmethod
    def render(frame: np.ndarray, mask: np.ndarray | None, charge: float) -> np.ndarray:
        """Overlay a pulsing blue/white aura.  charge is 0..1."""
        if charge <= 0.0 or mask is None:
            return frame
        out = frame.copy()
        h, w = out.shape[:2]

        # Grow the mask outward to create the aura shell
        binary = (mask > 0.3).astype(np.uint8) * 255
        blur_size = int(15 + 35 * charge) | 1
        glow = cv2.GaussianBlur(binary, (blur_size, blur_size), 0)
        glow = glow.astype(np.float32) / 255.0

        # Remove interior — keep only the fringe
        inner = cv2.erode(binary, np.ones((7, 7), np.uint8), iterations=2)
        inner = cv2.GaussianBlur(inner, (11, 11), 0).astype(np.float32) / 255.0
        fringe = np.clip(glow - inner, 0, 1)

        # Pulsing intensity
        pulse = 0.6 + 0.4 * math.sin(time.monotonic() * 12.0)
        intensity = charge * pulse

        # Blue-white energy colour — shifts toward white at high charge
        blue_frac = max(0, 1.0 - charge * 1.5)
        colour = np.array([255, 200 + 55 * (1 - blue_frac), 100 + 155 * (1 - blue_frac)],
                          dtype=np.float32)  # BGR

        aura = np.zeros_like(out, dtype=np.float32)
        for c in range(3):
            aura[:, :, c] = fringe * colour[c] * intensity

        # Additive blend
        result = out.astype(np.float32) + aura
        np.clip(result, 0, 255, out=result)
        return result.astype(np.uint8)


# ------------------------------------------------------------- particle system
class Particle:
    __slots__ = ("x", "y", "vx", "vy", "life", "max_life", "size", "colour",
                 "brightness", "prev_x", "prev_y")

    def __init__(self, x, y, vx, vy, life, size, colour, brightness=1.0):
        self.x, self.y = float(x), float(y)
        self.prev_x, self.prev_y = self.x, self.y
        self.vx, self.vy = float(vx), float(vy)
        self.life = self.max_life = float(life)
        self.size = int(size)
        self.colour = colour
        self.brightness = brightness


class ParticleSystem:
    """Sparkling energy particles for the disintegration / coalescence."""

    def __init__(self, mask: np.ndarray | None, shape, vanishing: bool, rng: np.random.Generator):
        self.particles: list[Particle] = []
        self.vanishing = vanishing
        h, w = shape[:2]

        # Sample spawn points from the person mask
        if mask is not None:
            ys, xs = np.where(mask > 0.35)
            if len(xs) > 0:
                n_particles = min(len(xs), 800)
                idx = rng.choice(len(xs), n_particles, replace=False)
                spawn_xs, spawn_ys = xs[idx], ys[idx]
            else:
                spawn_xs, spawn_ys = self._grid_points(w, h, 800, rng)
        else:
            spawn_xs, spawn_ys = self._grid_points(w, h, 800, rng)

        for sx, sy in zip(spawn_xs, spawn_ys):
            # Random radial velocity, biased upward for vanishing
            angle = rng.uniform(0, 2 * math.pi)
            speed = rng.uniform(60, 300)
            if vanishing:
                vy = -abs(speed * math.sin(angle)) * 0.8 - 40   # bias upward
            else:
                vy = abs(speed * math.sin(angle)) * 0.3          # drift down gently
            vx = speed * math.cos(angle) * 0.5

            life = rng.uniform(0.3, 0.8)
            size = rng.integers(1, 5)
            # Colour palette: blue / cyan / white sparks
            palette = [(255, 255, 255), (255, 200, 100), (200, 160, 50),
                       (255, 230, 200), (200, 255, 255), (255, 180, 60)]
            colour = palette[rng.integers(0, len(palette))]
            bright = rng.uniform(0.5, 1.0)
            self.particles.append(Particle(sx, sy, vx, vy, life, size, colour, bright))

    @staticmethod
    def _grid_points(w, h, n, rng):
        xs = rng.integers(int(w * 0.2), int(w * 0.8), n)
        ys = rng.integers(int(h * 0.1), int(h * 0.9), n)
        return xs, ys

    def step(self, dt: float):
        alive = []
        for p in self.particles:
            p.life -= dt
            if p.life <= 0:
                continue
            p.prev_x, p.prev_y = p.x, p.y
            p.x += p.vx * dt
            p.y += p.vy * dt
            p.vy += 50 * dt     # slight gravity
            alive.append(p)
        self.particles = alive

    def draw(self, frame: np.ndarray, alpha: float = 1.0):
        h, w = frame.shape[:2]
        for p in self.particles:
            frac = p.life / p.max_life
            a = alpha * frac * p.brightness
            if a < 0.05:
                continue
            ix, iy = int(p.x), int(p.y)
            if not (0 <= ix < w and 0 <= iy < h):
                continue
            s = p.size

            # Draw a short trail line from previous to current position
            px, py = int(p.prev_x), int(p.prev_y)
            trail_colour = tuple(int(c * a * 0.6) for c in p.colour)
            cv2.line(frame, (px, py), (ix, iy), trail_colour, max(1, s - 1), cv2.LINE_AA)

            # Draw the bright head
            y0, y1 = max(0, iy - s), min(h, iy + s + 1)
            x0, x1 = max(0, ix - s), min(w, ix + s + 1)
            roi = frame[y0:y1, x0:x1]
            colour = np.array(p.colour, dtype=np.float32)
            blend = roi.astype(np.float32) + colour * a
            np.clip(blend, 0, 255, out=blend)
            frame[y0:y1, x0:x1] = blend.astype(np.uint8)


# ------------------------------------------------------------- teleport effect
class Teleport:
    """Full Instant Transmission sequence:
       Phase 1  (0.00–0.12): Afterimage streak — body stutters/ghosts
       Phase 2  (0.12–0.18): White flash burst
       Phase 3  (0.18–0.70): Particle disintegration / coalescence
    """

    DURATION = 0.70          # total seconds

    # Phase boundaries (fraction of DURATION)
    STREAK_END = 0.17
    FLASH_START = 0.14
    FLASH_PEAK = 0.20
    FLASH_END = 0.28
    CUT = 0.18               # frame where person swaps with background
    PARTICLE_START = 0.18
    PARTICLE_END = 1.0

    def __init__(self, mask: np.ndarray | None, shape, vanishing: bool, now: float):
        self.t0, self.vanishing = now, vanishing
        self.mask = mask
        h, w = shape[:2]

        rng = np.random.default_rng(int(now * 1000) % (2**32))

        # Bounding box of the person (for streak lines)
        box = None
        if mask is not None:
            pts = cv2.findNonZero((mask > 0.4).astype(np.uint8))
            if pts is not None:
                box = cv2.boundingRect(pts)
        if box is None:
            box = (int(w * .3), int(h * .1), int(w * .4), int(h * .8))
        x, y, bw, bh = box
        px, py = int(bw * .1), int(bh * .1)
        self.area = (max(0, x - px), max(0, y - py), min(w, x + bw + px), min(h, y + bh + py))

        # Speed lines for the streak phase
        n = int(np.clip(bw // 10, 16, 50))
        self.lines = [(int(cx), int(y + bh * rng.uniform(-.1, .6)),
                       int(bh * rng.uniform(.4, 1.0)), i % 4 == 0)
                      for i, cx in enumerate(np.linspace(x, x + bw, n))]

        # Afterimage offsets (multiple ghost copies)
        self.ghost_offsets = [(rng.integers(-8, 9), rng.integers(-20, -3)) for _ in range(3)]

        # Particle system
        self.particles = ParticleSystem(mask, shape, vanishing, rng)
        self._last_time = now

    def render(self, live: np.ndarray, bg: np.ndarray, now: float):
        """Return the frame to show, or None once the effect is finished."""
        t = (now - self.t0) / self.DURATION
        dt = now - self._last_time
        self._last_time = now

        if t >= 1.0:
            return None

        before_cut = t < self.CUT
        person_shown = before_cut == self.vanishing
        base = live if person_shown else bg
        out = base.copy()
        h, w = out.shape[:2]

        # ---- Phase 1: Afterimage streak ----
        if t < self.STREAK_END:
            streak_t = t / self.STREAK_END     # 0..1 within streak phase
            # Ghost copies of the person with offset and transparency
            for i, (dx, dy) in enumerate(self.ghost_offsets):
                alpha = (1.0 - streak_t) * (0.4 - i * 0.1)
                if alpha <= 0:
                    continue
                shift_x = int(dx * streak_t * 3)
                shift_y = int(dy * streak_t * 3)
                M = np.float32([[1, 0, shift_x], [0, 1, shift_y]])
                ghost = cv2.warpAffine(live, M, (w, h))
                # Tint the ghost blue
                tint = ghost.copy()
                tint[:, :, 0] = np.clip(tint[:, :, 0].astype(int) + 60, 0, 255)  # blue channel
                tint[:, :, 1] = (tint[:, :, 1] * 0.8).astype(np.uint8)
                tint[:, :, 2] = (tint[:, :, 2] * 0.7).astype(np.uint8)
                cv2.addWeighted(tint, alpha, out, 1.0, 0, dst=out)

            # Vertical speed lines
            left, top, right, bottom = self.area
            region = out[top:bottom, left:right]
            ink = region.copy()
            drift = int(streak_t * 0.15 * (bottom - top)) * (1 if self.vanishing else -1)
            for lx, ly, length, dark in self.lines:
                x_local, y0 = lx - left, ly - top + drift
                colour = (40, 42, 50) if dark else (245, 248, 255)
                cv2.line(ink, (x_local, y0), (x_local, y0 + length),
                         colour, 2 if dark else 1, cv2.LINE_AA)
            line_alpha = streak_t * 0.7
            cv2.addWeighted(ink, line_alpha, region, 1 - line_alpha, 0, dst=region)

        # ---- Phase 2: White flash ----
        if self.FLASH_START <= t <= self.FLASH_END:
            if t < self.FLASH_PEAK:
                flash_intensity = (t - self.FLASH_START) / (self.FLASH_PEAK - self.FLASH_START)
            else:
                flash_intensity = 1.0 - (t - self.FLASH_PEAK) / (self.FLASH_END - self.FLASH_PEAK)
            flash_intensity = flash_intensity ** 0.6 * 0.85     # don't fully white-out

            # Localised flash around the person area
            flash = np.full_like(out, 255)
            if self.mask is not None:
                # Expand mask for the flash radius
                expanded = cv2.GaussianBlur((self.mask * 255).astype(np.uint8),
                                           (51, 51), 0).astype(np.float32) / 255.0
                expanded = np.clip(expanded * 2, 0, 1)
                for c in range(3):
                    flash[:, :, c] = (expanded * 255).astype(np.uint8)
            else:
                # Fallback: radial gradient from centre
                cy, cx = h // 2, w // 2
                Y, X = np.ogrid[:h, :w]
                dist = np.sqrt((X - cx)**2 + (Y - cy)**2).astype(np.float32)
                radius = min(w, h) * 0.5
                grad = np.clip(1.0 - dist / radius, 0, 1)
                for c in range(3):
                    flash[:, :, c] = (grad * 255).astype(np.uint8)

            cv2.addWeighted(flash, flash_intensity, out, 1.0 - flash_intensity * 0.5, 0, dst=out)

        # ---- Phase 3: Particles ----
        if self.PARTICLE_START <= t <= self.PARTICLE_END:
            particle_t = (t - self.PARTICLE_START) / (self.PARTICLE_END - self.PARTICLE_START)
            self.particles.step(dt)
            if self.vanishing:
                p_alpha = 1.0 - particle_t * 0.3
            else:
                p_alpha = particle_t
            self.particles.draw(out, alpha=p_alpha)

        return out


# ------------------------------------------------------------------------- helpers
def ensure_models() -> dict[str, str]:
    MODEL_DIR.mkdir(exist_ok=True)
    paths = {}
    for key, (name, url) in MODELS.items():
        path = MODEL_DIR / name
        if not path.is_file():
            print(f"Downloading {name} ...")
            urllib.request.urlretrieve(url, path)
        paths[key] = str(path)
    return paths


class Detectors:
    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks import python as mpp
        from mediapipe.tasks.python import vision
        self.mp = mp
        paths = ensure_models()
        video = vision.RunningMode.VIDEO
        base = lambda k: mpp.BaseOptions(model_asset_path=paths[k])
        self.hands = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(base_options=base("hand"), running_mode=video,
                                         num_hands=2, min_hand_detection_confidence=0.4,
                                         min_hand_presence_confidence=0.4,
                                         min_tracking_confidence=0.4))
        self.faces = vision.FaceDetector.create_from_options(
            vision.FaceDetectorOptions(base_options=base("face"), running_mode=video,
                                       min_detection_confidence=0.5))
        self.seg = vision.ImageSegmenter.create_from_options(
            vision.ImageSegmenterOptions(base_options=base("seg"), running_mode=video,
                                         output_confidence_masks=True,
                                         output_category_mask=False))
        self._last_ts = 0

    def _image(self, bgr):
        rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        return self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)

    def _ts(self) -> int:
        self._last_ts = max(self._last_ts + 1, int(time.monotonic() * 1000))
        return self._last_ts

    def pose(self, small: np.ndarray) -> bool:
        h, w = small.shape[:2]
        image, ts = self._image(small), self._ts()
        found = self.faces.detect_for_video(image, ts).detections
        if not found:
            return False
        boxes = [(d.bounding_box.origin_x, d.bounding_box.origin_y,
                  d.bounding_box.width, d.bounding_box.height) for d in found]
        hands = self.hands.detect_for_video(image, ts).hand_landmarks
        return any(len(hand) == 21 and fingers_on_forehead(hand, boxes, w, h) for hand in hands)

    def person_mask(self, small: np.ndarray, out_w: int, out_h: int) -> np.ndarray | None:
        result = self.seg.segment_for_video(self._image(small), self._ts())
        if not result.confidence_masks:
            return None
        raw = np.squeeze(result.confidence_masks[0].numpy_view()).astype(np.float32)
        return cv2.resize(raw, (out_w, out_h))

    def close(self):
        for task in (self.hands, self.faces, self.seg):
            task.close()


class Sound:
    def __init__(self, path: str | None, device: str | None):
        self.sound = None
        if not path:
            return
        import pygame
        kwargs = {"devicename": device} if device else {}
        pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=256, **kwargs)
        self.sound = pygame.mixer.Sound(path)

    def play(self):
        if self.sound:
            self.sound.stop()
            self.sound.play()


def list_audio_devices():
    import pygame
    from pygame._sdl2 import audio
    pygame.init()
    for name in audio.get_audio_device_names(False):
        print(name)


def capture_background(cap, seconds: float) -> np.ndarray:
    print(f"Step out of the frame. Capturing the empty room for {seconds:g}s ...")
    end, frames = time.monotonic() + seconds, []
    while time.monotonic() < end:
        ok, frame = cap.read()
        if ok and time.monotonic() > end - seconds * 0.5:   # keep the second half only
            frames.append(frame)
        cv2.waitKey(1)
    if not frames:
        raise RuntimeError("Could not read frames from the webcam.")
    return np.median(np.stack(frames[-20:]), axis=0).astype(np.uint8)


# --------------------------------------------------------------- HUD / debug info
def draw_hud(frame: np.ndarray, visible: bool, charge: float, fps: float):
    """Small status indicator in the corner."""
    h, w = frame.shape[:2]
    # Status dot
    colour = (0, 255, 0) if visible else (0, 0, 255)
    cv2.circle(frame, (w - 20, 20), 8, colour, -1, cv2.LINE_AA)
    label = "VISIBLE" if visible else "VANISHED"
    cv2.putText(frame, label, (w - 110, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                colour, 1, cv2.LINE_AA)

    # Charge bar
    if charge > 0:
        bar_w, bar_h = 120, 10
        bx, by = w - bar_w - 10, 38
        cv2.rectangle(frame, (bx, by), (bx + bar_w, by + bar_h), (80, 80, 80), 1)
        fill = int(bar_w * charge)
        # Gradient from blue to white
        bar_colour = (255, int(180 + 75 * charge), int(80 + 175 * charge))
        cv2.rectangle(frame, (bx, by), (bx + fill, by + bar_h), bar_colour, -1)
        cv2.putText(frame, "CHARGING", (bx, by - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35,
                    (200, 200, 255), 1, cv2.LINE_AA)

    # FPS
    cv2.putText(frame, f"{fps:.0f} fps", (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                (180, 180, 180), 1, cv2.LINE_AA)


# ---------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--hold", type=float, default=1.0, help="seconds to hold the pose")
    ap.add_argument("--sound", help="audio file to play on each teleport (wav/mp3/ogg)")
    ap.add_argument("--audio-device", help="output device name, e.g. 'CABLE Input'")
    ap.add_argument("--list-audio", action="store_true")
    ap.add_argument("--no-virtual", action="store_true", help="preview window only")
    ap.add_argument("--no-hud", action="store_true", help="hide status overlay")
    args = ap.parse_args()

    if args.list_audio:
        list_audio_devices()
        return 0

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    if not cap.isOpened():
        print("Cannot open the webcam.")
        return 1
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    vcam = None
    if not args.no_virtual:
        try:
            import pyvirtualcam
            vcam = pyvirtualcam.Camera(width, height, args.fps, fmt=pyvirtualcam.PixelFormat.BGR)
            print(f"Virtual camera: {vcam.device}  (select it in Google Meet)")
        except Exception as error:
            print(f"No virtual camera ({error}). Continuing with the preview only.")

    detectors = Detectors()
    sound = Sound(args.sound, args.audio_device)
    gate = HoldGate(args.hold)
    effect: Teleport | None = None
    visible = True
    scale = min(1.0, DETECT_WIDTH / width)
    small_size = (int(width * scale), int(height * scale))
    background = capture_background(cap, 4.0)

    # Keep a recent segmentation mask for the aura effect
    current_mask: np.ndarray | None = None
    mask_update_interval = 3     # update mask every N frames
    frame_count = 0
    fps_time = time.monotonic()
    fps_val = 0.0

    print("Ready!  Two fingers on your forehead to vanish / reappear.")
    print("  SPACE = recapture background  |  Q = quit")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                continue
            now = time.monotonic()
            frame_count += 1
            small = cv2.resize(frame, small_size) if scale < 1 else frame

            # Detect the pose
            pose_detected = detectors.pose(small)

            # Update person mask periodically (for aura + effect)
            if frame_count % mask_update_interval == 0:
                current_mask = detectors.person_mask(small, width, height)

            # Check if we should trigger
            if gate.update(pose_detected, now):
                visible = not visible
                # Get a fresh mask for the effect
                mask = detectors.person_mask(small, width, height)
                effect = Teleport(mask, frame.shape, vanishing=not visible, now=now)
                sound.play()

            # Build the output frame
            if effect is not None:
                rendered = effect.render(frame, background, now)
                if rendered is None:
                    effect = None
                    shown = frame if visible else background
                else:
                    shown = rendered
            elif visible:
                # Apply aura if charging
                if gate.charge_frac > 0:
                    shown = AuraOverlay.render(frame, current_mask, gate.charge_frac)
                else:
                    shown = frame
            else:
                shown = background

            # HUD (on preview only — doesn't go to virtual cam)
            preview = shown.copy() if not args.no_hud else shown

            # FPS calc
            if frame_count % 10 == 0:
                elapsed = now - fps_time
                fps_val = 10.0 / elapsed if elapsed > 0 else 0
                fps_time = now

            if not args.no_hud:
                draw_hud(preview, visible, gate.charge_frac, fps_val)

            cv2.imshow("Instant Transmission (preview)", preview)
            if vcam is not None:
                vcam.send(np.ascontiguousarray(shown))
                vcam.sleep_until_next_frame()

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord(" "):
                background = capture_background(cap, 4.0)
    finally:
        detectors.close()
        cap.release()
        if vcam is not None:
            vcam.close()
        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
