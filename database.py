"""
database.py – SQLite layer using aiosqlite (no server needed, free forever).

Table: faces
  id         INTEGER PRIMARY KEY AUTOINCREMENT
  name       TEXT NOT NULL
  embedding  TEXT NOT NULL   <- JSON array of 128 floats
  created_at TEXT
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

import aiosqlite
import numpy as np

logger = logging.getLogger(__name__)

DB_PATH: str = os.getenv("SQLITE_PATH", "facelock.db")

# ── Connection ────────────────────────────────────────────────────────────────

async def connect() -> None:
    """Create the table if it doesn't exist yet."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS faces (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                embedding  TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_name ON faces(name)")
        await db.commit()
    logger.info("✅  SQLite ready  path=%s", DB_PATH)


async def disconnect() -> None:
    logger.info("🔌  SQLite disconnected (no-op).")


# ── CRUD ──────────────────────────────────────────────────────────────────────

async def get_all_faces() -> list[dict]:
    """
    Fetch every stored face.
    Returns: [{ "_id": int, "name": str, "embedding": np.ndarray }]
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, name, embedding FROM faces") as cur:
            rows = await cur.fetchall()

    results = []
    for row in rows:
        results.append({
            "_id":       row["id"],
            "name":      row["name"],
            "embedding": np.array(json.loads(row["embedding"]), dtype=np.float64),
        })

    logger.debug("Loaded %d faces from SQLite.", len(results))
    return results


async def insert_face(name: str, embedding: list | np.ndarray) -> str:
    """Insert a new face. Returns the row id as string."""
    if isinstance(embedding, np.ndarray):
        embedding = embedding.tolist()

    now = datetime.now(timezone.utc).isoformat()

    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO faces (name, embedding, created_at) VALUES (?, ?, ?)",
            (name, json.dumps(embedding), now),
        )
        await db.commit()
        row_id = cur.lastrowid

    logger.info("Inserted face  name=%r  id=%s", name, row_id)
    return str(row_id)


async def delete_face_by_name(name: str) -> int:
    """Delete all rows matching name. Returns deleted count."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("DELETE FROM faces WHERE name = ?", (name,))
        await db.commit()
        return cur.rowcount


async def face_exists(name: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM faces WHERE name = ? LIMIT 1", (name,)
        ) as cur:
            return await cur.fetchone() is not None
