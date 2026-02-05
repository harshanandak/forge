# Project Instructions

This is an e-commerce platform built with Next.js and Stripe integration.

## Domain Knowledge

- Multi-tenant architecture with separate databases per tenant
- Stripe webhooks handle subscription lifecycle
- Redis caching for product catalog
- JWT authentication with refresh tokens

## Architecture

- Frontend: Next.js with App Router
- Backend: Next.js API routes + Prisma ORM
- Database: PostgreSQL with row-level security
- Cache: Redis for sessions and product data

## Coding Standards

- Use TypeScript strict mode
- All functions must have JSDoc comments
- Prefer composition over inheritance
- Test coverage minimum 80%

## Build Commands

```bash
npm install
npm run dev
npm run build
npm test
```
