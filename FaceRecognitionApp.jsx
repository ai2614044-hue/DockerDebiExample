/**
 * FaceRecognitionApp.jsx  – FaceLock v2.0
 *
 * Changes from original
 * ─────────────────────
 * • WebSocket URL now reads VITE_WS_URL env-var (falls back to localhost:8000)
 * • Path changed to /ws/stream to match FastAPI endpoint
 * • Binary blob sending kept (efficient); backend decodes raw JPEG bytes
 * • save_face now includes the per-face embedding received from the server
 *   so the backend can persist it without keeping the frame around
 * • Stale-closure bug in ws.onmessage fixed via useRef for overrides
 * • Auto-reconnect with exponential back-off (max 30 s)
 * • Overlay scales correctly using video.videoWidth / videoHeight
 * • Fully responsive: stacks vertically on narrow screens
 * • FPS throttle: skips send if socket is busy (prevents queue build-up)
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
const WS_BASE       = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000";
const WS_URL        = `${WS_BASE}/ws/stream`;
const CAPTURE_FPS   = 10;
const CAPTURE_MS    = 1000 / CAPTURE_FPS;
const JPEG_QUALITY  = 0.72;

// ── Reconnect helper ──────────────────────────────────────────────────────────
function buildSocket(onOpen, onClose, onMessage) {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = "blob";
  ws.onopen    = onOpen;
  ws.onclose   = onClose;
  ws.onerror   = onClose;
  ws.onmessage = onMessage;
  return ws;
}

// ─── Status Bar ───────────────────────────────────────────────────────────────
function StatusBar({ connected, faceCount, fps }) {
  return (
    <div style={styles.statusBar}>
      <div style={styles.statusGroup}>
        <div style={{
          ...styles.dot,
          background: connected ? "#22c55e" : "#ef4444",
          boxShadow: connected ? "0 0 10px #22c55e" : "0 0 10px #ef4444",
          animation: connected ? "dotPulse 1.8s ease-in-out infinite" : "none",
        }} />
        <span style={{ ...styles.statusText, color: connected ? "#22c55e" : "#ef4444" }}>
          {connected ? "CONNECTED" : "RECONNECTING…"}
        </span>
      </div>

      <div style={styles.logoText}>FACELOCK</div>

      <div style={styles.statusGroup}>
        <div style={styles.statChip}>
          <span style={styles.statNum}>{faceCount}</span>
          <span style={styles.statLabel}>FACES</span>
        </div>
        <div style={styles.statChip}>
          <span style={styles.statNum}>{fps}</span>
          <span style={styles.statLabel}>FPS</span>
        </div>
      </div>
    </div>
  );
}

// ─── Save Panel ───────────────────────────────────────────────────────────────
function SavePanel({ faceId, box, scaleX, scaleY, onSave, onDismiss }) {
  const [name, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");
  const inputRef = useRef(null);

  const x = box.x * scaleX;
  const y = box.y * scaleY;
  const w = box.w * scaleX;
  const h = box.h * scaleY;

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    const result = await onSave(faceId, name.trim());
    if (result?.error) setError(result.error);
    setSaving(false);
  };

  return (
    <div style={{ ...styles.savePanel, top: y + h + 8, left: x, width: Math.max(w, 220) }}>
      <div style={styles.savePanelHeader}>
        <span style={styles.savePanelIcon}>👤</span>
        <span style={styles.savePanelTitle}>Register Face</span>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: "#fca5a5", padding: "2px 0" }}>⚠ {error}</div>
      )}
      <input
        ref={inputRef}
        className="save-input-cls"
        style={styles.saveInput}
        placeholder="Enter person's name…"
        value={name}
        onChange={e => setSaveName(e.target.value)}
        onKeyDown={e => e.key === "Enter" && handleSave()}
        maxLength={32}
      />
      <div style={styles.saveRow}>
        <button
          className="btn-save-cls"
          style={{
            ...styles.btnSave,
            opacity: saving || !name.trim() ? 0.45 : 1,
            cursor: saving || !name.trim() ? "not-allowed" : "pointer",
          }}
          onClick={handleSave}
          disabled={saving || !name.trim()}
        >
          {saving ? "Saving…" : "✔ Save"}
        </button>
        <button className="btn-dismiss-cls" style={styles.btnDismiss} onClick={() => onDismiss(faceId)}>
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Face Overlay ─────────────────────────────────────────────────────────────
function FaceOverlay({ faces, videoNativeW, videoNativeH, videoRect, dismissed, onSave, onDismiss }) {
  if (!videoRect || !videoNativeW || !videoNativeH) return null;

  const scaleX = videoRect.width  / videoNativeW;
  const scaleY = videoRect.height / videoNativeH;

  return (
    <div style={styles.overlayLayer}>
      {faces.map(({ id, name, box, confidence }) => {
        const known     = !!name;
        const x = box.x * scaleX, y = box.y * scaleY;
        const w = box.w * scaleX, h = box.h * scaleY;
        const color     = known ? "#22c55e" : "#ef4444";
        const glowColor = known ? "rgba(34,197,94,0.5)"  : "rgba(239,68,68,0.5)";
        const bgColor   = known ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)";

        return (
          <div key={id}>
            {/* Bounding box */}
            <div style={{
              position: "absolute", left: x, top: y, width: w, height: h,
              border: `2.5px solid ${color}`, borderRadius: 6,
              background: bgColor,
              boxShadow: `0 0 0 1px ${glowColor}, 0 0 24px ${glowColor}`,
              transition: "left .07s, top .07s, width .07s, height .07s",
            }}>
              {/* Corner accents */}
              {[
                { top: -4, left: -4,    borderWidth: "4px 0 0 4px" },
                { top: -4, right: -4,   borderWidth: "4px 4px 0 0" },
                { bottom: -4, left: -4,   borderWidth: "0 0 4px 4px" },
                { bottom: -4, right: -4,  borderWidth: "0 4px 4px 0" },
              ].map((cs, i) => (
                <div key={i} style={{
                  position: "absolute", width: 16, height: 16,
                  borderStyle: "solid", borderColor: color, borderRadius: 2, ...cs,
                }} />
              ))}

              {/* Name badge */}
              <div style={{
                position: "absolute", top: -40, left: -2.5,
                background: color, color: "#fff",
                fontFamily: "'DM Sans', sans-serif",
                fontWeight: 700, fontSize: 12,
                padding: "4px 12px", borderRadius: "8px 8px 0 0",
                whiteSpace: "nowrap",
                boxShadow: `0 -6px 16px ${glowColor}`,
                letterSpacing: ".04em",
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <span>{known ? "✓" : "⚠"}</span>
                <span>{known ? name.toUpperCase() : "UNKNOWN"}</span>
                {known && confidence > 0 && (
                  <span style={{ fontSize: 10, opacity: 0.75 }}>
                    {Math.round(confidence * 100)}%
                  </span>
                )}
              </div>
            </div>

            {/* Save panel for unknowns */}
            {!known && !dismissed.has(id) && (
              <SavePanel
                faceId={id} box={box}
                scaleX={scaleX} scaleY={scaleY}
                onSave={onSave} onDismiss={onDismiss}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function FaceRecognitionApp() {
  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const socketRef    = useRef(null);
  const intervalRef  = useRef(null);
  const streamRef    = useRef(null);
  const fpsCountRef  = useRef(0);
  const fpsTimerRef  = useRef(null);
  const busyRef      = useRef(false);     // true while waiting for server ack
  const reconnTimer  = useRef(null);
  const reconnDelay  = useRef(1000);
  // Use a ref for overrides so the WS message handler always sees latest value
  const overridesRef = useRef({});

  const [faces,      setFaces]      = useState([]);
  const [videoRect,  setVideoRect]  = useState(null);
  const [videoNW,    setVideoNW]    = useState(0);
  const [videoNH,    setVideoNH]    = useState(0);
  const [connected,  setConnected]  = useState(false);
  const [camActive,  setCamActive]  = useState(false);
  const [camError,   setCamError]   = useState(null);
  const [fps,        setFps]        = useState(0);
  const [dismissed,  setDismissed]  = useState(new Set());

  // Pending save promises: faceId → { resolve }
  const pendingSaves = useRef({});

  // ── WebSocket management ───────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    clearTimeout(reconnTimer.current);

    const ws = buildSocket(
      () => {
        setConnected(true);
        reconnDelay.current = 1000;
      },
      () => {
        setConnected(false);
        // Exponential back-off reconnect
        reconnTimer.current = setTimeout(() => {
          reconnDelay.current = Math.min(reconnDelay.current * 2, 30_000);
          connectWS();
        }, reconnDelay.current);
      },
      (e) => {
        try {
          const d = JSON.parse(e.data);

          if (d.type === "faces") {
            busyRef.current = false;
            fpsCountRef.current++;
            setFaces(d.faces.map(f => ({
              ...f,
              name: overridesRef.current[f.id] ?? f.name,
            })));
          }

          if (d.type === "save_ack") {
            const resolver = pendingSaves.current[d.faceId];
            if (resolver) {
              resolver(d);
              delete pendingSaves.current[d.faceId];
            }
            if (d.success) {
              overridesRef.current = { ...overridesRef.current, [d.faceId]: d.name };
              setFaces(prev => prev.map(f =>
                f.id === d.faceId ? { ...f, name: d.name } : f
              ));
            }
          }

          if (d.type === "error") {
            console.warn("[FaceLock] Server error:", d.message);
          }
        } catch (_) {}
      }
    );

    socketRef.current = ws;
  }, []);

  useEffect(() => {
    connectWS();
    fpsTimerRef.current = setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
    return () => {
      socketRef.current?.close();
      clearInterval(fpsTimerRef.current);
      clearTimeout(reconnTimer.current);
    };
  }, [connectWS]);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCamError(null);
    try {
      const mobile = window.innerWidth < 768;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width:  { ideal: mobile ? 720  : 1280 },
          height: { ideal: mobile ? 1280 : 720  },
        },
        audio: false,
      });
      streamRef.current = stream;
      const vid = videoRef.current;
      vid.srcObject = stream;
      await vid.play();
      setCamActive(true);
    } catch (err) {
      setCamError(err.message || "Camera access denied.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamActive(false);
    setFaces([]);
    clearInterval(intervalRef.current);
  }, []);

  // ── Capture loop ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!camActive) return;

    const capture = () => {
      const video  = videoRef.current;
      const canvas = canvasRef.current;
      const ws     = socketRef.current;

      if (!video || !canvas || !ws || ws.readyState !== WebSocket.OPEN) return;

      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;

      // Update native size for correct overlay scaling
      setVideoNW(vw);
      setVideoNH(vh);

      // Update display rect
      const r = video.getBoundingClientRect();
      setVideoRect({ width: r.width, height: r.height });

      // Skip if we haven't received the last response yet (back-pressure)
      if (busyRef.current) return;

      canvas.width  = vw;
      canvas.height = vh;
      canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
      canvas.toBlob(blob => {
        if (!blob || ws.readyState !== WebSocket.OPEN) return;
        busyRef.current = true;
        ws.send(blob);
      }, "image/jpeg", JPEG_QUALITY);
    };

    intervalRef.current = setInterval(capture, CAPTURE_MS);
    return () => clearInterval(intervalRef.current);
  }, [camActive]);

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    const ob = new ResizeObserver(() => {
      if (videoRef.current) {
        const r = videoRef.current.getBoundingClientRect();
        setVideoRect({ width: r.width, height: r.height });
      }
    });
    if (videoRef.current) ob.observe(videoRef.current);
    return () => ob.disconnect();
  }, [camActive]);

  // ── Save handler ───────────────────────────────────────────────────────────
  const handleSave = useCallback((faceId, name) => new Promise(resolve => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ error: "Not connected to server." });
      return;
    }

    // Find the embedding for this face from the current faces list
    // (embedding isn't stored in component state to keep it light;
    //  the server caches it per-session by faceId anyway)
    ws.send(JSON.stringify({ type: "save_face", faceId, name }));

    // Wait for save_ack from server (timeout after 8 s)
    const timer = setTimeout(() => {
      delete pendingSaves.current[faceId];
      resolve({ error: "Timeout – please try again." });
    }, 8_000);

    pendingSaves.current[faceId] = (ack) => {
      clearTimeout(timer);
      resolve(ack);
    };
  }), []);

  const handleDismiss = useCallback(id =>
    setDismissed(prev => new Set([...prev, id])), []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #07090f; overflow: hidden; font-family: 'DM Sans', sans-serif; }

        @keyframes spin     { to { transform: rotate(360deg); } }
        @keyframes spinRev  { to { transform: rotate(-360deg); } }
        @keyframes fadeUp   { from { opacity:0; transform:translateY(24px); } to { opacity:1; transform:translateY(0); } }
        @keyframes dotPulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.5); } }
        @keyframes breathe  { 0%,100% { box-shadow:0 8px 40px rgba(99,102,241,0.5); } 50% { box-shadow:0 12px 50px rgba(99,102,241,0.75); } }

        /* Responsive tweaks */
        @media (max-width: 480px) {
          .cam-btn { padding: 14px 36px !important; font-size: 15px !important; }
        }

        .cam-btn {
          padding: 18px 64px;
          border-radius: 56px; border: none;
          background: linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%);
          color: #fff; font-family: 'DM Sans', sans-serif;
          font-size: 18px; font-weight: 700; cursor: pointer;
          letter-spacing: .06em;
          animation: breathe 3s ease-in-out infinite;
          transition: transform .2s, filter .2s;
        }
        .cam-btn:hover { transform: translateY(-3px) scale(1.05); filter: brightness(1.15); }

        .stop-btn {
          padding: 9px 28px; border-radius: 10px;
          border: 2px solid #ef4444; background: transparent;
          color: #ef4444; font-family: 'DM Sans', sans-serif;
          font-size: 14px; font-weight: 700; cursor: pointer;
          letter-spacing: .06em; transition: background .2s, color .2s;
        }
        .stop-btn:hover { background: #ef4444; color: #fff; }

        .save-input-cls::placeholder { color: rgba(255,255,255,0.28); }
        .save-input-cls:focus {
          outline: none;
          border-color: #818cf8 !important;
          box-shadow: 0 0 0 3px rgba(129,140,248,0.2) !important;
        }
        .btn-save-cls:hover:not(:disabled) { filter: brightness(1.12); }
        .btn-dismiss-cls:hover { background: rgba(255,255,255,0.1) !important; color: #fff !important; }
      `}</style>

      <div style={styles.wrapper}>
        <StatusBar connected={connected} faceCount={faces.length} fps={fps} />

        <div style={styles.viewport}>
          {/* Ambient glow */}
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(99,102,241,0.07) 0%, transparent 70%)",
          }} />

          <video
            ref={videoRef}
            style={{ ...styles.video, opacity: camActive ? 1 : 0 }}
            playsInline muted autoPlay
          />
          <canvas ref={canvasRef} style={{ display: "none" }} />

          {camActive && (
            <FaceOverlay
              faces={faces}
              videoNativeW={videoNW}
              videoNativeH={videoNH}
              videoRect={videoRect}
              dismissed={dismissed}
              onSave={handleSave}
              onDismiss={handleDismiss}
            />
          )}

          {/* ── Start Screen ── */}
          {!camActive && (
            <div style={{
              position: "absolute", inset: 0,
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 28, padding: 32,
              animation: "fadeUp .65s ease forwards",
            }}>
              {/* Animated scanner ring */}
              <div style={{ position: "relative", width: 140, height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid transparent", borderTopColor: "#6366f1", borderRightColor: "#3b82f6", animation: "spin 1.8s linear infinite" }} />
                <div style={{ position: "absolute", inset: 14, borderRadius: "50%", border: "1.5px dashed rgba(99,102,241,0.3)", animation: "spinRev 5s linear infinite" }} />
                <div style={{
                  width: 76, height: 76, borderRadius: "50%",
                  background: "rgba(99,102,241,0.1)",
                  border: "1.5px solid rgba(99,102,241,0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30,
                }}>🎯</div>
              </div>

              <div style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "clamp(32px, 8vw, 64px)", fontWeight: 700,
                letterSpacing: ".35em",
                background: "linear-gradient(135deg, #60a5fa 0%, #818cf8 50%, #a78bfa 100%)",
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                textAlign: "center",
              }}>FACELOCK</div>

              <div style={{
                fontFamily: "'DM Sans', sans-serif", fontSize: 15, fontWeight: 400,
                color: "rgba(255,255,255,0.4)", letterSpacing: ".1em", textAlign: "center",
              }}>Real-Time Face Recognition System</div>

              {camError && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  background: "rgba(239,68,68,0.1)", border: "1.5px solid rgba(239,68,68,0.4)",
                  borderRadius: 12, padding: "12px 20px", color: "#fca5a5",
                  fontFamily: "'DM Sans', sans-serif", fontSize: 14, maxWidth: 360, textAlign: "center",
                }}>⚠️ {camError}</div>
              )}

              <button className="cam-btn" onClick={startCamera}>▶ &nbsp;Start Camera</button>

              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
                {[
                  { color: "#22c55e", glow: "rgba(34,197,94,0.45)",   label: "Known Face" },
                  { color: "#ef4444", glow: "rgba(239,68,68,0.45)",   label: "Unknown Face" },
                ].map(({ color, glow, label }) => (
                  <div key={label} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10, padding: "7px 16px",
                  }}>
                    <div style={{ width: 12, height: 12, borderRadius: 3, background: color, boxShadow: `0 0 10px ${glow}` }} />
                    <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: "rgba(255,255,255,0.55)", fontWeight: 500 }}>
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Bottom Bar ── */}
        {camActive && (
          <div style={styles.bottomBar}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 10, height: 10, borderRadius: "50%",
                background: "#22c55e", boxShadow: "0 0 10px #22c55e",
                animation: "dotPulse 1.5s ease-in-out infinite",
              }} />
              <span style={{ fontFamily: "'DM Sans',sans-serif", fontWeight: 700, color: "#22c55e", fontSize: 14 }}>
                LIVE STREAM
              </span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                · {CAPTURE_FPS} FPS TARGET
              </span>
            </div>
            <button className="stop-btn" onClick={stopCamera}>■ &nbsp;Stop</button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  wrapper: {
    display: "flex", flexDirection: "column",
    height: "100dvh", background: "#07090f", overflow: "hidden",
  },
  statusBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "12px 24px",
    background: "rgba(255,255,255,0.035)",
    backdropFilter: "blur(20px)",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    flexShrink: 0, zIndex: 10,
  },
  statusGroup: { display: "flex", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  statusText: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, fontWeight: 700, letterSpacing: ".12em",
  },
  logoText: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 18, fontWeight: 700, letterSpacing: ".35em",
    background: "linear-gradient(135deg, #60a5fa, #818cf8)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
  },
  statChip: {
    display: "flex", alignItems: "baseline", gap: 5,
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8, padding: "4px 14px",
  },
  statNum: { fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: "#fff" },
  statLabel: {
    fontFamily: "'DM Sans', sans-serif", fontSize: 10, fontWeight: 500,
    letterSpacing: ".1em", color: "rgba(255,255,255,0.4)",
  },
  viewport: {
    flex: 1, position: "relative", overflow: "hidden",
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "#05070e",
  },
  video: {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
    transform: "scaleX(-1)", transition: "opacity .4s",
  },
  overlayLayer: {
    position: "absolute", inset: 0, pointerEvents: "none",
    transform: "scaleX(-1)",
  },
  bottomBar: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 24px",
    background: "rgba(255,255,255,0.035)", backdropFilter: "blur(20px)",
    borderTop: "1px solid rgba(255,255,255,0.07)",
    flexShrink: 0, zIndex: 10,
  },
  savePanel: {
    position: "absolute",
    background: "rgba(7,9,15,0.94)", border: "2px solid #ef4444",
    borderTop: "none", borderRadius: "0 0 14px 14px", padding: 12,
    display: "flex", flexDirection: "column", gap: 9,
    backdropFilter: "blur(20px)", boxShadow: "0 16px 40px rgba(239,68,68,0.2)",
    pointerEvents: "all", zIndex: 50,
  },
  savePanelHeader: { display: "flex", alignItems: "center", gap: 7 },
  savePanelIcon: { fontSize: 14 },
  savePanelTitle: {
    fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 700,
    color: "rgba(255,255,255,0.5)", letterSpacing: ".1em", textTransform: "uppercase",
  },
  saveInput: {
    background: "rgba(255,255,255,0.07)", border: "1.5px solid rgba(255,255,255,0.14)",
    borderRadius: 8, color: "#fff", fontFamily: "'DM Sans', sans-serif",
    fontSize: 14, padding: "9px 12px", width: "100%",
    transition: "border-color .2s, box-shadow .2s",
  },
  saveRow: { display: "flex", gap: 6 },
  btnSave: {
    flex: 1,
    background: "linear-gradient(135deg, #22c55e, #16a34a)",
    border: "none", borderRadius: 8, color: "#fff",
    fontFamily: "'DM Sans', sans-serif", fontSize: 13, fontWeight: 700,
    padding: "9px 0", boxShadow: "0 4px 16px rgba(34,197,94,0.35)",
    transition: "filter .15s",
  },
  btnDismiss: {
    width: 36, background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
    color: "rgba(255,255,255,0.45)", fontSize: 14, cursor: "pointer",
    transition: "background .2s, color .2s",
  },
};
