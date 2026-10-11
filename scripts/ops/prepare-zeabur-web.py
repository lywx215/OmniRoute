#!/usr/bin/env python3
"""Prepare a commit-only Zeabur Web ZIP; credentials and deployment are separate."""

import argparse
import hashlib
import json
import re
import shlex
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REQUIRED = (
    "package.json",
    "package-lock.json",
    "scripts/build/postinstall.mjs",
    "scripts/build/postinstallSupport.mjs",
    "scripts/build/native-binary-compat.mjs",
    "src/lib/env/runtimeEnv.ts",
    "src/app/api/system/env/repair/route.ts",
    "src/app/.well-known/agent.json/route.ts",
    "src/app/.well-known/agent-card.json/route.ts",
)
SOURCE_ROOTS = {"src", "open-sse", "scripts", "public", "config", "bin", "dev",
                "packages", "@omniroute"}
RESTORE = "scripts/ops/zeabur-source-restore.tar"


def validate_policy(policy, lock):
    if not re.fullmatch(r"[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}", policy["browserImage"]):
        raise ValueError("Browser image must be pinned to a SHA-256 digest")
    if not re.fullmatch(r"[0-9]+", policy["chromiumRevision"]):
        raise ValueError("Invalid Chromium revision")
    if not re.fullmatch(r"[0-9.]+", policy["chromiumVersion"]):
        raise ValueError("Invalid Chromium version")
    for name in ("playwright", "playwright-core"):
        version = lock["packages"]["node_modules/" + name]["version"]
        if version != policy["playwrightVersion"]:
            raise ValueError(f"{name} {version} differs from verified browser baseline; "
                             "verify a new donor image and update config/deploy/zeabur-web.json")


def make_restore(root):
    paths = sorted(p for p in root.rglob("*") if p.is_file()
                   and p.relative_to(root).parts[0] in SOURCE_ROOTS
                   and any(part == "env" or part.startswith(".")
                           for part in p.relative_to(root).parts[:-1]))
    if any(p.is_symlink() for p in root.rglob("*")):
        raise ValueError("Build context contains symlinks; review archive semantics first")
    target = root / RESTORE
    target.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(target, "w") as archive:
        for file in paths:
            archive.add(file, arcname=file.relative_to(root).as_posix())
    return [p.relative_to(root).as_posix() for p in paths]


def patch_dockerfile(text, policy, commit, restore_paths):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Expected a resolved Git commit")
    if "FROM runner-base AS runner-web" not in text or text.count("COPY . ./\n") != 1:
        raise ValueError("Dockerfile layout changed; review the Zeabur adaptation")
    old = "npm ci --include=optional"
    if text.count(old) != 1:
        raise ValueError("Dockerfile dependency install changed; review dev-dependency inclusion")
    text = text.replace(old, "npm ci --include=dev --include=optional", 1)
    if any("\n" in path or "\r" in path for path in restore_paths):
        raise ValueError("Source path contains a Dockerfile line break")
    checks = "".join(f" \\\n  && test -f {shlex.quote(path)}" for path in restore_paths)
    text = text.replace("COPY . ./\n", "COPY . ./\n"
                        f"RUN tar -xf {RESTORE} -C /app \\\n  && rm {RESTORE}" + checks + "\n", 1)
    return text + f"""
# Zeabur Web: application from this commit; matching browser binaries from a pinned image.
FROM {policy['browserImage']} AS zeabur-browser-assets
FROM runner-base AS zeabur
USER root
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright
COPY --from=zeabur-browser-assets /home/node/.cache/ms-playwright /home/node/.cache/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node node_modules/playwright/cli.js install-deps chromium \\
  && apt-get install -y --no-install-recommends xvfb \\
  && chown -R node:node /home/node/.cache \\
  && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.revision="{commit}"
USER node
RUN node -e "(async()=>{{const fs=require('node:fs');const {{chromium}}=require('playwright');const spec=require('./node_modules/playwright-core/browsers.json').browsers.find(b=>b.name==='chromium');if(spec.revision!=='{policy['chromiumRevision']}'||!fs.existsSync(chromium.executablePath()))throw new Error('Browser revision mismatch');const b=await chromium.launch({{headless:true,timeout:15000}});try{{if(b.version()!=='{policy['chromiumVersion']}')throw new Error('Browser version mismatch');}}finally{{await b.close();}}}})().catch(e=>{{console.error(e.name);process.exitCode=1;}});"
"""


def write_zip(root, target):
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(root.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(root).as_posix())
    with zipfile.ZipFile(target) as archive:
        missing = set(REQUIRED + (RESTORE,)) - set(archive.namelist())
        if missing:
            raise ValueError("Required build files missing from ZIP: " + ", ".join(sorted(missing)))
        if archive.testzip() is not None:
            raise ValueError("ZIP integrity check failed")


def prepare(repo, ref, output, policy):
    repo = repo.resolve()
    output = output.resolve()
    if output == repo or output.is_relative_to(repo):
        raise ValueError("Output must be outside the repository")
    if output.exists():
        raise ValueError("Output already exists; choose a new directory")
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"],
        cwd=repo, text=True
    ).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Expected a resolved Git commit")
    with tempfile.TemporaryDirectory(prefix="zeabur-context-") as staging:
        staging = Path(staging)
        source = staging / "source"
        source.mkdir()
        tar = staging / "source.tar"
        with tar.open("wb") as stream:
            subprocess.run(["git", "archive", "--format=tar", commit], cwd=repo,
                           stdout=stream, check=True)
        with tarfile.open(tar) as archive:
            archive.extractall(source, filter="data")
        validate_policy(policy, json.loads((source / "package-lock.json").read_text()))
        original_dockerfile = (source / "Dockerfile").read_text()
        filtered = staging / "filtered"
        subprocess.run(["docker", "build", "--file", "-", "--output",
                        "type=local,dest=" + str(filtered), str(source)],
                       input="FROM scratch\nCOPY . /\n", text=True, check=True)
        for name in REQUIRED:
            if not (filtered / name).is_file():
                raise ValueError("Build context missing " + name)
        for file in filtered.rglob("*"):
            relative = file.relative_to(filtered)
            if file.is_file() and ("node_modules" in relative.parts
                                   or ".git" in relative.parts
                                   or relative.parts[0].startswith("_")
                                   or file.name == ".env"
                                   or (file.name.startswith(".env.")
                                       and not file.name.endswith(".example"))):
                raise ValueError("Private/local artifact found in context: " + str(relative))
        restored = make_restore(filtered)
        dockerfile = patch_dockerfile(original_dockerfile, policy, commit, restored)
        (filtered / "Dockerfile").write_text(dockerfile)
        # A non-hidden Dockerfile-specific ignore file survives upload preprocessing.
        (filtered / "Dockerfile.dockerignore").write_bytes((source / ".dockerignore").read_bytes())
        original_files = {p.relative_to(filtered).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in filtered.rglob("*") if p.is_file()
                          and (source / p.relative_to(filtered)).is_file()
                          and p.name != "Dockerfile"}
        for name, digest in original_files.items():
            if hashlib.sha256((source / name).read_bytes()).hexdigest() != digest:
                raise ValueError("Source changed during preparation: " + name)
        output.mkdir(parents=True, mode=0o700)
        package = output / "source.zip"
        write_zip(filtered, package)
        (output / "Dockerfile").write_text(dockerfile)
        manifest = {"commit": commit, "version": json.loads((source / "package.json").read_text())["version"],
                    "browser": policy, "restoredPaths": restored,
                    "sourceFileSha256": original_files,
                    "zipSha256": hashlib.sha256(package.read_bytes()).hexdigest(),
                    "zipBytes": package.stat().st_size}
        (output / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return {key: value for key, value in manifest.items() if key != "sourceFileSha256"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True, help="Reviewed committed Git ref to package")
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, required=True, help="New directory outside repo")
    parser.add_argument("--policy", type=Path, default=ROOT / "config/deploy/zeabur-web.json")
    args = parser.parse_args()
    try:
        report = prepare(args.repo, args.ref, args.output, json.loads(args.policy.read_text()))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, "Preparation failed: " + str(error) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
