from __future__ import annotations

import re
from typing import Dict, Iterable, List, Optional

from .models import AcceptanceTest, ConfidenceReport, Dependency, Milestone, SubTask, TaskGraph


class Planner:
    """Plan-first orchestration layer that converts free-form instructions into a DAG-backed TaskGraph."""

    def plan(self, raw_prompt: str, context: Optional[Dict[str, str]] = None) -> TaskGraph:
        objective = self._build_objective(raw_prompt)
        constraints = self._extract_constraints(raw_prompt, context)
        requested_items = self._extract_requested_items(raw_prompt)

        sub_tasks = self._build_sub_tasks(objective, requested_items)
        dependencies = self._build_dependencies(sub_tasks)
        milestones = self._build_milestones(sub_tasks)

        return TaskGraph(
            objective=objective,
            constraints=constraints,
            sub_tasks={task.id: task for task in sub_tasks},
            dependencies=dependencies,
            milestones=milestones,
            confidence=self._build_confidence(objective, constraints, sub_tasks),
        )

    def _build_objective(self, raw_prompt: str) -> str:
        normalized = " ".join(raw_prompt.split()).strip()
        if not normalized:
            normalized = "implement a complete and auditable execution plan"
        if not re.match(r"^(implement|build|create|refactor|plan)\b", normalized, flags=re.IGNORECASE):
            normalized = f"Implement: {normalized}"
        return normalized

    def _extract_constraints(self, raw_prompt: str, context: Optional[Dict[str, str]]) -> List[str]:
        constraints: List[str] = []
        lower_prompt = raw_prompt.lower()

        if "pydantic" in lower_prompt:
            constraints.append("Use Pydantic v2 models for all planning structures")
        if "dag" in lower_prompt or "dependency" in lower_prompt:
            constraints.append("Sub-task ordering must remain DAG-safe with no dependency cycles")
        if "json" in lower_prompt:
            constraints.append("Task graph must support JSON serialization/deserialization for audits")
        if "test" in lower_prompt:
            constraints.append("Each sub-task must define executable acceptance tests")

        if context:
            constraints.extend([f"Context: {k}={v}" for k, v in context.items()])

        # Always include foundation constraints for this orchestration layer.
        defaults = [
            "Produce explicit milestones for progress visibility",
            "Render plan in human-readable markdown for handoff",
        ]
        for item in defaults:
            if item not in constraints:
                constraints.append(item)

        return constraints

    def _extract_requested_items(self, raw_prompt: str) -> List[str]:
        bullet_items = re.findall(r"(?:^|\n)\s*[*-]\s+(.+)", raw_prompt)
        if bullet_items:
            return [item.strip() for item in bullet_items if item.strip()]

        fragments = re.split(r"[\n.;]+", raw_prompt)
        return [frag.strip() for frag in fragments if len(frag.strip()) > 12]

    def _build_sub_tasks(self, objective: str, requested_items: Iterable[str]) -> List[SubTask]:
        base_titles = [
            ("analyze_scope", "Analyze objective and context", "Break down requested behavior into an implementation scope."),
            ("define_models", "Design planning data models", "Create strongly typed models for graph, tasks, dependencies, tests, and milestones."),
            ("implement_serialization", "Implement JSON persistence", "Add serialization/deserialization APIs for plan storage and auditability."),
            ("implement_dependency_engine", "Build dependency resolver", "Implement topological sorting and cycle detection for all sub-task edges."),
            ("build_decomposition", "Build prompt decomposition logic", "Translate free-form user direction into explicit sub-tasks with dependencies."),
            ("add_validation", "Add plan validation", "Validate acceptance coverage, objective quality, and dependency integrity before execution."),
            ("add_rendering", "Add markdown rendering", "Provide human-readable task graph rendering with status indicators."),
            ("wire_planner", "Implement planner orchestration", "Create Planner.plan(raw_prompt, context) to produce the full TaskGraph."),
            ("create_tests", "Add unit tests", "Cover DAG ordering, cycle checks, validation, serialization, and rendering behavior."),
            ("final_audit", "Perform final audit review", "Ensure output is publication-ready and traces back to original objective."),
        ]

        requested = list(requested_items)
        if len(requested) >= 4:
            extra = [(f"requirement_{i+1}", f"Map requirement: {item[:56]}", "Implement and validate this explicit requirement from the original request.") for i, item in enumerate(requested[:5])]
            base_titles[1:1] = extra

        tasks: List[SubTask] = []
        for idx, (task_id, title, desc) in enumerate(base_titles, start=1):
            deps = [] if idx == 1 else [base_titles[idx - 2][0]]
            if task_id == "create_tests":
                deps = ["wire_planner", "add_validation", "add_rendering"]
            if task_id == "final_audit":
                deps = ["create_tests"]

            tests = [
                AcceptanceTest(
                    description=f"Verify {title.lower()} implementation meets expected behavior.",
                    type="unit",
                    expected_outcome="Behavior matches specification without regressions.",
                )
            ]
            if task_id in {"create_tests", "final_audit"}:
                tests.append(
                    AcceptanceTest(
                        description="Run end-to-end planning flow on a complex prompt.",
                        type="integration",
                        expected_outcome="Generated graph is ordered, cycle-free, and complete.",
                    )
                )

            tasks.append(
                SubTask(
                    id=task_id,
                    title=title,
                    description=f"{desc} Objective linkage: {objective}",
                    dependencies=deps,
                    acceptance_tests=tests,
                )
            )

        return tasks

    def _build_dependencies(self, sub_tasks: List[SubTask]) -> List[Dependency]:
        dependencies: List[Dependency] = []
        for task in sub_tasks:
            for dep in task.dependencies:
                dependencies.append(
                    Dependency(
                        from_task_id=dep,
                        to_task_id=task.id,
                        rationale=f"{task.id} requires outputs from {dep}",
                    )
                )
        return dependencies


    def _build_confidence(self, objective: str, constraints: List[str], sub_tasks: List[SubTask]) -> ConfidenceReport:
        score = min(0.98, 0.55 + min(len(sub_tasks), 12) * 0.02 + min(len(constraints), 8) * 0.015)
        uncertainties: List[str] = []
        if len(constraints) < 3:
            uncertainties.append("Limited explicit constraints in prompt")
        if len(sub_tasks) < 6:
            uncertainties.append("Plan decomposition may be shallow for complex implementations")

        return ConfidenceReport(
            score=round(score, 3),
            evidence=[
                {"type": "objective", "value": objective},
                {"type": "sub_task_count", "value": len(sub_tasks)},
                {"type": "constraint_count", "value": len(constraints)},
            ],
            uncertainties=uncertainties,
            needs_human=score < 0.7 or bool(uncertainties),
        )
    def _build_milestones(self, sub_tasks: List[SubTask]) -> List[Milestone]:
        all_ids = [task.id for task in sub_tasks]
        chunks = [all_ids[:3], all_ids[3:7], all_ids[7:]]
        names = [
            ("m1", "Planning foundations complete", "Objective, scope, and models are finalized."),
            ("m2", "Execution logic complete", "Core planning and validation pipeline is implemented."),
            ("m3", "Quality gate complete", "Testing and audit readiness are finalized for handoff."),
        ]

        milestones: List[Milestone] = []
        for (mid, title, desc), target_ids in zip(names, chunks):
            if not target_ids:
                continue
            milestones.append(
                Milestone(
                    id=mid,
                    title=title,
                    description=desc,
                    target_sub_task_ids=target_ids,
                )
            )
        return milestones
