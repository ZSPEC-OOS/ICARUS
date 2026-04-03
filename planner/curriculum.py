from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha1
from typing import Dict, List

from pydantic import BaseModel, Field, model_validator

from .models import ConfidenceReport
from .planner import Planner


class AssessmentOutcome(BaseModel):
    checkpoint_id: str
    score: float
    notes: str = ""

    @model_validator(mode="after")
    def validate_score(self) -> "AssessmentOutcome":
        if not (0.0 <= self.score <= 1.0):
            raise ValueError("Assessment score must be between 0.0 and 1.0")
        return self


class CurriculumCheckpoint(BaseModel):
    id: str
    title: str
    week: int
    rubric: List[str] = Field(default_factory=list)


class CurriculumPhase(BaseModel):
    id: str
    title: str
    objectives: List[str] = Field(default_factory=list)
    exercises: List[str] = Field(default_factory=list)
    checkpoints: List[CurriculumCheckpoint] = Field(default_factory=list)


class CurriculumArtifact(BaseModel):
    target_role: str
    timeline: str
    prerequisites: List[str]
    assessment_style: str
    version: str
    generated_at: datetime
    phases: List[CurriculumPhase]
    confidence: ConfidenceReport


class CurriculumPlanner(Planner):
    def build_curriculum(
        self,
        target_role: str,
        timeline: str,
        prerequisites: List[str],
        assessment_style: str,
        assessment_outcomes: List[AssessmentOutcome] | None = None,
    ) -> CurriculumArtifact:
        weeks = self._parse_timeline_weeks(timeline)
        phase_templates = [
            ("phase_1", "Foundations", ["Core concepts", "Tooling setup", "Workflow fluency"]),
            ("phase_2", "Applied Delivery", ["Feature implementation", "Testing rigor", "Code review quality"]),
            ("phase_3", "Advanced Systems", ["Architecture", "Reliability", "Leadership communication"]),
        ]

        phase_weeks = max(2, weeks // len(phase_templates))
        phases: List[CurriculumPhase] = []
        for index, (phase_id, title, objectives) in enumerate(phase_templates, start=1):
            start_week = (index - 1) * phase_weeks + 1
            checkpoints = [
                CurriculumCheckpoint(
                    id=f"{phase_id}_cp_1",
                    title=f"{title} checkpoint",
                    week=min(weeks, start_week + phase_weeks - 1),
                    rubric=[
                        "Completeness and correctness",
                        "Testing and verification evidence",
                        f"Alignment with {assessment_style} assessment style",
                    ],
                )
            ]
            exercises = [
                f"{target_role} scenario lab for {title.lower()}",
                "Artifact review and reflective summary",
            ]
            phases.append(
                CurriculumPhase(
                    id=phase_id,
                    title=title,
                    objectives=objectives,
                    exercises=exercises,
                    checkpoints=checkpoints,
                )
            )

        refined = self.refine_curriculum(phases, assessment_outcomes or [])
        version = self._version_for(target_role, timeline, prerequisites, assessment_style, refined)
        confidence = self._confidence_for(refined, assessment_outcomes or [])

        return CurriculumArtifact(
            target_role=target_role,
            timeline=timeline,
            prerequisites=prerequisites,
            assessment_style=assessment_style,
            version=version,
            generated_at=datetime.now(timezone.utc),
            phases=refined,
            confidence=confidence,
        )

    def refine_curriculum(
        self,
        phases: List[CurriculumPhase],
        assessment_outcomes: List[AssessmentOutcome],
    ) -> List[CurriculumPhase]:
        if not assessment_outcomes:
            return phases

        outcome_map: Dict[str, AssessmentOutcome] = {item.checkpoint_id: item for item in assessment_outcomes}
        refined: List[CurriculumPhase] = []
        for phase in phases:
            patch_exercises = list(phase.exercises)
            patch_objectives = list(phase.objectives)
            for checkpoint in phase.checkpoints:
                outcome = outcome_map.get(checkpoint.id)
                if outcome and outcome.score < 0.75:
                    patch_exercises.append(f"Remediation sprint for {checkpoint.title.lower()}")
                    patch_objectives.append("Close skill gaps identified by checkpoint performance")
            refined.append(
                CurriculumPhase(
                    id=phase.id,
                    title=phase.title,
                    objectives=patch_objectives,
                    exercises=patch_exercises,
                    checkpoints=phase.checkpoints,
                )
            )
        return refined

    def _parse_timeline_weeks(self, timeline: str) -> int:
        digits = "".join(ch for ch in timeline if ch.isdigit())
        return max(6, int(digits)) if digits else 12

    def _version_for(
        self,
        target_role: str,
        timeline: str,
        prerequisites: List[str],
        assessment_style: str,
        phases: List[CurriculumPhase],
    ) -> str:
        basis = "|".join(
            [
                target_role,
                timeline,
                ",".join(sorted(prerequisites)),
                assessment_style,
                str(len(phases)),
                str(sum(len(phase.checkpoints) for phase in phases)),
            ]
        )
        return f"v{sha1(basis.encode('utf-8')).hexdigest()[:8]}"

    def _confidence_for(
        self,
        phases: List[CurriculumPhase],
        outcomes: List[AssessmentOutcome],
    ) -> ConfidenceReport:
        failed = [item for item in outcomes if item.score < 0.75]
        score = 0.88 if not failed else max(0.62, 0.88 - 0.08 * len(failed))
        return ConfidenceReport(
            score=round(score, 3),
            evidence=[
                {"type": "phase_count", "value": len(phases)},
                {"type": "checkpoint_count", "value": sum(len(phase.checkpoints) for phase in phases)},
                {"type": "assessment_outcomes", "value": len(outcomes)},
            ],
            uncertainties=["Learner baseline may differ from stated prerequisites"] if not outcomes else [],
            needs_human=bool(failed),
        )
