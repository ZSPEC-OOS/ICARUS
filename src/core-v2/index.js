/**
 * @module core-v2
 * Public API entry point for the core-v2 execution pipeline.
 * @since 2.0.0
 * @stable
 */

export { runTask, groupDeliverables, getAllowedTools, parseToolCalls, updateDeliverablesFromCycle } from './taskRunner.js';

export {
  createPlanContract,
  validatePlanCoverage,
  markDeliverableComplete,
  PlanValidationError,
} from './planContract.js';

export {
  createTaskState,
  transition,
  canTransition,
  isTerminal,
  getPhaseHistory,
  getDeliverablesStatus,
  TaskStateMachine,
  InvalidPhaseTransitionError,
  MaxCyclesExceededError,
} from './taskStateMachine.js';

export {
  createCycle,
  checkCycleCompletion,
  enforceToolRestriction,
  recordTurn,
  summarizeCycle,
  ToolNotAllowedError,
} from './cycleEngine.js';

export {
  createContextBudget,
  allocateTier,
  enforceBudget,
  truncateToBudget,
  summarizeToolResults,
  computeTokenEstimate,
  ContextBudgetError,
  ContextBudgetExceededError,
} from './contextBudget.js';

export { packCycleContext, packPlanReviewContext } from './contextPacker.js';

export {
  createLoopGuard,
  checkToolSequence,
  checkFileRead,
  checkDeliverableProgress,
  checkCommandRepeat,
  recordTurn as recordLoopTurn,
  getLoopReport,
  createTaskLoopGuard,
  checkDeliverableRetry,
  recordFailedDeliverable,
} from './loopPrevention.js';

export {
  classifyError,
  formatErrorForLLM,
  formatErrorForUser,
  isFatal,
  getErrorRegistry,
} from './errorClassifier.js';

export { runSafetyGates, runCompletionGates } from './completionGate.js';

export {
  createRemediationBudget,
  spend,
  canAfford,
  getSpentByCategory,
  getAuditReport,
  COST_TABLE,
  RemediationBudgetExhaustedError,
} from './remediationBudget.js';

export { makeExecutor } from '../services-v2/agentExecutor.js';

export {
  createValidationSuite,
  runValidation,
  summarizeValidation,
} from './validator.js';

export {
  runQualitySignals,
  formatQualityReport,
} from './qualitySignals.js';

export { createTelemetrySink } from './telemetry.js';

export {
  buildRepoIndex,
  getFileContent,
  searchFiles,
  getRelatedFiles,
  getRepoMap,
  getSymbolsInFile,
  invalidateFile,
} from './repoIndex.js';
