"""
main.py – FaceLock FastAPI server.

Endpoints
---------
WS  /ws/stream          – Live video stream, bi-directional JSON/binary
GET /api/health         – Health check
GET /api/faces          – List all known names
POST /api/faces/enroll  – Enroll a face from an uploaded image (multipart)
DELETE /api/faces/{name} – Remove a person from the database
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect,
    UploadFile, File, Form, HTTPException
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import database as db
import face_utils as fu

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to MongoDB and pre-load face embeddings into memory."""
    await db.connect()
    faces = await db.get_all_faces()
    fu.load_known_faces(faces)
    logger.info("Server ready – %d face(s) in cache.", fu.cache_size())
    yield
    await db.disconnect()


# ── App ───────────────────────────────────────────────────────────────────────

ALLOWED_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000"
).split(",")

app = FastAPI(
    title="FaceLock API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST Endpoints ────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "known_faces": fu.cache_size()}


@app.get("/api/faces")
async def list_faces():
    """Return all stored person names (deduplicated)."""
    docs = await db.get_all_faces()
    names = sorted({d["name"] for d in docs})
    return {"names": names, "count": len(names)}


@app.post("/api/faces/enroll", status_code=201)
async def enroll_face(
    name:  str        = Form(...),
    image: UploadFile = File(...),
):
    """
    Enroll a new person via a static image upload.

    Accepts: multipart/form-data  {name: str, image: file}
    """
    raw = await image.read()
    embedding = fu.extract_embedding_from_bytes(raw)
    if embedding is None:
        raise HTTPException(422, "No face detected in the uploaded image.")

    face_id = await db.insert_face(name, embedding)
    fu.add_to_cache(name, embedding)
    return {"success": True, "id": face_id, "name": name}


@app.delete("/api/faces/{name}")
async def delete_face(name: str):
    count = await db.delete_face_by_name(name)
    if count == 0:
        raise HTTPException(404, f"No face record found for '{name}'.")
    # Reload cache after deletion
    faces = await db.get_all_faces()
    fu.load_known_faces(faces)
    return {"deleted": count, "name": name}


# ── WebSocket: /ws/stream ─────────────────────────────────────────────────────
#
# Protocol (client → server)
# ──────────────────────────
#   Binary frame  : raw JPEG bytes  → face-detection response
#   Text message  : JSON  { "type": "save_face", "faceId": str,
#                                                "name": str,
#                                                "embedding": list[float] }
#
# Protocol (server → client)
# ──────────────────────────
#   { "type": "faces",    "faces": [ FaceResult … ] }
#   { "type": "save_ack", "success": bool, "faceId": str, "name": str,
#                         "error": str? }
#   { "type": "error",    "message": str }

import json as _json

# Per-session in-memory store: faceId → embedding (list[float])
# This lets the frontend request save of an embedding the server
# produced earlier in the same session.
_session_embeddings: dict[str, list[float]] = {}


@app.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connected: %s", websocket.client)

    # Per-connection embedding cache (faceId → embedding list)
    session_embeddings: dict[str, list[float]] = {}

    try:
        while True:
            # We accept both binary (JPEG frame) and text (JSON command)
            message = await websocket.receive()

            # ── Binary frame: process and return detections ────────────────
            if "bytes" in message and message["bytes"] is not None:
                raw_bytes = message["bytes"]
                frame = fu.decode_jpeg(raw_bytes)

                if frame is None:
                    await websocket.send_text(_json.dumps({
                        "type": "error",
                        "message": "Could not decode frame.",
                    }))
                    continue

                # Run face recognition (blocking – offload to thread pool)
                results = await asyncio.get_event_loop().run_in_executor(
                    None, fu.process_frame, frame
                )

                # Cache embeddings for potential "save_face" command
                for r in results:
                    session_embeddings[r.id] = r.embedding

                # Serialise FaceResult → plain dict (omit heavy embedding field)
                faces_payload = [
                    {
                        "id":         r.id,
                        "name":       r.name,       # None → "Unknown" on client
                        "box":        r.box,
                        "confidence": round(r.confidence, 3),
                    }
                    for r in results
                ]

                await websocket.send_text(_json.dumps({
                    "type":  "faces",
                    "faces": faces_payload,
                }))

            # ── Text command ───────────────────────────────────────────────
            elif "text" in message and message["text"] is not None:
                try:
                    cmd = _json.loads(message["text"])
                except _json.JSONDecodeError:
                    await websocket.send_text(_json.dumps({
                        "type": "error", "message": "Invalid JSON."
                    }))
                    continue

                if cmd.get("type") == "save_face":
                    face_id = cmd.get("faceId", "")
                    name    = (cmd.get("name") or "").strip()

                    if not name:
                        await websocket.send_text(_json.dumps({
                            "type": "save_ack", "success": False,
                            "faceId": face_id, "name": "",
                            "error": "Name must not be empty.",
                        }))
                        continue

                    # Retrieve embedding: prefer server-cached over client-sent
                    embedding = session_embeddings.get(face_id) or cmd.get("embedding")

                    if not embedding:
                        await websocket.send_text(_json.dumps({
                            "type": "save_ack", "success": False,
                            "faceId": face_id, "name": name,
                            "error": "Embedding not found. Keep face visible.",
                        }))
                        continue

                    try:
                        import numpy as np
                        emb_arr = np.array(embedding, dtype=np.float64)
                        doc_id  = await db.insert_face(name, emb_arr)
                        fu.add_to_cache(name, emb_arr)
                        await websocket.send_text(_json.dumps({
                            "type": "save_ack", "success": True,
                            "faceId": face_id, "name": name, "id": doc_id,
                        }))
                    except Exception as exc:
                        logger.exception("DB insert failed: %s", exc)
                        await websocket.send_text(_json.dumps({
                            "type": "save_ack", "success": False,
                            "faceId": face_id, "name": name,
                            "error": str(exc),
                        }))

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: %s", websocket.client)
    except Exception as exc:
        logger.exception("WebSocket error: %s", exc)
        try:
            await websocket.send_text(_json.dumps({
                "type": "error", "message": str(exc)
            }))
        except Exception:
            pass


# ── Entry point (dev) ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=True,
        log_level="info",
    )
