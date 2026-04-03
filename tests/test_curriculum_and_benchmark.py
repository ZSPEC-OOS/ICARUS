import unittest

from planner import AssessmentOutcome, BenchmarkRunner, CurriculumPlanner


class CurriculumAndBenchmarkTests(unittest.TestCase):
    def test_curriculum_builder_outputs_phased_versioned_artifact(self):
        planner = CurriculumPlanner()
        artifact = planner.build_curriculum(
            target_role="platform engineer",
            timeline="10 weeks",
            prerequisites=["python", "git"],
            assessment_style="portfolio",
        )

        self.assertEqual(artifact.target_role, "platform engineer")
        self.assertGreaterEqual(len(artifact.phases), 3)
        self.assertTrue(artifact.version.startswith("v"))
        self.assertGreaterEqual(artifact.confidence.score, 0.0)

    def test_curriculum_refinement_adds_remediation_exercise(self):
        planner = CurriculumPlanner()
        artifact = planner.build_curriculum(
            target_role="ai coding mentor",
            timeline="8 weeks",
            prerequisites=["python"],
            assessment_style="rubric",
            assessment_outcomes=[AssessmentOutcome(checkpoint_id="phase_1_cp_1", score=0.6, notes="weak testing")],
        )
        phase_1 = artifact.phases[0]
        self.assertTrue(any("Remediation sprint" in ex for ex in phase_1.exercises))
        self.assertTrue(artifact.confidence.needs_human)

    def test_benchmark_runner_generates_regression_report(self):
        runner = BenchmarkRunner()
        baseline = runner.run(version="baseline")
        current = runner.run(version="current", baseline=baseline)

        self.assertEqual(current.baseline_version, "baseline")
        self.assertGreaterEqual(current.success_rate, 0.0)
        self.assertGreater(len(current.scenarios), 0)
        self.assertIsInstance(current.regressions, list)


if __name__ == "__main__":
    unittest.main()
