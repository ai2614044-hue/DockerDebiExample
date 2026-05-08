# 🎯 FaceLock – Real-Time Face Recognition App
**Debi Hackathon 2026**

## Architecture Overview

```
┌─────────────────────┐         WebSocket /ws/stream          ┌──────────────────────┐
│   React Frontend    │ ◄─────────────────────────────────── │   FastAPI Backend    │
│  (Vite + JSX)       │ ──── raw JPEG frames (binary) ──────► │   (Uvicorn)          │
└─────────────────────┘                                        └──────────┬───────────┘
                                                                          │
                                                               ┌──────────▼───────────┐
                                                               │   face_utils.py      │
                                                               │  HOG detector        │
                                                               │  128-d embeddings    │
                                                               │  Euclidean match     │
                                                               └──────────┬───────────┘
                                                                          │
                                                               ┌──────────▼───────────┐
                                                               │   MongoDB Atlas      │
                                                               │   faces collection   │
                                                               └──────────────────────┘
```

---

## Local Development (Quickstart)

### Prerequisites
- Python 3.10+
- Node.js 18+
- Docker + Docker Compose (for MongoDB)
- Git

### 1. Start MongoDB
```bash
docker run -d --name mongo -p 27017:27017 mongo:7
```

### 2. Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt    # dlib compiles ~5 min first time
cp .env.example .env               # edit MONGO_URI if needed
python main.py
# → Server running on http://localhost:8000
```

### 3. Frontend
```bash
cd frontend
cp .env.example .env.local         # already points to ws://localhost:8000
npm install
npm run dev
# → App running on http://localhost:5173
```

---

## Full Docker Compose (one command)

```bash
docker compose up --build
```
- Backend:  http://localhost:8000
- Frontend: http://localhost:5173
- Swagger:  http://localhost:8000/docs

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGO_DB` | `facelock` | Database name |
| `CORS_ORIGINS` | `http://localhost:3000,...` | Comma-separated allowed origins |
| `PORT` | `8000` | Server port |
| `VITE_WS_URL` | `ws://localhost:8000` | Frontend WebSocket base URL |

---

## Deployment Guide

### Option A – Render.com (Recommended for Hackathon)

1. **MongoDB Atlas (free tier)**
   - Create account at https://cloud.mongodb.com
   - Create a free M0 cluster
   - Get the connection string: `mongodb+srv://user:pass@cluster.mongodb.net/facelock`
   - Whitelist `0.0.0.0/0` in Network Access

2. **Deploy Backend on Render**
   - New → Web Service → Connect GitHub repo
   - Root directory: `backend`
   - Runtime: **Docker**
   - Build command: *(auto from Dockerfile)*
   - Add environment variables:
     - `MONGO_URI` = your Atlas connection string
     - `MONGO_DB` = `facelock`
     - `CORS_ORIGINS` = your frontend Render URL (e.g. `https://facelock.onrender.com`)
   - Note your backend URL (e.g. `https://facelock-api.onrender.com`)

3. **Deploy Frontend on Render**
   - New → Static Site → Connect same repo
   - Root directory: `frontend`
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`
   - Environment variables:
     - `VITE_WS_URL` = `wss://facelock-api.onrender.com`

4. **CI/CD** (GitHub Actions)
   - Add secrets to your repo:
     - `DOCKER_HUB_USERNAME`, `DOCKER_HUB_TOKEN`
     - `RENDER_API_KEY`, `RENDER_SERVICE_ID`
   - Every push to `main` → auto-deploy

---

### Option B – Railway.app

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login

# Backend
cd backend
railway init
railway add --plugin mongodb
railway up

# Note your backend URL, then deploy frontend
cd ../frontend
railway init
railway up
```

---

### Option C – AWS EC2

```bash
# On your EC2 instance (Ubuntu 22.04, t3.medium minimum for dlib)
sudo apt update && sudo apt install -y docker.io docker-compose git
git clone https://github.com/YOUR_USERNAME/facelock.git
cd facelock

# Edit docker-compose.yml: set MONGO_URI, CORS_ORIGINS, VITE_WS_URL
docker compose -f docker-compose.yml up -d --build

# Nginx reverse proxy (optional but recommended)
sudo apt install -y nginx certbot python3-certbot-nginx
# Configure /etc/nginx/sites-available/facelock ...
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check + face count |
| `GET` | `/api/faces` | List all known person names |
| `POST` | `/api/faces/enroll` | Enroll from static image upload |
| `DELETE` | `/api/faces/{name}` | Remove a person |
| `WS` | `/ws/stream` | Live video stream |

### WebSocket Protocol

**Client → Server (binary):** raw JPEG bytes of a video frame

**Client → Server (text JSON):**
```json
{ "type": "save_face", "faceId": "a1b2c3d4", "name": "Ahmed" }
```

**Server → Client:**
```json
{
  "type": "faces",
  "faces": [
    {
      "id": "a1b2c3d4",
      "name": "Ahmed",
      "box": { "x": 120, "y": 80, "w": 160, "h": 200 },
      "confidence": 0.87
    }
  ]
}
```
```json
{ "type": "save_ack", "success": true, "faceId": "a1b2c3d4", "name": "Ahmed" }
```

---

## Evaluation Criteria Checklist

| Criterion | Implementation |
|---|---|
| ✅ Functionality | WebSocket stream, detect + recognise, green/red boxes |
| ✅ Accuracy | dlib 128-d HOG embeddings, 0.55 cosine threshold |
| ✅ Performance | Back-pressure control, async IO, in-memory embedding cache |
| ✅ Deployment | Docker + Render / Railway / EC2 guides |
| ✅ CI/CD | GitHub Actions: lint → build → push → deploy |
| ✅ Innovation | Confidence %, auto-reconnect WS, REST enroll API, live cache |
