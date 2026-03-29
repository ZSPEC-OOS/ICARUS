import test from 'node:test'
import assert from 'node:assert/strict'

import { enforceStructuredPrompt } from './structuredPrompting.js'
import { runCritiquePass } from './critiqueMiddleware.js'
import { retrieveContext } from './ragService.js'
import { classifyTaskComplexity, createDeepReasoningWorkflow } from './deepReasoningPipeline.js'

test('structured prompting keeps goal and sections', () => {
  const input = 'Goal: Improve auth flow\nConstraints:\n- no API break\nAcceptance Tests:\n- login works'
  const out = enforceStructuredPrompt(input)
  assert.equal(out.contract.goal, 'Improve auth flow')
  assert.deepEqual(out.contract.constraints, ['no API break'])
  assert.deepEqual(out.contract.acceptanceTests, ['login works'])
})

test('critique catches empty draft', () => {
  const critique = runCritiquePass({ draftText: '' })
  assert.equal(critique.passed, false)
  assert.ok(critique.issues.some(i => i.id === 'missing_output'))
})

test('retrieve context returns reranked chunks', () => {
  const fake = {
    isReady: true,
    findRelevantFiles: () => [{ path: 'src/App.jsx', score: 0.9 }],
    search: () => [{ path: 'src/App.jsx', score: 0.7 }],
    contentIndex: new Map([['src/App.jsx', 'application shell and route rendering']]),
  }
  const out = retrieveContext({ query: 'route rendering', shadowContext: fake, config: { injectTopK: 3 } })
  assert.equal(out.contexts.length, 1)
  assert.match(out.promptContext, /src\/App\.jsx/)
})

test('complexity classifier tiers by task length', () => {
  assert.equal(classifyTaskComplexity('tiny task'), 'simple')
  assert.equal(classifyTaskComplexity('x'.repeat(200)), 'moderate')
  assert.equal(classifyTaskComplexity('x'.repeat(400)), 'complex')
})

test('deep reasoning workflow runs structured prompt + rag + critique inside reliability loop', async () => {
  const events = []
  const fakeShadow = {
    isReady: true,
    findRelevantFiles: () => [{ path: 'src/services/auth.js', score: 0.9 }],
    search: () => [{ path: 'src/services/auth.js', score: 0.8 }],
    contentIndex: new Map([['src/services/auth.js', 'authenticate user and validate jwt token']]),
  }

  const workflow = createDeepReasoningWorkflow({
    enhancerConfig: {
      rag: { enabled: true, rerankTopK: 4, injectTopK: 2, bm25Weight: 0.5, vectorWeight: 0.5, minScore: 0.01 },
      critique: { enabled: true },
      deepReasoning: { summaryStyle: 'concise_only' },
    },
    shadowContext: fakeShadow,
    planner: async ({ task }) => ({ steps: [`Implement: ${task.goal || 'goal'}`], dependencies: [] }),
    runAgent: async (executionTask) => ({ text: `Completed task.\n${executionTask.slice(0, 80)}` }),
    onEvent: (ev) => { if (ev?.type === 'fsm_state') events.push(ev.state) },
  })

  const result = await workflow('Goal: Harden auth flow\nConstraints:\n- Keep public API stable')
  assert.deepEqual(events, ['plan', 'execute', 'verify', 'done'])
  assert.equal(result.critique.passed, true)
  assert.equal(result.retrieval.contexts.length > 0, true)
  assert.equal(Array.isArray(result.reliability.history), true)
})
