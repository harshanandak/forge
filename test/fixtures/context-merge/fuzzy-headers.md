# Project Instructions

Analytics dashboard for SaaS metrics.

## Development Workflow

Our development process:

1. Pick a ticket from Jira
2. Create feature branch
3. Implement and test
4. Code review
5. Deploy to staging
6. QA approval
7. Deploy to production

## Test-Driven Development

We write tests after implementation, not before.

## Commit Conventions

- Use Jira ticket numbers in commits: [PROJ-123] Add feature
- Merge PRs with squash
- Keep commit history clean

## Project Overview

Real-time analytics dashboard showing user engagement, conversion funnels, and revenue metrics.

## Tech Stack

- Frontend: React + Recharts
- Backend: Node.js + Express
- Database: PostgreSQL + TimescaleDB (time-series)
- Queue: BullMQ for background jobs
