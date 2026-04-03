from __future__ import annotations

import py_compile
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Sequence

from pydantic import BaseModel, Field

from .code_intelligence import CodeIntelligence


class ProposedEdit(BaseModel):
    file_path: str
    new_content: str


class ChangeSimulationResult(BaseModel):
    risk_score: float
    affected_symbols: List[str]
    projected_test_outcomes: Dict[str, bool]
    warnings: List[str]
    safe_to_apply: bool


class ChangeSimulator:
    def __init__(self, code_intelligence: CodeIntelligence | None = None):
        self.code_intelligence = code_intelligence or CodeIntelligence()

    def simulate(
        self,
        workspace_root: str | Path,
        edits: Sequence[ProposedEdit] | None = None,
        unified_diff: str | None = None,
    ) -> ChangeSimulationResult:
        if edits is None and not unified_diff:
            return ChangeSimulationResult(
                risk_score=0.0,
                affected_symbols=[],
                projected_test_outcomes={},
                warnings=["No patch input provided to simulator; treating as no-op plan"],
                safe_to_apply=True,
            )

        warnings: List[str] = []
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(workspace_root)
            snapshot = Path(tmpdir) / "snapshot"
            shutil.copytree(root, snapshot)

            edit_list = list(edits or [])
            if unified_diff:
                warnings.append("Unified diff provided; simulator currently supports edit-list application only")

            changed_files: List[str] = []
            for edit in edit_list:
                target = snapshot / edit.file_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(edit.new_content, encoding="utf-8")
                changed_files.append(edit.file_path)

            before = self.code_intelligence.analyze_workspace(root)
            after = self.code_intelligence.analyze_workspace(snapshot)

            removed_symbols = sorted(set(before.definitions) - set(after.definitions))
            impacted = self.code_intelligence.simulate_impact(before, removed_symbols)
            impacted_sorted = sorted(impacted)

            static_ok = True
            for file_path in changed_files:
                if not file_path.endswith(".py"):
                    continue
                candidate = snapshot / file_path
                try:
                    py_compile.compile(str(candidate), doraise=True)
                except py_compile.PyCompileError as exc:
                    warnings.append(f"Static analysis failed for {file_path}: {exc.msg}")
                    static_ok = False

            projected_tests = self._run_targeted_tests(snapshot, changed_files)

        failed_tests = [name for name, passed in projected_tests.items() if not passed]
        if failed_tests:
            warnings.append(f"Projected test failures: {', '.join(failed_tests)}")

        risk_score = min(1.0, 0.15 * len(removed_symbols) + 0.05 * len(impacted_sorted) + (0.35 if failed_tests else 0.0))
        if not static_ok:
            risk_score = max(risk_score, 0.85)
        if not changed_files:
            risk_score = max(risk_score, 0.9)

        safe = static_ok and not failed_tests and risk_score < 0.75
        return ChangeSimulationResult(
            risk_score=risk_score,
            affected_symbols=impacted_sorted,
            projected_test_outcomes=projected_tests,
            warnings=warnings,
            safe_to_apply=safe,
        )

    def _run_targeted_tests(self, snapshot: Path, changed_files: List[str]) -> Dict[str, bool]:
        if not changed_files:
            return {"no_targeted_tests": True}
        test_modules = self._select_tests(snapshot, changed_files)
        if not test_modules:
            return {"no_targeted_tests": True}

        outcomes: Dict[str, bool] = {}
        for module in test_modules:
            cmd = ["python", "-m", "unittest", module]
            proc = subprocess.run(cmd, cwd=snapshot, capture_output=True, text=True)
            outcomes[module] = proc.returncode == 0
        return outcomes

    def _select_tests(self, snapshot: Path, changed_files: List[str]) -> List[str]:
        tests_dir = snapshot / "tests"
        if not tests_dir.exists():
            return []

        all_tests = sorted(tests_dir.glob("test_*.py"))
        if not all_tests:
            return []

        selected: List[Path] = []
        changed_basenames = {Path(path).stem for path in changed_files}
        for test_file in all_tests:
            stem = test_file.stem.removeprefix("test_")
            if stem in changed_basenames or any(stem in path for path in changed_files):
                selected.append(test_file)

        if not selected:
            selected = all_tests

        return [f"tests.{path.stem}" for path in selected]
