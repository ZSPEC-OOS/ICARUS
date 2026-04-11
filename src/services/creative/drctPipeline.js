import { runPromptWithRetry } from '../aiService.js'
import { createModelRouter } from '../orchestration/modelRouter.js'
import { buildRemixSet } from './recombinator.js'
import { applyTranscend } from './transcendOperator.js'
import { evaluateCreativeCandidates } from '../reliability/gateEvaluators.js'

function dreamVariantPrompt(task, variant) {
  return [
    'You are in DRCT creative mode (Dream → Remix → Critique → Transcend).',
    'Generate one radically distinct creative concept. Keep it concrete and vivid.',
    `Task: ${task}`,
    `Variant lens: ${variant}`,
  ].join('\n')
}

function buildVariantLenses() {
  return [
    'minimalist brutalism with kinetic hints',
    'playful narrative-first interaction',
    'retro-futurist terminal aesthetic',
    'editorial/art-direction heavy composition',
    'high-contrast accessibility-first concept',
    'immersive world-building concept',
    'metaphor-driven information architecture',
    'ambient calm interface tone',
  ]
}

export async function runDrctPipeline({ task, modelConfig, enhancerConfig, signal, onEvent }) {
  const workflow = {
    drct: {
      enabled: true,
      cycle: 0,
      candidateSolutions: [],
      bestCandidate: null,
    },
    candidateSolutions: [],
  }

  const router = createModelRouter(enhancerConfig?.orchestration || {}, [modelConfig])
  const routing = router.classifyAndRoute(task, modelConfig)

  let workingSet = []
  let dreamOnlyFallback = []

  for (let cycle = 1; cycle <= 2; cycle++) {
    workflow.drct.cycle = cycle

    const variants = buildVariantLenses().sort(() => Math.random() - 0.5).slice(0, 8)
    const dream = await router.callEnsembleCandidates(
      routing,
      async (cfg, variant, idx) => {
        const text = await runPromptWithRetry(
          { ...cfg, temperature: 0.9 + (idx % 3) * 0.05 },
          dreamVariantPrompt(task, variant || variants[idx] || 'surreal reinterpretation'),
          [{ role: 'system', content: 'Prioritize novelty and diversity over convergence.' }],
          null,
          signal,
        )
        return { text, metadata: { lens: variant || variants[idx] } }
      },
      { count: 8, iteration: cycle, promptVariants: variants },
    )

    const dreamed = dream.candidates || []
    dreamOnlyFallback = dreamed
    workflow.candidateSolutions.push(...dreamed)
    onEvent?.({ type: 'drct_phase', phase: 'dream', cycle, count: dreamed.length })

    const remix = buildRemixSet(dreamed, {
      count: 4,
      strategy: cycle % 2 === 0 ? 'similarity_weighted' : 'random',
    })
    workflow.candidateSolutions.push(...remix)
    onEvent?.({ type: 'drct_phase', phase: 'remix', cycle, count: remix.length })

    const critiqueInput = [...dreamed, ...remix]
    const scored = evaluateCreativeCandidates(critiqueInput)
    const ranked = scored
      .slice()
      .sort((a, b) => b.totalRankScore - a.totalRankScore)
      .slice(0, enhancerConfig?.drct?.topK || 4)

    if (!ranked.length) {
      const fallback = dreamOnlyFallback[0] || null
      workflow.drct.bestCandidate = fallback
      return {
        text: fallback?.content || 'DRCT fallback: no viable candidate; reverted to dream output.',
        workflow,
      }
    }

    onEvent?.({ type: 'drct_phase', phase: 'critique', cycle, count: ranked.length, scores: ranked })

    const transcended = ranked.map((row, i) => {
      const source = critiqueInput.find(c => c.id === row.candidateId)
      const transformed = applyTranscend(source)
      return {
        id: `transcend-${cycle}-${i + 1}-${Date.now()}`,
        content: transformed.transformed_output,
        metadata: {
          operatorUsed: transformed.operator_used,
          scores: row,
        },
        origin: 'transcend',
        iteration: cycle,
      }
    })

    workflow.candidateSolutions.push(...transcended)
    onEvent?.({ type: 'drct_phase', phase: 'transcend', cycle, count: transcended.length })
    workingSet = transcended
  }

  const finalScored = evaluateCreativeCandidates(workingSet)
  const bestFinal = finalScored
    .slice()
    .sort((a, b) => b.totalRankScore - a.totalRankScore)[0]

  const winner = workingSet.find(c => c.id === bestFinal?.candidateId) || workingSet[0] || dreamOnlyFallback[0] || null
  workflow.drct.bestCandidate = winner
  workflow.drct.candidateSolutions = workflow.candidateSolutions

  return {
    text: winner?.content || 'DRCT pipeline completed with empty result.',
    workflow,
  }
}
