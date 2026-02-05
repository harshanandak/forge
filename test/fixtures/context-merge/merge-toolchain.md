# Project Instructions

Mobile app backend for food delivery.

## Toolchain

- **Sentry**: Error tracking and performance monitoring
- **Datadog**: Infrastructure monitoring
- **GitHub Actions**: CI/CD pipelines
- **Docker**: Containerization

## Quick Start

```bash
# Install dependencies
npm install

# Setup local database
docker-compose up -d postgres redis

# Run migrations
npm run migrate

# Start development
npm run dev
```

## Domain Knowledge

- Order state machine: pending → confirmed → preparing → ready → delivered
- Real-time updates via WebSocket (Socket.io)
- Geospatial queries for restaurant search
