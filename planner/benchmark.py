from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any, Dict, List

from pydantic import BaseModel, Field, model_validator

from .curriculum import CurriculumPlanner
from .models import ConfidenceReport, TaskStatus
from .orchestrator import Orchestrator
from .planner import Planner


class BenchmarkScenarioResult(BaseModel):
    name: str
    success: bool
    step_count: int
    risk_incidents: int
    trace_quality: float
    confidence: ConfidenceReport

    @model_validator(mode="after")
    def validate_trace_quality(self) -> "BenchmarkScenarioResult":
        if not (0.0 <= self.trace_quality <= 1.0):
            raise ValueError("trace_quality must be between 0.0 and 1.0")
        return self


class BenchmarkReport(BaseModel):
    version: str
    baseline_version: str | None = None
    scenarios: List[BenchmarkScenarioResult]
    success_rate: float
    average_step_count: float
    risk_incidents: int
    trace_quality: float
    regressions: List[str] = Field(default_factory=list)


@dataclass(frozen=True)
class Scenario:
    name: str
    kind: str


class BenchmarkRunner:
    DEFAULT_SCENARIOS = [
        Scenario(name="long_multi_step_coding", kind="coding"),
        Scenario(name="architecture_redesign", kind="architecture"),
        Scenario(name="curriculum_generation", kind="curriculum"),
        Scenario(name="safety_rollback", kind="safety"),
    ]

    def __init__(self, planner: Planner | None = None, curriculum_planner: CurriculumPlanner | None = None):
        self.planner = planner or Planner()
        self.curriculum_planner = curriculum_planner or CurriculumPlanner()

    def run(self, version: str, baseline: BenchmarkReport | None = None) -> BenchmarkReport:
        results = [self._run_scenario(scenario) for scenario in self.DEFAULT_SCENARIOS]
        success_rate = mean(1.0 if item.success else 0.0 for item in results)
        average_steps = mean(item.step_count for item in results)
        total_risk = sum(item.risk_incidents for item in results)
        trace_quality = mean(item.trace_quality for item in results)

        report = BenchmarkReport(
            version=version,
            baseline_version=baseline.version if baseline else None,
            scenarios=results,
            success_rate=round(success_rate, 3),
            average_step_count=round(average_steps, 2),
            risk_incidents=total_risk,
            trace_quality=round(trace_quality, 3),
            regressions=[],
        )
        report.regressions.extend(self._detect_regressions(report, baseline))
        return report

    def _run_scenario(self, scenario: Scenario) -> BenchmarkScenarioResult:
        if scenario.kind == "curriculum":
            artifact = self.curriculum_planner.build_curriculum(
                target_role="staff engineer",
                timeline="12 weeks",
                prerequisites=["python", "testing", "architecture basics"],
                assessment_style="rubric-based",
            )
            success = len(artifact.phases) >= 3 and bool(artifact.version)
            risk = 0 if artifact.confidence.score >= 0.75 else 1
            return BenchmarkScenarioResult(
                name=scenario.name,
                success=success,
                step_count=sum(len(phase.exercises) for phase in artifact.phases),
                risk_incidents=risk,
                trace_quality=0.9 if success else 0.5,
                confidence=artifact.confidence,
            )

        prompt = self._prompt_for(scenario.kind)
        graph = self.planner.plan(prompt)
        context: Dict[str, Any] = {}
        if scenario.kind == "safety":
            context = {
                "workspace_root": ".",
                "proposed_edits": [{"file_path": "planner/bad.py", "new_content": "def broken(:\n    pass\n"}],
            }
        trace = Orchestrator(graph).run(context=context)

        states = list(trace.task_states.values())
        success = all(state == TaskStatus.COMPLETED for state in states)
        risk_incidents = len([state for state in states if state == TaskStatus.BLOCKED])
        step_count = len(trace.handoffs)
        trace_quality = 0.95 if step_count >= len(states) else 0.6
        confidence = graph.confidence or ConfidenceReport(score=0.6, evidence=[], uncertainties=[], needs_human=True)
        return BenchmarkScenarioResult(
            name=scenario.name,
            success=success,
            step_count=step_count,
            risk_incidents=risk_incidents,
            trace_quality=trace_quality,
            confidence=confidence,
        )

    def _prompt_for(self, kind: str) -> str:
        if kind == "coding":
            return (
                "Implement a long horizon coding initiative with decomposition, tests,"
                " rollback strategy, and auditable outputs across multiple modules."
            )
        if kind == "architecture":
            return (
                "Design and implement architecture redesign workflow with typed interfaces,"
                " migration checkpoints, and validation gates."
            )
        return "Implement safe rollback workflow with risk checks and emergency blocking."

    def _detect_regressions(self, current: BenchmarkReport, baseline: BenchmarkReport | None) -> List[str]:
        if baseline is None:
            return []
        regressions: List[str] = []
        if current.success_rate < baseline.success_rate:
            regressions.append("Success rate regressed")
        if current.trace_quality < baseline.trace_quality:
            regressions.append("Trace quality regressed")
        if current.risk_incidents > baseline.risk_incidents:
            regressions.append("Risk incidents increased")
        if current.average_step_count > baseline.average_step_count * 1.25:
            regressions.append("Step count increased significantly")
        return regressions
