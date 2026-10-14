# AarohaCare Backend

Shared backend for AarohaCare patient mobile and admin/superadmin web.

## Stack
- Node.js + Express 5 + TypeScript
- MongoDB (Mongoose)
- Socket.IO for real-time notifications
- JWT auth (access + refresh)
- Docker & Docker Compose

## Local Setup (Standard)
```bash
cp .env.example .env
npm install
npm run dev
```

API: `http://localhost:4000`  
Health: `http://localhost:4000/api/health`

## Docker Setup

### 1. Using Docker Compose (Recommended for Full Local Stack)
Run the backend along with a containerized MongoDB instance:

```bash
# Copy docker environment template
cp .env.docker.example .env

# Build and start services in detached mode
docker compose up --build -d

# View service logs
docker compose logs -f backend

# Stop services
docker compose down
```

### 2. Standalone Docker Image
Build and run just the backend container (connecting to external MongoDB):

```bash
# Build production Docker image
docker build -t aarohcare-backend:latest .

# Run container
docker run -d \
  --name aarohcare-backend \
  -p 4000:4000 \
  --env-file .env \
  aarohcare-backend:latest
```

## Structure
```
src/
  config/
  constants/
  controllers/
  middleware/
  models/
  routes/
  services/
  types/
  utils/
  server.ts
Dockerfile
docker-compose.yml
.dockerignore
```

## Related repos
- `aarohcare-mobile` — patient app
- `aarohcare-web` — admin + superadmin portal