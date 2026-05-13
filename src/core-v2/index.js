/**
 * @module core-v2
 * Public API entry point for the core-v2 execution pipeline.
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
} from './loopPrevention.js';

export {
  classifyError,
  formatErrorForLLM,
  formatErrorForUser,
  isFatal,
  getErrorRegistry,
} from './errorClassifier.js';

export { runSafetyGates, runCompletionGates } from './completionGate.js';
