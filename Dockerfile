# ── Stage 1: Build image ──────────────────────────────────────────────────────
# We use a slim Debian base; dlib (required by face_recognition) needs build tools.
FROM python:3.11-slim AS builder

# OS build dependencies for dlib + OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        libopenblas-dev \
        liblapack-dev \
        libx11-dev \
        libgl1-mesa-glx \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .

# Build wheels (dlib compiles from source – takes ~5 min)
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt


# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Minimal runtime OS libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        libopenblas0 \
        liblapack3 \
        libgl1-mesa-glx \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pre-built wheels
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --find-links /wheels /wheels/*.whl \
    && rm -rf /wheels

# Copy application source
COPY . .

# Non-root user for security
RUN useradd -m -u 1001 facelock && chown -R facelock:facelock /app
USER facelock

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]

     "--log-level", "info"]
