# Backend ECS CI/CD runbook

## Resources

- Region: `us-east-1`
- ECR: `monitoracao-api`
- ECS cluster/service: `data-ingestion-cluster` / `monitoracao-api-service`
- Task/container: `monitoracao-api-task` / `monitoracao-api-container`
- ALB: `data-ingestion-alb`

## One-time GitLab setup

1. Protect the `develop` branch.
2. Ensure a project runner supports privileged Docker-in-Docker.
3. Authenticate the GitLab CLI:
   `glab auth login --hostname git.inteli.edu.br`.
4. Never commit a GitLab token, AWS access key, secret key, or session token.

## After every AWS Academy lab renewal

1. Copy the renewed lab credentials into AWS CLI profile `default`.
2. Verify `aws sts get-caller-identity` returns account `248880318395`.
3. Run `scripts/sync-aws-gitlab-credentials.sh --dry-run`.
4. Run `scripts/sync-aws-gitlab-credentials.sh`.

The script updates only `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_SESSION_TOKEN` as protected GitLab variables. When these credentials expire,
CI validation can still run, but ECR publication stops before any ECS change.

## Normal deployment

A backend or backend-CI change pushed to protected `develop` runs tests, builds
the image, publishes `monitoracao-api:$CI_COMMIT_SHA`, registers a new task
definition, updates the service, waits for stability, and checks the public
`/health` route. Frontend-only and documentation-only changes do not deploy this
backend.

## Failure recovery

The deploy job records the previous task definition. If ECS stabilization or the
ALB smoke test fails, it restores that revision and leaves the pipeline failed.
Check the failed job, ECS service events, target health, and `/ecs/monitoracao-api`
logs before retrying. Do not force a new deployment with `v1` or `latest`.

## Future OIDC migration

If an administrator creates the GitLab OIDC provider and a least-privilege AWS
role, replace the three stored AWS variables with a GitLab ID token and
`sts:AssumeRoleWithWebIdentity`. Build, push, deploy, health, and rollback steps
remain unchanged.
