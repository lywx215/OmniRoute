"""Regression checks for source loss and stale browser assets during packaging."""

import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("zeabur_package", ROOT / "scripts/ops/prepare-zeabur-web.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
POLICY = json.loads((ROOT / "config/deploy/zeabur-web.json").read_text())


class PackageRegressionTests(unittest.TestCase):
    def test_cli_requires_an_explicit_reviewed_source_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "package"
            result = subprocess.run([sys.executable, str(ROOT / "scripts/ops/prepare-zeabur-web.py"),
                                     "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("required: --ref", result.stderr)
            self.assertFalse(output.exists())

    def test_nested_build_env_and_hidden_routes_survive_zip_and_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "context"
            root.mkdir()
            for name in module.REQUIRED:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(("source:" + name).encode())
            paths = module.make_restore(root)
            self.assertEqual(paths, [
                "src/app/.well-known/agent-card.json/route.ts",
                "src/app/.well-known/agent.json/route.ts",
                "src/app/api/system/env/repair/route.ts",
                "src/lib/env/runtimeEnv.ts",
            ])
            with tarfile.open(root / module.RESTORE) as archive:
                for name in paths:
                    self.assertEqual(archive.extractfile(name).read(), (root / name).read_bytes())
            package = Path(directory) / "source.zip"
            module.write_zip(root, package)
            with zipfile.ZipFile(package) as archive:
                for name in module.REQUIRED:
                    self.assertEqual(archive.read(name), (root / name).read_bytes())

    def test_changed_playwright_cannot_reuse_old_browser_baseline(self):
        lock = {"packages": {"node_modules/" + name: {"version": "9.0.0"}
                             for name in ("playwright", "playwright-core")}}
        with self.assertRaisesRegex(ValueError, "differs from verified browser baseline"):
            module.validate_policy(POLICY, lock)
        lock["packages"]["node_modules/playwright"]["version"] = POLICY["playwrightVersion"]
        with self.assertRaisesRegex(ValueError, "playwright-core"):
            module.validate_policy(POLICY, lock)

    def test_generated_dockerfile_restores_sources_before_production_build(self):
        text = (ROOT / "Dockerfile").read_text()
        patched = module.patch_dockerfile(text, POLICY, "a" * 40, ["src/lib/env/runtimeEnv.ts"])
        self.assertIn("npm ci --include=dev --include=optional", patched)
        self.assertLess(patched.index("RUN tar -xf"), patched.index("&& npm run build"))
        self.assertIn('&& test -f src/lib/env/runtimeEnv.ts', patched)
        self.assertNotIn("\n+", patched)
        self.assertIn('USER node\nRUN node -e', patched)
        self.assertIn("chromium.launch({headless:true", patched)
        self.assertIn(POLICY["browserImage"], patched)

    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            output.mkdir()
            sentinel = output / "operator-data"
            sentinel.write_text("keep")
            with self.assertRaisesRegex(ValueError, "Output already exists"):
                module.prepare(ROOT, "main", output, POLICY)
            self.assertEqual(sentinel.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
