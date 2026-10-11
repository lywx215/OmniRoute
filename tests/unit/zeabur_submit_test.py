"""Check ambiguous submissions remain observable without duplicate deployment."""

import contextlib
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("zeabur_submit", ROOT / "scripts/ops/submit-zeabur-web.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeTool:
    API_ORIGIN = "https://api.zeabur.com"

    def __init__(self):
        self.requests = []
        self.prepare_timeout = True
        self.profile = {"service_id": "b" * 24, "environment_id": "c" * 24}

    def get_project(self, alias):
        return self.profile

    def snapshot(self, profile):
        return {"service": {"_id": profile["service_id"]},
                "recent_deployments": [{"_id": "d" * 24}]}

    def api_token(self):
        return "test-token"

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        if url.endswith("/v2/upload"):
            return 200, json.dumps({"upload_id": "a" * 24,
                                    "presign_url": "https://storage.example/upload?secret=private"}).encode()
        if url.endswith("/prepare") and self.prepare_timeout:
            raise TimeoutError("https://storage.example/upload?secret=private")
        return 200, b"{}"

    def graphql(self, query, variables):
        return {"service": {"name": "target", "status": "RUNNING"},
                "deployments": {"edges": [{"node": {"_id": "e" * 24,
                    "uploadID": "a" * 24, "status": "BUILDING", "finishedAt": None}}]}}

    def fetch_logs(self, profile, kind, deployment_id):
        return [{"timestamp": "2026-10-11T02:04:00Z", "message": "newest --mount=type=secret,id=x,env=TEST run https://storage.example/x?secret=private"},
                {"timestamp": "2026-10-11T02:03:00Z", "message": "middle"},
                {"timestamp": "2026-10-11T02:02:00Z", "message": "oldest"}]


class SubmissionRegressionTests(unittest.TestCase):
    def test_runtime_query_targets_deployment_and_excludes_old_or_undated_logs(self):
        class RuntimeTool:
            def graphql(self, query, variables):
                self.query, self.variables = query, variables
                return {"runtimeLogs": [
                    {"timestamp": "2026-10-11T02:04:00Z", "message": "private body"},
                    {"timestamp": "2026-10-10T15:04:15Z", "message": "old shutdown"},
                    {"timestamp": None, "message": "unknown age"},
                    {"timestamp": "2026-10-11T02:03:00.123456789Z", "message": "private token"}
                ]}
        tool = RuntimeTool()
        profile = {"project_id": "a" * 24, "service_id": "b" * 24,
                   "environment_id": "c" * 24}
        deployment = {"_id": "d" * 24, "startedAt": "2026-10-11T02:03:00Z"}
        summary = module.runtime_summary(tool, profile, deployment)
        self.assertIn("deploymentID:$d", tool.query)
        self.assertEqual(tool.variables["d"], deployment["_id"])
        self.assertEqual(summary["currentRows"], 2)
        self.assertEqual(summary["excludedOlderOrUndatedRows"], 2)
        self.assertEqual(summary["latestTimestamp"], "2026-10-11T02:04:00Z")
        self.assertNotIn("private", json.dumps(summary))
        with self.assertRaisesRegex(ValueError, "start time unknown"):
            module.runtime_summary(tool, profile, {"_id": "d" * 24})

    def test_build_logs_are_sorted_by_time_and_signed_queries_are_redacted(self):
        rows = module.recent_build_logs(FakeTool(), {}, "e" * 24, 2)
        self.assertEqual([row["timestamp"] for row in rows],
                         ["2026-10-11T02:03:00Z", "2026-10-11T02:04:00Z"])
        self.assertNotIn("secret=private", rows[-1]["message"])
        self.assertNotIn("--mount=type=secret", rows[-1]["message"])
        self.assertIn("newest", rows[-1]["message"])

    def package(self, root):
        blob = b"checked-source-package"
        (root / "source.zip").write_bytes(blob)
        (root / "release-manifest.json").write_text(json.dumps({"commit": "f" * 40,
            "zipSha256": hashlib.sha256(blob).hexdigest(), "zipBytes": len(blob)}))

    def test_timeout_preserves_upload_id_and_status_never_resubmits(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            root, tool = Path(directory), FakeTool()
            self.package(root)
            self.assertEqual(module.submit(root, "target", tool), 2)
            record = json.loads((root / "submission.json").read_text())
            self.assertEqual(record["uploadId"], "a" * 24)
            self.assertEqual(record["phase"], "prepareRequestedUnconfirmed")
            self.assertNotIn("secret=private", output.getvalue())
            self.assertNotIn("test-token", output.getvalue())
            self.assertNotIn("token", tool.requests[1][2])
            self.assertEqual(module.status(root, "target", tool), 0)
            self.assertEqual(len(tool.requests), 3)
            self.assertEqual(json.loads((root / "submission.json").read_text())["deploymentId"], "e" * 24)
            with self.assertRaisesRegex(ValueError, "already recorded"):
                module.submit(root, "target", tool)
            self.assertEqual(len(tool.requests), 3)

    def test_corrupted_zip_is_rejected_before_any_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            root, tool = Path(directory), FakeTool()
            self.package(root)
            (root / "source.zip").write_bytes(b"corrupted")
            with self.assertRaisesRegex(ValueError, "differs from release manifest"):
                module.submit(root, "target", tool)
            self.assertEqual(tool.requests, [])
            self.assertFalse((root / "submission.json").exists())

    def test_record_is_exclusive_and_wrong_target_cannot_be_polled(self):
        with tempfile.TemporaryDirectory() as directory:
            root, tool = Path(directory), FakeTool()
            state = root / "submission.json"
            module.write_record(state, {"serviceId": "other", "environmentId": "c" * 24}, exclusive=True)
            with self.assertRaises(FileExistsError):
                module.write_record(state, {"replaced": True}, exclusive=True)
            with self.assertRaisesRegex(ValueError, "target differ"):
                module.status(root, "target", tool)
            self.assertEqual(tool.requests, [])


if __name__ == "__main__":
    unittest.main()
