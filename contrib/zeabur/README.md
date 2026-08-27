# Zeabur production deployment for this fork

This fork publishes a single `runner-base` image on `linux/amd64`. GitHub Actions
does the memory-intensive source build; Zeabur only pulls the image and runs it.
The only automatic release source is the `production` branch.

## Release model

- Track upstream releases on `release/v*` branches and keep fork-specific work on
  short-lived branches.
- Review upstream and custom changes in pull requests before merging them into
  the protected `production` branch.
- A `production` push builds
  `ghcr.io/lywx215/omniroute:sha-<full-40-character-git-sha>`. The workflow checks
  for that tag first and never deliberately overwrites an existing SHA tag.
- The inherited upstream Docker publisher is restricted to the canonical
  `diegosouzapw` namespace, so syncing an upstream release into this fork does
  not require upstream Docker Hub credentials.

The workflow can be run manually from another branch to test only the image
build. It updates Zeabur only when the selected ref is `production`.

## One-time Zeabur service setup

Create a **Docker Image / Prebuilt** service once. Do not configure Zeabur to
build this repository from source.

First merge or push the intended revision to `production` without Zeabur
secrets. The workflow will build the image and safely skip deployment. Then
either configure the service in the dashboard or copy
[`template.example.yaml`](./template.example.yaml), replace its
`REPLACE_WITH_FULL_40_CHARACTER_GIT_SHA` token with the SHA tag reported by the
workflow, and deploy that rendered copy. Zeabur does not document variable
expansion inside `source.image`, so the checked-in template deliberately does
not use an `${IMAGE_TAG}` placeholder.

1. Select an initial image such as
   `ghcr.io/lywx215/omniroute:sha-<full-40-character-git-sha>`. Make the GHCR
   package public, or configure Zeabur with read credentials for a private
   package.
2. Do not override the image entrypoint or command. `runner-base` starts the
   standalone server as the non-root `node` user (UID/GID 1000).
3. Add one HTTP port named `web` on container port `20128`, then bind the custom
   domain with HTTPS enabled.
4. Add one persistent volume named `data` at `/app/data`. Confirm it is writable
   by UID 1000 before storing production data.
5. Keep exactly **one replica** and disable autoscaling. The default SQLite
   database (`/app/data/storage.sqlite`) is a single-writer deployment.
6. Configure an HTTP health check on port `web`, path `/healthz`. If the platform
   exposes the knobs, use a 15-second startup grace, 30-second interval,
   5-second timeout, and 3 failures. Use at least 40 seconds for graceful stop.
7. Import the names from [`.env.example`](./.env.example), replace the example
   domain everywhere, and enter the four blank values only through Zeabur's
   private variable controls. Keep them unexposed and never commit their values.

Generate independent values outside this repository, for example:

```sh
openssl rand -base64 48  # JWT_SECRET
openssl rand -hex 32     # API_KEY_SECRET
openssl rand -hex 32     # STORAGE_ENCRYPTION_KEY
```

Use a separate strong random value for `INITIAL_PASSWORD`. Keep a recoverable
backup of `STORAGE_ENCRYPTION_KEY`; losing it makes encrypted stored credentials
unrecoverable. After first login, create a least-privilege API key in the
dashboard rather than setting the all-powerful `OMNIROUTE_API_KEY` environment
variable.

For an existing data volume, the persisted feature-flag value takes precedence
over the matching environment variable. Verify in Dashboard -> Feature Flags
after every migration that API-key enforcement is enabled and that proxy auto
selection and direct-fallback flags remain disabled.

## Domain and WebSocket routing

Expose only port `20128`. The internal live server remains on
`127.0.0.1:20132`; the standalone HTTP server forwards WebSocket upgrades at
the same-origin path `/live-ws`.

For a domain such as `omniroute.example.com`, use exactly:

```text
NEXT_PUBLIC_BASE_URL=https://omniroute.example.com
OMNIROUTE_PUBLIC_BASE_URL=https://omniroute.example.com
LIVE_WS_PUBLIC_URL=wss://omniroute.example.com/live-ws
LIVE_WS_ALLOWED_ORIGINS=https://omniroute.example.com
```

Do not add a trailing slash to the allowed origin. Zeabur's public HTTP endpoint
must pass `Upgrade`, `Connection`, `Host`, `Origin`, and
`X-Forwarded-Proto: https`. Do not expose port `20132` separately.

## GitHub-to-Zeabur handoff

In the GitHub environment named `production`, add these repository secrets:

- `ZEABUR_TOKEN`: a token dedicated to this deployment, with the least access
  Zeabur permits, used by the CLI.
- `ZEABUR_SERVICE_ID`: the ID of the existing Docker Service whose repository is
  fixed to `ghcr.io/lywx215/omniroute`.

If either secret is absent, the image build and GHCR push still succeed and the
deployment job exits successfully with a notice. When both are present, the
workflow pins Zeabur CLI `0.21.0` and changes only the existing service's image
tag to `sha-${GITHUB_SHA}`. The deploy step authenticates non-interactively from
`ZEABUR_TOKEN`; it does not recreate the service or volume.

For rollback, re-run the tag update against a known-good earlier `sha-*` image.
Do not delete and recreate the service: a replacement service is not guaranteed
to retain the existing volume attachment.

## Upstream synchronization

The local repository has these roles:

```text
origin    https://github.com/lywx215/OmniRoute.git
upstream  https://github.com/diegosouzapw/OmniRoute.git
```

Fetch and inspect upstream without changing production:

```sh
git fetch upstream --prune
git log --oneline --decorate production..upstream/release/vX.Y.Z
```

Integrate the selected upstream release on a dedicated branch, run the project
checks, and merge it through review into `production`. Never make upstream
release branches deploy directly.

## Verification checklist

After a tag update:

- Confirm the Zeabur revision uses the expected full `sha-*` tag and has one
  replica.
- Confirm `GET https://<domain>/healthz` returns HTTP 2xx.
- Confirm logs report `DATA_DIR=/app/data` and
  `SQLITE_FILE=/app/data/storage.sqlite` without permission warnings.
- Log in over HTTPS, create a non-admin API key, and verify an unauthenticated
  `/v1/*` request is rejected.
- Open the live dashboard and confirm a `wss://<domain>/live-ws` connection is
  established through port `20128`.
- Restart the service once and verify users, settings, and API keys remain.

Official references: [Zeabur CLI](https://zeabur.com/docs/en-US/developer/cli),
[Docker image deployment](https://zeabur.com/docs/en-US/deploy/methods/custom-docker-image),
[image tag updates](https://zeabur.com/docs/en-US/deploy/manage/update-image-reference),
[volumes](https://zeabur.com/docs/en-US/operations/data/volumes), and
[health checks](https://zeabur.com/docs/en-US/operations/monitoring/health-checks).
