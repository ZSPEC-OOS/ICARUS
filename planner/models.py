from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


class TaskStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"


class AcceptanceTest(BaseModel):
    description: str
    type: str = Field(..., description="unit | integration | manual | policy")
    expected_outcome: str


class Dependency(BaseModel):
    from_task_id: str
    to_task_id: str
    rationale: Optional[str] = None


class SubTask(BaseModel):
    id: str
    title: str
    description: str
    dependencies: List[str] = Field(default_factory=list)
    acceptance_tests: List[AcceptanceTest] = Field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    assigned_role: Optional[str] = None

    @model_validator(mode="after")
    def validate_acceptance_tests(self) -> "SubTask":
        if not self.acceptance_tests:
            raise ValueError(f"Sub-task '{self.id}' must include at least one acceptance test")
        return self


class Milestone(BaseModel):
    id: str
    title: str
    description: str
    target_sub_task_ids: List[str] = Field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING


class TaskGraph(BaseModel):
    objective: str
    constraints: List[str] = Field(default_factory=list)
    sub_tasks: Dict[str, SubTask]
    dependencies: List[Dependency] = Field(default_factory=list)
    milestones: List[Milestone] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="after")
    def validate_graph(self) -> "TaskGraph":
        if not self.objective.strip():
            raise ValueError("Objective is required")

        if not self.sub_tasks:
            raise ValueError("Task graph must include at least one sub-task")

        for task_id, sub_task in self.sub_tasks.items():
            if task_id != sub_task.id:
                raise ValueError(f"Sub-task map key '{task_id}' must match SubTask.id '{sub_task.id}'")

            for dep_id in sub_task.dependencies:
                if dep_id not in self.sub_tasks:
                    raise ValueError(f"Sub-task '{task_id}' depends on unknown task '{dep_id}'")

            if not sub_task.acceptance_tests:
                raise ValueError(f"Sub-task '{task_id}' must have acceptance criteria")

        normalized = self.objective.lower()
        if not any(token in normalized for token in ("implement", "build", "create", "refactor", "plan")):
            raise ValueError("Objective appears too vague; include a clear actionable objective")

        _ = self.topological_sort()
        return self

    def topological_sort(self) -> List[str]:
        in_degree = {task_id: 0 for task_id in self.sub_tasks}
        adjacency: Dict[str, List[str]] = {task_id: [] for task_id in self.sub_tasks}

        for task_id, sub_task in self.sub_tasks.items():
            for dep_id in sub_task.dependencies:
                adjacency[dep_id].append(task_id)
                in_degree[task_id] += 1

        queue = deque(sorted([task_id for task_id, degree in in_degree.items() if degree == 0]))
        ordered: List[str] = []

        while queue:
            node = queue.popleft()
            ordered.append(node)
            for neighbor in sorted(adjacency[node]):
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        if len(ordered) != len(self.sub_tasks):
            raise ValueError("Dependency graph contains at least one cycle")

        return ordered

    def to_markdown(self, include_status: bool = True) -> str:
        lines = ["# Task Graph", "", f"## Objective", self.objective, ""]

        if self.constraints:
            lines.append("## Constraints")
            lines.extend([f"- {item}" for item in self.constraints])
            lines.append("")

        lines.append("## Sub-Tasks")
        for task_id in self.topological_sort():
            sub_task = self.sub_tasks[task_id]
            status = f" [{sub_task.status.value}]" if include_status else ""
            lines.append(f"### {sub_task.id}: {sub_task.title}{status}")
            lines.append(sub_task.description)
            if sub_task.dependencies:
                lines.append(f"- Depends on: {', '.join(sub_task.dependencies)}")
            if sub_task.assigned_role:
                lines.append(f"- Assigned role: {sub_task.assigned_role}")
            lines.append("- Acceptance tests:")
            for test in sub_task.acceptance_tests:
                lines.append(f"  - ({test.type}) {test.description} → {test.expected_outcome}")
            lines.append("")

        if self.milestones:
            lines.append("## Milestones")
            for milestone in self.milestones:
                status = f" [{milestone.status.value}]" if include_status else ""
                linked = ", ".join(milestone.target_sub_task_ids) if milestone.target_sub_task_ids else "none"
                lines.append(f"- **{milestone.id}: {milestone.title}**{status}")
                lines.append(f"  - {milestone.description}")
                lines.append(f"  - Tracks: {linked}")

        return "\n".join(lines).strip() + "\n"

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, payload: str) -> "TaskGraph":
        return cls.model_validate_json(payload)

    def model_dump_for_audit(self) -> Dict[str, Any]:
        return self.model_dump(mode="json")
