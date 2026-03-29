from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .models import AgentRole, HandoffMessage, SubTask, TaskGraph, TaskStatus


class RoleResult(BaseModel):
    status: TaskStatus
    payload: Dict[str, Any] = Field(default_factory=dict)
    evidence: List[str] = Field(default_factory=list)
    notes: Optional[str] = None


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
            )

        patches = [
            {
                "file": f"generated/{sub_task.id}.patch",
                "summary": f"Apply implementation changes for {sub_task.title}",
            }
        ]
        return RoleResult(
            status=TaskStatus.IN_PROGRESS,
            payload={"patches": patches},
            evidence=[patch["file"] for patch in patches],
            notes="Patch generation complete",
        )


class ReviewerAgent(AgentRoleExecutor):
    role = AgentRole.REVIEWER

    def execute(self, sub_task: SubTask, context: Dict[str, Any]) -> RoleResult:
        coverage_override = context.get("coverage_override")
        coverage = int(coverage_override) if coverage_override is not None else 90
        policy_ok = not context.get("force_policy_fail", False)

        if coverage < 80 or not policy_ok:
            return RoleResult(
                status=TaskStatus.BLOCKED,
                payload={"coverage": coverage, "policy_ok": policy_ok},
                evidence=[f"reviewer:block:{sub_task.id}"],
                notes="Reviewer blocked task due to quality gate failure",
            )

        return RoleResult(
            status=TaskStatus.IN_PROGRESS,
            payload={"coverage": coverage, "policy_ok": policy_ok},
            evidence=[f"reviewer:approved:{sub_task.id}"],
            notes="Static analysis and policy checks passed",
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
            )

        return RoleResult(
            status=TaskStatus.COMPLETED,
            payload={"accepted": True},
            evidence=[f"verifier:passed:{sub_task.id}"],
            notes="Final acceptance tests passed",
        )


class ExecutionTrace(BaseModel):
    objective: str
    task_states: Dict[str, TaskStatus]
    handoffs: List[HandoffMessage]

    def to_markdown(self) -> str:
        lines = ["# Execution Trace", "", f"## Objective", self.objective, "", "## Task States"]
        for task_id in sorted(self.task_states):
            lines.append(f"- {task_id}: {self.task_states[task_id].value}")

        lines.extend(["", "## Handoffs"])
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
            if task.status == TaskStatus.COMPLETED:
                continue
            deps_complete = all(self.task_graph.sub_tasks[dep].status == TaskStatus.COMPLETED for dep in task.dependencies)
            if deps_complete and task.status in {TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED}:
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
            next_role = self._determine_next_role(active_role, result)
            self.handoff_history.append(
                HandoffMessage(
                    task_id=sub_task.id,
                    from_role=active_role,
                    to_role=next_role,
                    payload=result.payload,
                    evidence=result.evidence,
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
        return ExecutionTrace(objective=self.task_graph.objective, task_states=states, handoffs=self.handoff_history)

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
