#!/usr/bin/env python3
"""Submit a prepared ZIP once, or inspect the recorded upload without resubmitting."""

import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path


SHARED_TOOL = Path("/Users/andyliu/Developer/work/zeaburcli/zeaburctl.py")
DEPLOYMENTS_QUERY = """query PreparedUpload($s:ObjectID!,$e:ObjectID!) {
  service(_id:$s) { name status }
  deployments(serviceID:$s,environmentID:$e,perPage:50) {
    edges { node { _id uploadID status createdAt startedAt finishedAt } }
  }
}"""
RUNTIME_QUERY = """query PreparedRuntime($p:ObjectID!,$s:ObjectID!,$e:ObjectID!,$d:ObjectID!) {
  runtimeLogs(projectID:$p,serviceID:$s,environmentID:$e,deploymentID:$d) {
    timestamp message
  }
}"""


def load_tool(path):
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("zeaburctl", path)
    if not spec or not spec.loader:
        raise ValueError("Shared Zeabur tool unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_package(directory):
    manifest = json.loads((directory / "release-manifest.json").read_text())
    blob = (directory / "source.zip").read_bytes()
    if not re.fullmatch(r"[a-f0-9]{40}", manifest["commit"]):
        raise ValueError("Invalid source commit in release manifest")
    if (hashlib.sha256(blob).hexdigest() != manifest["zipSha256"]
            or len(blob) != manifest["zipBytes"]):
        raise ValueError("Package differs from release manifest")
    return manifest, blob


def write_record(path, record, *, exclusive=False):
    # Claim the output before any mutation. A partial/ambiguous attempt must also
    # block another submit, including concurrent invocations and later sessions.
    if exclusive:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(json.dumps(record, indent=2) + "\n")
        return
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(json.dumps(record, indent=2) + "\n")
    os.replace(temporary, path)


def submit(directory, alias, tool):
    state = directory / "submission.json"
    if state.exists():
        raise ValueError("Submission already recorded; use status instead of submitting again")
    manifest, blob = read_package(directory)
    profile = tool.get_project(alias)
    before = tool.snapshot(profile)
    if before["service"]["_id"] != profile["service_id"]:
        raise ValueError("Target service mismatch")
    record = {"alias": alias, "commit": manifest["commit"],
              "zipSha256": manifest["zipSha256"],
              "serviceId": profile["service_id"],
              "environmentId": profile["environment_id"],
              "previousDeploymentId": (before["recent_deployments"] or [{}])[0].get("_id"),
              "submittedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "phase": "creatingUpload"}
    write_record(state, record, exclusive=True)
    try:
        payload = {"content_hash": base64.b64encode(hashlib.sha256(blob).digest()).decode(),
                   "content_hash_algorithm": "sha256", "content_length": len(blob)}
        _, raw = tool.request("POST", tool.API_ORIGIN + "/v2/upload", token=tool.api_token(),
                              data=json.dumps(payload).encode(),
                              headers={"Content-Type": "application/json"})
        stage = json.loads(raw)
        upload_id, url = stage["upload_id"], stage["presign_url"]
        method = stage.get("presign_method", "PUT")
        if (not re.fullmatch(r"[a-f0-9]{24}", upload_id)
                or not url.startswith("https://") or method not in {"PUT", "POST"}):
            raise ValueError("Invalid pre-signed upload response")
        record.update(uploadId=upload_id, phase="uploadCreated")
        write_record(state, record)
        print(json.dumps(record), flush=True)
        # Do not send the API token to the pre-signed object-storage endpoint.
        tool.request(method, url, data=blob, headers=stage.get("presign_header") or {}, timeout=120)
        record["phase"] = "prepareRequested"
        write_record(state, record)
        print(json.dumps(record), flush=True)
        prepare = {"upload_type": "existing_service", "service_id": profile["service_id"],
                   "environment_id": profile["environment_id"]}
        code, _ = tool.request("POST", tool.API_ORIGIN + "/v2/upload/"
                               + urllib.parse.quote(upload_id, safe="") + "/prepare",
                               token=tool.api_token(), data=json.dumps(prepare).encode(),
                               headers={"Content-Type": "application/json"}, timeout=30)
        record.update(phase="prepareAcknowledged", httpStatus=code)
    except Exception as error:
        # Shared-tool errors can contain API bodies and pre-signed URLs. Record
        # only the exception class; never print its potentially sensitive text.
        record.update(phase=record["phase"] + "Unconfirmed", errorType=type(error).__name__)
        write_record(state, record)
        print(json.dumps(record), flush=True)
        return 2
    write_record(state, record)
    print(json.dumps(record), flush=True)
    return 0


def timestamp(value):
    try:
        return datetime.datetime.fromisoformat(str(value or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("-inf")


def recent_build_logs(tool, profile, deployment_id, limit):
    rows = sorted(tool.fetch_logs(profile, "build", deployment_id),
                  key=lambda row: timestamp(row.get("timestamp")))
    result = []
    for row in rows[-limit:]:
        message = str(row.get("message", ""))
        message = re.sub(r"--mount=type=secret,\S+\s*", "", message)
        message = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[redacted]", message)
        message = re.sub(r"(?i)(Bearer\s+)\S+", r"\1[redacted]", message)
        result.append({"timestamp": row.get("timestamp"), "message": message})
    return result


def runtime_summary(tool, profile, deployment):
    boundary = timestamp(deployment.get("startedAt") or deployment.get("createdAt"))
    if boundary == float("-inf"):
        raise ValueError("Deployment start time unknown; cannot distinguish old runtime logs")
    rows = tool.graphql(RUNTIME_QUERY, {"p": profile["project_id"],
                                       "s": profile["service_id"],
                                       "e": profile["environment_id"],
                                       "d": deployment["_id"]})["runtimeLogs"]
    current = sorted((row for row in rows if timestamp(row.get("timestamp")) >= boundary),
                     key=lambda row: timestamp(row.get("timestamp")))
    # Report only the returned window and its age; never expose runtime request
    # bodies or credentials. This summary is not a health or inference verdict.
    return {"deploymentId": deployment["_id"], "returnedRows": len(rows),
            "currentRows": len(current), "excludedOlderOrUndatedRows": len(rows) - len(current),
            "firstTimestamp": current[0]["timestamp"] if current else None,
            "latestTimestamp": current[-1]["timestamp"] if current else None}


def status(directory, alias, tool, logs=0, runtime=False):
    state = directory / "submission.json"
    record = json.loads(state.read_text())
    profile = tool.get_project(alias)
    if (record["serviceId"] != profile["service_id"]
            or record["environmentId"] != profile["environment_id"]):
        raise ValueError("Recorded submission and alias target differ")
    if not record.get("uploadId"):
        raise ValueError("Upload ID unknown; inspect the target before preparing another submission")
    data = tool.graphql(DEPLOYMENTS_QUERY, {"s": profile["service_id"],
                                          "e": profile["environment_id"]})
    rows = [edge["node"] for edge in data["deployments"]["edges"]]
    match = next((row for row in rows if row.get("uploadID") == record["uploadId"]), None)
    if match:
        record.update(deploymentId=match["_id"], deploymentStatus=match["status"])
        write_record(state, record)
    evidence = {"service": data["service"], "uploadId": record["uploadId"],
                "deployment": match, "latest": rows[0] if rows else None}
    if match and logs > 0:
        evidence["buildLogs"] = recent_build_logs(tool, profile, match["_id"], logs)
    if match and runtime:
        evidence["runtimeSummary"] = runtime_summary(tool, profile, match)
    print(json.dumps(evidence))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("submit", "status"))
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--alias", required=True)
    parser.add_argument("--shared-tool", type=Path, default=SHARED_TOOL)
    parser.add_argument("--logs", type=int, default=0, help="Newest build log lines for status")
    parser.add_argument("--runtime-summary", action="store_true",
                        help="Inspect this deployment's runtime log timestamps without messages")
    args = parser.parse_args()
    try:
        # Prevent duplicate attempts even before loading credentials or making a
        # read request; mutation still uses an exclusive file-create below.
        if args.mode == "submit" and (args.package_dir / "submission.json").exists():
            print("Submission already recorded; use status instead of submitting again", file=sys.stderr)
            return 1
        tool = load_tool(args.shared_tool)
        if args.mode == "submit":
            return submit(args.package_dir, args.alias, tool)
        return status(args.package_dir, args.alias, tool, logs=args.logs, runtime=args.runtime_summary)
    except Exception as error:
        # Deliberately avoid upstream exception messages (they may contain URLs).
        print("Zeabur operation could not be confirmed: " + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
