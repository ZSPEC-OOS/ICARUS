import unittest

from planner import Planner, TaskGraph


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.planner = Planner()

    def test_plan_generates_granular_task_graph(self):
        prompt = """
        Implement a complex multi-file refactor request.
        - Use pydantic v2 models
        - Add dependency DAG and topological ordering
        - Add JSON serialization and deserialization
        - Provide markdown rendering
        - Include acceptance tests and milestones
        """
        graph = self.planner.plan(prompt)

        self.assertGreaterEqual(len(graph.sub_tasks), 8)
        self.assertLessEqual(len(graph.sub_tasks), 15)
        self.assertIsNotNone(graph.confidence)
        self.assertGreaterEqual(graph.confidence.score, 0.0)
        order = graph.topological_sort()
        self.assertEqual(len(order), len(graph.sub_tasks))

    def test_roundtrip_serialization(self):
        graph = self.planner.plan("Implement planner with json and dag validation")
        payload = graph.to_json()
        loaded = TaskGraph.from_json(payload)

        self.assertEqual(graph.objective, loaded.objective)
        self.assertEqual(set(graph.sub_tasks.keys()), set(loaded.sub_tasks.keys()))

    def test_markdown_renders_status(self):
        graph = self.planner.plan("Implement planning orchestration layer")
        markdown = graph.to_markdown()

        self.assertIn("# Task Graph", markdown)
        self.assertIn("[pending]", markdown)
        self.assertIn("## Milestones", markdown)


if __name__ == "__main__":
    unittest.main()
