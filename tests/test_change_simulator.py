import tempfile
import textwrap
import unittest
from pathlib import Path

from planner import ChangeSimulator, CodeIntelligence, ProposedEdit


class ChangeSimulatorTests(unittest.TestCase):
    def _build_refactor_workspace(self, root: Path) -> None:
        files = {
            "pkg/api.py": "from pkg.service import process_request\n\ndef handle(payload):\n    return process_request(payload)\n",
            "pkg/service.py": "from pkg.helpers import normalize\n\ndef process_request(payload):\n    return normalize(payload)\n",
            "pkg/helpers.py": "def normalize(payload):\n    return payload.strip()\n",
            "pkg/jobs.py": "from pkg.service import process_request\n\ndef run_job(payload):\n    return process_request(payload)\n",
            "pkg/reports.py": "from pkg.service import process_request\n\ndef build_report(payload):\n    return process_request(payload)\n",
            "tests/test_service.py": textwrap.dedent(
                """
                import unittest
                from pkg.service import process_request

                class ServiceTests(unittest.TestCase):
                    def test_process_request(self):
                        self.assertEqual(process_request('  x  '), 'x')
                """
            ),
            "tests/test_api.py": textwrap.dedent(
                """
                import unittest
                from pkg.api import handle

                class ApiTests(unittest.TestCase):
                    def test_handle(self):
                        self.assertEqual(handle(' y '), 'y')
                """
            ),
        }
        for rel_path, content in files.items():
            target = root / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

    def test_symbol_level_impact_detects_breaking_refactor(self):
        simulator = ChangeSimulator()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self._build_refactor_workspace(root)

            edits = [
                ProposedEdit(
                    file_path="pkg/service.py",
                    new_content="from pkg.helpers import normalize\n\ndef transform_request(payload):\n    return normalize(payload)\n",
                )
            ]
            result = simulator.simulate(workspace_root=root, edits=edits)

        self.assertFalse(result.safe_to_apply)
        self.assertGreater(result.risk_score, 0.5)
        self.assertIn("pkg.service.process_request", result.affected_symbols)
        self.assertTrue(any("Projected test failures" in warning for warning in result.warnings))

    def test_code_intelligence_builds_symbol_dependencies(self):
        intel = CodeIntelligence()
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            self._build_refactor_workspace(root)
            snapshot = intel.analyze_workspace(root)

        self.assertIn("pkg.service.process_request", snapshot.definitions)
        self.assertIn("pkg.api.handle", snapshot.dependency_graph)
        self.assertIn("pkg.service.process_request", snapshot.dependency_graph["pkg.api.handle"])


if __name__ == "__main__":
    unittest.main()
