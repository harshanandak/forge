---
title: {{title}}
description: {{description}}
category: deployment
version: 1.0.0
author: {{author}}
created: {{created}}
updated: {{updated}}
tags:
  - deployment
  - ci-cd
  - devops
---

# {{title}}

## Purpose

This deployment skill guides you through CI/CD pipelines, deployment strategies, and production best practices for reliable releases.

## When to Use

- User asks to set up CI/CD pipeline
- User needs deployment automation
- User wants to implement blue-green or canary deployments
- User requests production readiness checklist
- User needs rollback or disaster recovery plan

## Instructions

### Phase 1: Pre-Deployment Checklist

#### Code Quality
- [ ] All tests passing (unit, integration, E2E)
- [ ] Linting and formatting checks pass
- [ ] Security scans clean (no critical vulnerabilities)
- [ ] Code review approved
- [ ] Documentation updated

#### Configuration
- [ ] Environment variables configured
- [ ] Secrets stored securely (not in code)
- [ ] Database migrations tested
- [ ] Feature flags configured
- [ ] Monitoring and alerts set up

#### Infrastructure
- [ ] Resources provisioned (servers, databases, storage)
- [ ] DNS and load balancers configured
- [ ] SSL certificates valid
- [ ] Backup and disaster recovery tested
- [ ] Scaling policies defined

### Phase 2: CI/CD Pipeline Design

```yaml
# Example: GitHub Actions workflow
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npm test
      - name: Security scan
        run: npm audit
      - name: Build
        run: npm run build

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: |
          # Deployment commands
      - name: Health check
        run: |
          # Verify deployment
      - name: Notify team
        run: |
          # Slack/Discord notification
```

### Phase 3: Deployment Strategies

#### Strategy 1: Rolling Deployment
- Update instances gradually (one at a time)
- Zero downtime
- Easy rollback (just deploy previous version)
- **Best for**: Stateless applications

#### Strategy 2: Blue-Green Deployment
- Run two identical environments (blue = current, green = new)
- Switch traffic from blue to green
- Instant rollback (switch back to blue)
- **Best for**: Critical applications needing instant rollback

#### Strategy 3: Canary Deployment
- Deploy to small subset of users (1-10%)
- Monitor metrics (errors, latency, business KPIs)
- Gradually increase traffic if healthy
- **Best for**: High-risk changes, A/B testing

#### Strategy 4: Feature Flags
- Deploy code without enabling features
- Enable features for specific users/segments
- Instant on/off without redeployment
- **Best for**: Gradual rollouts, experimentation

### Phase 4: Deployment Execution

1. **Pre-deployment**:
   ```bash
   # Backup database
   pg_dump mydb > backup_$(date +%Y%m%d_%H%M%S).sql

   # Tag release
   git tag v1.2.3
   git push origin v1.2.3
   ```

2. **Deploy**:
   ```bash
   # Build artifacts
   npm run build

   # Run database migrations
   npm run migrate

   # Deploy to servers
   rsync -avz dist/ user@server:/app/

   # Restart services
   pm2 restart all
   ```

3. **Post-deployment verification**:
   ```bash
   # Health check
   curl https://api.example.com/health

   # Smoke tests
   npm run test:smoke

   # Monitor errors
   tail -f /var/log/app/error.log
   ```

4. **Rollback (if needed)**:
   ```bash
   # Deploy previous version
   git checkout v1.2.2
   npm run build
   npm run deploy

   # Or use platform-specific rollback
   vercel rollback
   heroku rollback
   ```

### Phase 5: Monitoring & Observability

#### Key Metrics to Monitor
- **Availability**: Uptime, response times
- **Performance**: Latency (p50, p95, p99), throughput
- **Errors**: Error rates, exception types
- **Business**: Conversion rates, user signups, revenue

#### Alerting Rules
```yaml
# Example: Alert configuration
alerts:
  - name: High Error Rate
    condition: error_rate > 5%
    duration: 5 minutes
    severity: critical
    actions:
      - slack: #incidents
      - pagerduty: oncall

  - name: Slow Response Time
    condition: p95_latency > 1000ms
    duration: 10 minutes
    severity: warning
    actions:
      - slack: #eng-team
```

### Phase 6: Production Best Practices

1. **Immutable Infrastructure**: Never modify running servers, always deploy fresh
2. **Version Everything**: Code, config, infrastructure as code
3. **Automated Rollbacks**: Trigger automatically on health check failures
4. **Gradual Rollouts**: Start with 1% traffic, increase gradually
5. **Monitor Everything**: Logs, metrics, traces, user behavior
6. **Practice Failure**: Chaos engineering, disaster recovery drills

## Tools Required

- CI/CD platform: GitHub Actions, GitLab CI, CircleCI, Jenkins
- Cloud provider: AWS, GCP, Azure, Vercel, Netlify
- Monitoring: Datadog, New Relic, Sentry, CloudWatch
- Secrets management: Vault, AWS Secrets Manager, 1Password

## Examples

### Example 1: Zero-Downtime Deployment
```bash
# 1. Deploy new version to separate instances
deploy_new_version v1.2.3

# 2. Health check
wait_for_healthy v1.2.3

# 3. Route 10% traffic to new version
route_traffic v1.2.3 --percent=10

# 4. Monitor for 5 minutes
monitor --duration=5m --fail-on-errors

# 5. Gradually increase traffic
route_traffic v1.2.3 --percent=50
monitor --duration=5m
route_traffic v1.2.3 --percent=100

# 6. Decommission old version
decommission v1.2.2
```

### Example 2: Database Migration
```bash
# 1. Backup database
create_backup production_db

# 2. Run migration (non-breaking change first)
run_migration add_column_nullable

# 3. Deploy new code (uses new column)
deploy v1.2.3

# 4. Verify deployment
verify_deployment

# 5. Run cleanup migration (remove old column)
run_migration remove_old_column
```

## Success Criteria

- [ ] Deployment completes successfully
- [ ] Health checks pass (200 OK, response time < 500ms)
- [ ] No increase in error rates
- [ ] Performance metrics stable (latency, throughput)
- [ ] Database migrations applied
- [ ] Monitoring and alerts active
- [ ] Rollback plan tested and ready
- [ ] Team notified of deployment

## Related Skills

- ci-cd-setup: For pipeline configuration
- infrastructure-as-code: For Terraform, CloudFormation
- monitoring-setup: For observability
- incident-response: For handling production issues
