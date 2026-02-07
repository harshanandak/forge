# Project Instructions

Legacy monolith being migrated to microservices.

## Process

We have a detailed process for feature development:

### Planning Phase
- Requirements gathering
- Technical design document
- Architecture review

### Implementation Phase
- TDD with strict red-green-refactor
- Pair programming for complex features
- Code review by 2+ engineers

### Quality Assurance Phase
- Automated tests (unit, integration, e2e)
- Manual QA testing
- Performance testing
- Security scanning

### Deployment Phase
- Staging deployment
- Smoke tests
- Production deployment
- Monitoring and alerts

## Project Background

This is a 10-year-old monolith handling millions of requests per day. We're gradually extracting microservices while maintaining the legacy system.

## Migration Strategy

- Strangler fig pattern
- API gateway for routing
- Shared database initially, then separate DBs
- Feature flags for gradual rollout
