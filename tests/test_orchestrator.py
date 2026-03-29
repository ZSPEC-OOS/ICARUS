import json
import tempfile
import unittest
from pathlib import Path

from planner import AgentRole, Orchestrator, Planner, TaskStatus, run_prompt_with_orchestration


class OrchestratorTests(unittest.TestCase):
    def setUp(self):
        self.planner = Planner()
        self.prompt = """
        Implement a multi-agent orchestration system.
        - Define architect, builder, reviewer, verifier roles
        - Support typed handoff messages
        - Persist a full execution trace
        """

    def test_end_to_end_prompt_to_orchestration_handoffs(self):
        trace = run_prompt_with_orchestration(self.prompt, planner=self.planner)

        self.assertGreater(len(trace.handoffs), 0)
        self.assertTrue(all(state == TaskStatus.COMPLETED for state in trace.task_states.values()))

        first_task_handoffs = [h for h in trace.handoffs if h.task_id == sorted(trace.task_states.keys())[0]][:4]
        self.assertEqual([h.from_role for h in first_task_handoffs], [
            AgentRole.ARCHITECT,
            AgentRole.BUILDER,
            AgentRole.REVIEWER,
            AgentRole.VERIFIER,
        ])

    def test_verifier_blocks_and_reroutes(self):
        graph = self.planner.plan(self.prompt)
        orchestrator = Orchestrator(graph)

        trace = orchestrator.run(context={"force_acceptance_fail": True})

        blocked_targets = [h.to_role for h in trace.handoffs if h.from_role == AgentRole.VERIFIER]
        self.assertIn(AgentRole.BUILDER, blocked_targets)
        self.assertTrue(any(state == TaskStatus.BLOCKED for state in trace.task_states.values()))

    def test_trace_is_human_readable_and_reversible(self):
        graph = self.planner.plan(self.prompt)
        orchestrator = Orchestrator(graph)
        _ = orchestrator.run()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "trace.json"
            orchestrator.persist_trace(output_path)
            payload = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertIn("trace", payload)
        self.assertIn("task_graph", payload)

        markdown = orchestrator.build_trace().to_markdown()
        self.assertIn("# Execution Trace", markdown)
        self.assertIn("## Handoffs", markdown)


if __name__ == "__main__":
    unittest.main()
