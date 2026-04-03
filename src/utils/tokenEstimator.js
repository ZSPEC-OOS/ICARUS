// Rough token estimator — ~4 chars per token for English / code
// Cost per 1,000 tokens keyed by model.modelId

const PRICING = {
  'claude-sonnet-4-6': { input: 0.003,   output: 0.015  },
  'claude-opus-4-6':   { input: 0.015,   output: 0.075  },
  'claude-haiku-4-5':  { input: 0.0008,  output: 0.004  },
  'kimi-k2-5':         { input: 0.00060, output: 0.0025 },
}
const DEFAULT_PRICING = { input: 0.003, output: 0.015 }

export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// Returns { inputTokens, estimatedOutputTokens, totalUSD, modelId }
export function estimateCost(promptText, modelId, estimatedOutputTokens = 800) {
  const inputTokens = estimateTokens(promptText)
  const pricing = PRICING[modelId] || DEFAULT_PRICING
  const inputCost  = (inputTokens           / 1000) * pricing.input
  const outputCost = (estimatedOutputTokens / 1000) * pricing.output
  return {
    inputTokens,
    estimatedOutputTokens,
    totalUSD: inputCost + outputCost,
    modelId,
  }
}

export function formatCost(usd) {
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01)   return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}
