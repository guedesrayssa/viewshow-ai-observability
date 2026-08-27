# Backend ECS CI/CD runbook

## Resources and trust boundary

- Region/account: `us-east-1` / `248880318395`
- ECR: `monitoracao-api`
- ECS cluster/service: `data-ingestion-cluster` / `monitoracao-api-service`
- Task/container: `monitoracao-api-task` / `monitoracao-api-container`
- ALB/health route: `data-ingestion-alb` / `/health`
- Protected GitLab environment: `aws-lab`
- Docker runner tag: `backend-docker-ephemeral`
- Deployment runner tag: `backend-deploy-protected`

The tagged runner must be ephemeral and restricted to this trusted project. It
must run privileged Docker-in-Docker and share `/certs/client` between the job
and DinD service so Docker 27 uses mutual TLS. Do not attach the tag to a shared
or untrusted runner. Merge-request jobs have no `aws-lab` environment and must
never receive AWS credentials. CI executor and DinD references use immutable
tag-plus-digest identities, and Alpine packages installed at runtime use exact
versions whose installation is verified alongside pipeline policy. Both Docker
jobs also pin the inner `docker-container` driver to
`moby/buildkit:v0.18.2@sha256:86c0ad9d1137c186e9d455912167df20e530bdf7f7c19de802e892bb8ca16552`.

Protect `develop` and configure the three AWS variables as protected, masked,
hidden, raw `env_var` values scoped exactly to `aws-lab`. Never commit a GitLab
token, AWS access key, secret key, or session token.

The deploy tag is a separate activation prerequisite. Provision a
project-locked, protected, non-privileged runner with
`backend-deploy-protected` and `run_untagged = false`; do not attach that tag to
the privileged Docker runner or any shared runner. At the time of this review,
the project has no project runner and only shared instance runner `100`, so
`deploy_backend` is intentionally expected to remain pending until this runner
is provisioned. Never remove the tag or add an untagged/shared fallback to make
the job start.

The `voclabs` role must allow the deployment reads and mutations described by
the pipeline. It must also allow `iam:SimulatePrincipalPolicy`; deploy preflight
simulates `iam:PassRole` with
`iam:PassedToService=ecs-tasks.amazonaws.com` for every live task/execution role.

## After every AWS Academy lab renewal

1. Copy the renewed lab credentials into AWS CLI profile `default`.
2. Ensure the profile has no configured endpoint URL or custom `services`
   section and no `AWS_ENDPOINT_URL*` environment variables are set.
3. Verify `aws sts get-caller-identity` returns account `248880318395` and an
   assumed-role ARN matching `assumed-role/voclabs/<session>`.
4. Authenticate once with
   `glab auth login --hostname git.inteli.edu.br` using variable-management
   access.
5. Run `scripts/sync-aws-gitlab-credentials.sh --dry-run`.
6. After checking the dry-run, run
   `scripts/sync-aws-gitlab-credentials.sh` from a trusted local checkout.

The synchronizer is the safe migration procedure for older variables scoped
`*`: it selects that exact old scope, moves it to `aws-lab`, writes the renewed
value over standard input, then re-reads metadata without printing values. It
requires exactly one absent, `*`, or `aws-lab` entry per key and rejects
ambiguous entries. After all writes it verifies all three keys are protected,
masked, hidden, raw, type `env_var`, and scoped `aws-lab`.

GitLab does not support setting `hidden` through variable update or API PUT.
Existing variables must already be hidden; update/migration omits that field and
the post-write metadata read proves GitLab preserved `hidden=true`. Only creation
uses the supported `--hidden` flag. Dry-run stops before exporting credentials.

Only an authorized operator should run the non-dry command. Never run it from CI
or from this implementation/review workflow. A partial-update error names the
completed keys without revealing values; resolve the failure and rerun the
whole synchronizer.

## Normal deployment

A covered change pushed to protected `develop` runs tests, checks that
`CI_COMMIT_SHA` equals the checkout HEAD, and always rebuilds the amd64 image
locally with registry cache. If `monitoracao-api:$CI_COMMIT_SHA` already exists,
the publisher pulls its immutable digest and compares its exact image ID/rootfs
identity with the local build; an identical retry reuses the digest, while any
difference fails without pushing. If the SHA tag is absent on both the initial
and immediate pre-push reads, the publisher pushes once, captures the digest from
that push, and requires the tag's immediate ECR resolution to match. Revision
inspection and container smoke use only the resulting immutable
`repository@sha256:<digest>` reference. Every ECR reconciliation also requires
the digest media type to be a single Docker v2 or OCI image manifest, never a
Docker manifest list or OCI index. The digest-pulled image must inspect as exact
`linux/amd64` before publication metadata is emitted.

Deploy additionally resolves `refs/heads/develop` from the checkout's existing
`origin` with `git ls-remote --exit-code` before making any AWS request and
again immediately before the first mutation. A network/authentication error,
missing ref, malformed response, or remote SHA different from `CI_COMMIT_SHA`
fails closed. The command's diagnostic output is suppressed so a credential in
the configured origin URL cannot be echoed to the job log.

The publish job marks `aws-lab` with environment action `prepare`, so scoped
variables are available without recording a false deployment. It publishes
`backend-image.env` as both a normal artifact and a dotenv report. Deploy reads
the downloaded regular, non-symlink artifact directly, requires exactly one
canonical digest line, and rejects a conflicting `BACKEND_IMAGE_DIGEST`
environment value. It then checks its checkout HEAD, compares the tag's live
digest with the artifact, and renders `repository@sha256:<digest>` into the task
definition. ECS never receives a mutable tag reference.

Before snapshot or mutation, deploy waits for the existing service to stabilize
and requires one PRIMARY/COMPLETED deployment, no pending tasks, running equal
to desired, the 100/200 rolling configuration, the expected target group, and
an active public application ALB. The effective priority-ordered rule on its exact
HTTP port 80 listener must route `/health` exclusively to that target group;
only literal `/health`, `/health*`, `/*`, or the default rule are accepted as
provable matches, while ambiguous patterns, shadowing rules, and weighted
multi-target forwarding fail closed. Any host-header or path-pattern condition
using `RegexValues` also fails closed, including a higher-priority regex rule
that could shadow an otherwise valid default. Immediately before registration,
deploy re-reads the service and requires the same stable task definition,
100/200 configuration, and exact
`(targetGroupArn, containerName, containerPort)` load-balancer tuple. The
rollback task definition is read both during initial
preflight and immediately before mutation; both reads must identify the same
revision with status `ACTIVE` and no `deleteRequestedAt` value. `INACTIVE`,
`DELETE_IN_PROGRESS`, deletion-requested, or changed revisions are rejected.
The live task definition must also resolve to Linux/X86_64;
an absent `operatingSystemFamily` or `cpuArchitecture` is accepted only because
ECS documents `LINUX` and `X86_64` as their respective defaults. Explicit ARM64
or Windows runtime settings fail before registration. Deploy then registers a
preserved live task definition, updates the service, waits with bounded signal
handling, and re-proves the same strict single-deployment stable-service
predicate after the forward waiter. Rollback uses the same predicate after its
waiter; failure to prove it is reported without replacing the original deploy
exit status. The in-container smoke bounds both the initial request and final
response-body read, so a server that sends headers but never completes the body
cannot hang the job. Public `/health` is then verified separately.

Merge requests run only tests and a local amd64 container build/smoke. Runtime
source, package manifests, Docker inputs, backend tests, CI helpers, the
credential synchronizer, and `.gitlab-ci.yml` select backend CI. Runbook,
deployment snapshot, and other documentation-only changes do not publish or
deploy an image. Portable root-anchored `.gitignore` rules exclude
`/.superpowers/` and `/docs/superpowers/` review artifacts without ignoring
similarly named directories elsewhere.

## Failure recovery

### Credentials expire after variables were updated

If the lab expires after synchronization, do not reuse or manually copy the old
values. Start the lab, refresh profile `default`, rerun dry-run and the complete
synchronizer, then retry only the failed/newest pipeline. If expiration happened
after `update-service`, first inspect the service and follow the unconfirmed
rollback procedure below.

### Rollback cannot be confirmed

The job retains its original failure and reports that rollback was not
confirmed. Do not start another deployment. With renewed credentials, wait for
the resource group job to finish and inspect `describe-services`, its
deployments/events, desired/running/pending counts, the attached task definition,
target health, and `/ecs/monitoracao-api` logs. Explicitly restore the recorded
old task definition only after confirming it is the intended stable revision;
wait for stability and verify `/health` before retrying CI.

### Stale or resource-group jobs

`conservative` auto-cancel removes obsolete pipelines while only interruptible
pre-deploy work is active. A running deploy is non-interruptible and protected
by resource group `monitoracao-api-service`; let it finish or roll back.
Configure that resource group with process mode `newest_ready_first`, enable
GitLab's **Prevent outdated deployment jobs** setting, keep `aws-lab` protected,
and disable retries for rollback deployment jobs. These project settings are
defense in depth around the script's two remote-head checks; they do not replace
them. Cancel queued stale deploy jobs only after confirming no deploy is
running, then retain the newest eligible pipeline. Never bypass the resource
group with a manual `update-service` merely to unblock the queue.

### Digest mismatch

A mismatch means the publication artifact and live SHA tag do not identify the
same manifest. Do not retag, overwrite the commit tag, edit the dotenv artifact,
or deploy by tag. Compare ECR `describe-images` output with the publish job,
confirm the full commit SHA and account/region/repository bindings, then rebuild
from the intended commit through a fresh pipeline. A pre-existing SHA tag whose
digest-pulled image identity differs from the local rebuild is rejected before
push and must be escalated as a supply-chain incident. Treat a manifest list,
OCI index, non-linux/amd64 pulled image, or non-Linux/X86_64 ECS runtime as the
same fail-closed provenance condition.

### Build cache failure

The mutable `buildcache` reference is never a deployment identity. First retry
to rule out a transient registry error. If the cache manifest is confirmed
corrupt, an authorized operator may delete only the `buildcache` ECR image (not
any full-SHA image), then retry so Buildx performs a clean amd64 build and
recreates cache metadata. Verify the resulting container smoke and digest before
deploying.

### Termination during a waiter

INT/TERM sends TERM to the managed AWS waiter, waits a short bounded grace,
then KILLs and reaps it if necessary. A forward interruption reaches rollback;
a rollback interruption reports unconfirmed rollback. The pipeline's original
exit status is retained in both cases.

## Future OIDC migration

If an administrator creates the GitLab OIDC provider and a least-privilege AWS
role, replace the three stored AWS variables with a GitLab ID token and
`sts:AssumeRoleWithWebIdentity`. Build, digest publication, deploy, health, and
rollback contracts remain unchanged.
