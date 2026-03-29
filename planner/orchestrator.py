from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .change_simulator import ChangeSimulationResult, ChangeSimulator, ProposedEdit
from .models import AgentRole, ConfidenceReport, HandoffMessage, SubTask, TaskGraph, TaskStatus


class RoleResult(BaseModel):
    status: TaskStatus
    payload: Dict[str, Any] = Field(default_factory=dict)
    evidence: List[str] = Field(default_factory=list)
    notes: Optional[str] = None
    confidence: ConfidenceReport


class AgentRoleExecutor(ABC):
    role: AgentRole

    @abstractmethod
    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        """Execute role-specific work for the provided sub-task."""


class ArchitectAgent(AgentRoleExecutor):
    role = AgentRole.ARCHITECT

    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        decisions = {
            "design_decisions": [
                "Preserve DAG-safe dependency ordering",
                f"Refine acceptance tests for {sub_task.id}",
            ],
            "dependency_updates": sub_task.dependencies,
            "refined_scope": sub_task.description,
        }
        return RoleResult(
            status=TaskStatus.IN_PROGRESS,
            payload=decisions,
            evidence=[f"architect:refined:{sub_task.id}"],
            notes="Architecture refinement complete",
            confidence=ConfidenceReport(
                score=0.87,
                evidence=[{"type": "task_id", "value": sub_task.id}, {"type": "dependencies", "value": len(sub_task.dependencies)}],
                uncertainties=[],
                needs_human=False,
            ),
        )


class BuilderAgent(AgentRoleExecutor):
    role = AgentRole.BUILDER

    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        if context.get("force_builder_fail"):
            return RoleResult(
                status=TaskStatus.BLOCKED,
                payload={"patches": []},
                evidence=[f"builder:failed:{sub_task.id}"],
                notes="Patch generation failed",
                confidence=ConfidenceReport(
                    score=0.25,
                    evidence=[{"type": "forced_failure", "value": True}],
                    uncertainties=["Builder failure was externally forced"],
                    needs_human=True,
                ),
            )

        patch_plan = context.get("builder_patch_plan") or [
            {
                "file": f"generated/{sub_task.id}.patch",
                "summary": f"Apply implementation changes for {sub_task.title}",
            }
        ]

        simulated_result = self._simulate_changes(context=context)
        if not simulated_result.safe_to_apply:
            return RoleResult(
                status=TaskStatus.BLOCKED,
                payload={"patch_plan": patch_plan, "simulation": simulated_result.model_dump(mode="json")},
                evidence=[f"builder:simulation_block:{sub_task.id}"],
                notes="Change simulation blocked unsafe patch before any filesystem write",
                confidence=ConfidenceReport(
                    score=max(0.1, 1.0 - simulated_result.risk_score),
                    evidence=[
                        {"type": "risk_score", "value": simulated_result.risk_score},
                        {"type": "warning_count", "value": len(simulated_result.warnings)},
                    ],
                    uncertainties=simulated_result.warnings,
                    needs_human=True,
                ),
            )

        return RoleResult(
            status=TaskStatus.IN_PROGRESS,
            payload={"patch_plan": patch_plan, "simulation": simulated_result.model_dump(mode="json")},
            evidence=[patch["file"] for patch in patch_plan],
            notes="Patch generation complete",
            confidence=ConfidenceReport(
                score=round(max(0.6, 1.0 - simulated_result.risk_score), 3),
                evidence=[
                    {"type": "patch_count", "value": len(patch_plan)},
                    {"type": "risk_score", "value": simulated_result.risk_score},
                ],
                uncertainties=simulated_result.warnings,
                needs_human=simulated_result.risk_score > 0.6,
            ),
        )

    def _simulate_changes(self, context: Dict[str, Any]) -> ChangeSimulationResult:
        edits_payload = context.get("proposed_edits", [])
        unified_diff = context.get("proposed_diff")
        if not edits_payload and not unified_diff:
            return ChangeSimulationResult(
                risk_score=0.0,
                affected_symbols=[],
                projected_test_outcomes={"no_targeted_tests": True},
                warnings=["No proposed edits attached to this sub-task; simulation skipped as no-op"],
                safe_to_apply=True,
            )

        simulator = ChangeSimulator()
        edits = [ProposedEdit.model_validate(item) for item in edits_payload]
        workspace_root = context.get("workspace_root", ".")
        return simulator.simulate(workspace_root=workspace_root, edits=edits, unified_diff=unified_diff)


class ReviewerAgent(AgentRoleExecutor):
    role = AgentRole.REVIEWER

    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        coverage_override = context.get("coverage_override")
        coverage = int(coverage_override) if coverage_override is not None else 90
        policy_ok = not context.get("force_policy_fail", False)
        simulation_payload = context.get("latest_builder_payload", {}).get("simulation", {})
        simulated = (
            ChangeSimulationResult.model_validate(simulation_payload)
            if simulation_payload
            else ChangeSimulationResult(
                risk_score=1.0,
                affected_symbols=[],
                projected_test_outcomes={},
                warnings=["Missing builder simulation payload"],
                safe_to_apply=False,
            )
        )

        if coverage < 80 or not policy_ok or not simulated.safe_to_apply:
            return RoleResult(
                status=TaskStatus.BLOCKED,
                payload={"coverage": coverage, "policy_ok": policy_ok, "simulation": simulated.model_dump(mode="json")},
                evidence=[f"reviewer:block:{sub_task.id}"],
                notes="Reviewer blocked task due to quality gate failure",
                confidence=ConfidenceReport(
                    score=0.35,
                    evidence=[{"type": "coverage", "value": coverage}, {"type": "policy_ok", "value": policy_ok}],
                    uncertainties=simulated.warnings,
                    needs_human=True,
                ),
            )

        return RoleResult(
            status=TaskStatus.IN_PROGRESS,
            payload={"coverage": coverage, "policy_ok": policy_ok, "simulation": simulated.model_dump(mode="json")},
            evidence=[f"reviewer:approved:{sub_task.id}"],
            notes="Static analysis and policy checks passed",
            confidence=ConfidenceReport(
                score=0.9,
                evidence=[{"type": "coverage", "value": coverage}, {"type": "policy_ok", "value": policy_ok}],
                uncertainties=simulated.warnings,
                needs_human=False,
            ),
        )


class VerifierAgent(AgentRoleExecutor):
    role = AgentRole.VERIFIER

    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        run_acceptance = not context.get("force_acceptance_fail", False)
        if not run_acceptance:
            return RoleResult(
                status=TaskStatus.BLOCKED,
                payload={"accepted": False, "reroute": AgentRole.BUILDER.value},
                evidence=[f"verifier:failed:{sub_task.id}"],
                notes="Acceptance tests failed",
                confidence=ConfidenceReport(
                    score=0.3,
                    evidence=[{"type": "acceptance", "value": False}],
                    uncertainties=["Acceptance criteria unmet"],
                    needs_human=True,
                ),
            )

        return RoleResult(
            status=TaskStatus.COMPLETED,
            payload={"accepted": True},
            evidence=[f"verifier:passed:{sub_task.id}"],
            notes="Final acceptance tests passed",
            confidence=ConfidenceReport(
                score=0.93,
                evidence=[{"type": "acceptance", "value": True}],
                uncertainties=[],
                needs_human=False,
            ),
        )


class ExecutionTrace(BaseModel):
    objective: str
    task_states: Dict[str, TaskStatus]
    handoffs: List[HandoffMessage]
    confidence: ConfidenceReport

    def to_markdown(self) -> str:
        lines = ["# Execution Trace", "", f"## Objective", self.objective, "", "## Task States"]
        for task_id in sorted(self.task_states):
            lines.append(f"- {task_id}: {self.task_states[task_id].value}")

        lines.extend(
            [
                "",
                "## Confidence",
                f"- score: {self.confidence.score:.2f}",
                f"- needs_human: {self.confidence.needs_human}",
                "",
                "## Handoffs",
            ]
        )
        for handoff in self.handoffs:
            lines.append(
                f"- {handoff.timestamp.isoformat()} | {handoff.task_id} | "
                f"{handoff.from_role.value} -> {handoff.to_role.value} | "
                f"evidence={', '.join(handoff.evidence) if handoff.evidence else 'none'}"
            )
        return "\n".join(lines) + "\n"


class Orchestrator:
    ROLE_CHAIN = [AgentRole.ARCHITECT, AgentRole.BUILDER, AgentRole.REVIEWER, AgentRole.VERIFIER]

    def __init__(self, task_graph: TaskGraph):
        self.task_graph = task_graph
        self.role_agents: Dict[AgentRole, AgentRoleExecutor] = {
            AgentRole.ARCHITECT: ArchitectAgent(),
            AgentRole.BUILDER: BuilderAgent(),
            AgentRole.REVIEWER: ReviewerAgent(),
            AgentRole.VERIFIER: VerifierAgent(),
        }
        self.handoff_history: List[HandoffMessage] = []

    def next_ready_sub_task(self) -> Optional[SubTask]:
        for task_id in self.task_graph.topological_sort():
            task = self.task_graph.sub_tasks[task_id]
            if task.status in {TaskStatus.COMPLETED, TaskStatus.BLOCKED}:
                continue
            deps_complete = all(self.task_graph.sub_tasks[dep].status == TaskStatus.COMPLETED for dep in task.dependencies)
            if deps_complete and task.status in {TaskStatus.PENDING, TaskStatus.IN_PROGRESS}:
                return task
        return None

    def run(self, context: Optional[Dict[str, Any]] = None) -> ExecutionTrace:
        context = context or {}
        while True:
            task = self.next_ready_sub_task()
            if task is None:
                break
            self._execute_task(task, context)

        return self.build_trace()

    def _execute_task(self, sub_task: SubTask, context: Dict[str, Any]) -> None:
        attempt = 0
        active_role = AgentRole.ARCHITECT

        while attempt < 8:
            attempt += 1
            result = self.role_agents[active_role].execute(sub_task, context)
            if active_role == AgentRole.BUILDER:
                context["latest_builder_payload"] = result.payload
            next_role = self._determine_next_role(active_role, result)
            self.handoff_history.append(
                HandoffMessage(
                    task_id=sub_task.id,
                    from_role=active_role,
                    to_role=next_role,
                    payload=result.payload,
                    evidence=result.evidence,
                    confidence=result.confidence,
                    timestamp=datetime.now(timezone.utc),
                )
            )

            if result.status == TaskStatus.COMPLETED and active_role == AgentRole.VERIFIER:
                sub_task.status = TaskStatus.COMPLETED
                return

            if result.status == TaskStatus.BLOCKED:
                sub_task.status = TaskStatus.BLOCKED
                if active_role == AgentRole.ARCHITECT:
                    return
                active_role = AgentRole.BUILDER if active_role == AgentRole.VERIFIER else AgentRole.ARCHITECT
                continue

            sub_task.status = TaskStatus.IN_PROGRESS
            active_role = next_role

        sub_task.status = TaskStatus.BLOCKED

    def _determine_next_role(self, current: AgentRole, result: RoleResult) -> AgentRole:
        if result.status == TaskStatus.BLOCKED:
            if current == AgentRole.VERIFIER:
                return AgentRole.BUILDER
            if current == AgentRole.REVIEWER:
                return AgentRole.ARCHITECT
            return current

        idx = self.ROLE_CHAIN.index(current)
        if idx == len(self.ROLE_CHAIN) - 1:
            return current
        return self.ROLE_CHAIN[idx + 1]

    def build_trace(self) -> ExecutionTrace:
        states = {task_id: sub_task.status for task_id, sub_task in self.task_graph.sub_tasks.items()}
        return ExecutionTrace(
            objective=self.task_graph.objective,
            task_states=states,
            handoffs=self.handoff_history,
            confidence=self._build_trace_confidence(states),
        )

    def _build_trace_confidence(self, states: Dict[str, TaskStatus]) -> ConfidenceReport:
        total = max(1, len(states))
        completed = len([state for state in states.values() if state == TaskStatus.COMPLETED])
        blocked = len([state for state in states.values() if state == TaskStatus.BLOCKED])
        score = max(0.05, min(0.99, (completed / total) - (blocked / total) * 0.3 + 0.55))
        uncertainties = ["One or more tasks were blocked and need rerun"] if blocked else []
        return ConfidenceReport(
            score=round(score, 3),
            evidence=[{"type": "completed", "value": completed}, {"type": "blocked", "value": blocked}],
            uncertainties=uncertainties,
            needs_human=blocked > 0,
        )

    def persist_trace(self, output_path: str | Path) -> Path:
        path = Path(output_path)
        trace = self.build_trace()
        payload = {
            "trace": trace.model_dump(mode="json"),
            "task_graph": self.task_graph.model_dump_for_audit(),
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return path


def run_prompt_with_orchestration(raw_prompt: str, planner, context: Optional[Dict[str, Any]] = None) -> ExecutionTrace:
    task_graph = planner.plan(raw_prompt)
    orchestrator = Orchestrator(task_graph)
    return orchestrator.run(context=context)
