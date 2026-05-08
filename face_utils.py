"""
face_utils.py – Face detection, embedding extraction & recognition helpers.

Pipeline per frame
------------------
1. Decode JPEG bytes → numpy BGR array  (OpenCV)
2. Detect faces                          (face_recognition HOG/CNN detector)
3. For each detected face region:
   a. Extract 128-d face embedding
   b. Compare embedding against in-memory known-faces cache
   c. Assign name or "unknown"
4. Return list of FaceResult objects
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Optional

import cv2
import face_recognition
import numpy as np

logger = logging.getLogger(__name__)

# ── Tunables ─────────────────────────────────────────────────────────────────

RECOGNITION_THRESHOLD = float(0.55)   # Euclidean distance; lower → stricter
DETECTION_MODEL       = "hog"         # "hog" (CPU-fast) | "cnn" (GPU-accurate)
RESIZE_WIDTH          = 640           # Down-scale wide frames for speed

# ── In-memory face cache (reloaded from DB on startup / after save) ───────────

@dataclass
class KnownFace:
    name:      str
    embedding: np.ndarray   # shape (128,)


_known_faces: list[KnownFace] = []


def load_known_faces(db_docs: list[dict]) -> None:
    """
    Populate the in-memory cache from MongoDB documents.

    db_docs items: { "name": str, "embedding": np.ndarray | list }
    """
    global _known_faces
    _known_faces = [
        KnownFace(
            name=doc["name"],
            embedding=np.array(doc["embedding"], dtype=np.float64),
        )
        for doc in db_docs
        if doc.get("embedding") is not None
    ]
    logger.info("Face cache loaded: %d known person(s).", len(_known_faces))


def add_to_cache(name: str, embedding: np.ndarray) -> None:
    """Append one face to the live cache (called after DB insert)."""
    _known_faces.append(KnownFace(name=name, embedding=embedding))
    logger.info("Cache updated → %d known person(s).", len(_known_faces))


def cache_size() -> int:
    return len(_known_faces)


# ── Result type ───────────────────────────────────────────────────────────────

@dataclass
class FaceResult:
    id:         str                  # Stable per-frame ID derived from bbox
    name:       Optional[str]        # None → unknown
    box:        dict                 # {x, y, w, h}  (absolute pixels)
    embedding:  list[float]          # 128-d vector   (sent to frontend for save)
    confidence: float = field(default=0.0)  # similarity score (0–1)


# ── Core helpers ──────────────────────────────────────────────────────────────

def _make_face_id(top: int, right: int, bottom: int, left: int) -> str:
    """Deterministic 8-char ID from bounding-box coordinates."""
    raw = f"{top}:{right}:{bottom}:{left}"
    return hashlib.md5(raw.encode()).hexdigest()[:8]


def _resize_for_speed(frame: np.ndarray) -> tuple[np.ndarray, float]:
    """Scale down frame width to RESIZE_WIDTH and return (small_frame, scale)."""
    h, w = frame.shape[:2]
    if w <= RESIZE_WIDTH:
        return frame, 1.0
    scale = RESIZE_WIDTH / w
    new_w, new_h = int(w * scale), int(h * scale)
    small = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    return small, scale


def _best_match(embedding: np.ndarray) -> tuple[Optional[str], float]:
    """
    Compare *embedding* against the cache using Euclidean distance.
    Returns (name, confidence) where confidence ∈ [0, 1].
    Returns (None, 0.0) if unrecognised or cache is empty.
    """
    if not _known_faces:
        return None, 0.0

    known_embeddings = np.array([kf.embedding for kf in _known_faces])
    distances        = np.linalg.norm(known_embeddings - embedding, axis=1)
    idx              = int(np.argmin(distances))
    best_dist        = float(distances[idx])

    if best_dist > RECOGNITION_THRESHOLD:
        return None, 0.0

    # Convert distance to a 0–1 confidence score
    confidence = float(np.clip(1.0 - best_dist / RECOGNITION_THRESHOLD, 0, 1))
    return _known_faces[idx].name, confidence


# ── Public API ────────────────────────────────────────────────────────────────

def decode_jpeg(raw_bytes: bytes) -> Optional[np.ndarray]:
    """Decode raw JPEG/PNG bytes to a BGR numpy array. Returns None on failure."""
    try:
        arr = np.frombuffer(raw_bytes, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception as exc:
        logger.warning("Frame decode error: %s", exc)
        return None


def process_frame(bgr_frame: np.ndarray) -> list[FaceResult]:
    """
    Run the full face-recognition pipeline on one BGR frame.

    Returns a (possibly empty) list of FaceResult objects.
    """
    small_frame, scale = _resize_for_speed(bgr_frame)
    rgb_small          = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

    # ── 1. Detect faces ───────────────────────────────────────────────────────
    face_locations = face_recognition.face_locations(
        rgb_small, model=DETECTION_MODEL
    )
    if not face_locations:
        return []

    # ── 2. Compute embeddings ─────────────────────────────────────────────────
    face_encodings = face_recognition.face_encodings(rgb_small, face_locations)

    results: list[FaceResult] = []

    for (top, right, bottom, left), encoding in zip(face_locations, face_encodings):
        # Scale back to original resolution
        top_o    = int(top    / scale)
        right_o  = int(right  / scale)
        bottom_o = int(bottom / scale)
        left_o   = int(left   / scale)

        x = left_o
        y = top_o
        w = right_o  - left_o
        h = bottom_o - top_o

        face_id    = _make_face_id(top_o, right_o, bottom_o, left_o)
        name, conf = _best_match(encoding)

        results.append(FaceResult(
            id         = face_id,
            name       = name,
            box        = {"x": x, "y": y, "w": w, "h": h},
            embedding  = encoding.tolist(),
            confidence = conf,
        ))

    return results


def extract_embedding_from_bytes(raw_bytes: bytes) -> Optional[np.ndarray]:
    """
    Convenience: decode image bytes and extract the first face embedding.
    Used by the REST enrollment endpoint.
    Returns None if no face is found.
    """
    frame = decode_jpeg(raw_bytes)
    if frame is None:
        return None

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    locs = face_recognition.face_locations(rgb, model=DETECTION_MODEL)
    if not locs:
        return None

    encs = face_recognition.face_encodings(rgb, [locs[0]])
    return encs[0] if encs else None
