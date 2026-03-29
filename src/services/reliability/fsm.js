export const RELIABILITY_STATES = {
  PLAN: 'plan',
  EXECUTE: 'execute',
  VERIFY: 'verify',
  ROLLBACK: 'rollback',
  DONE: 'done',
  FAILED: 'failed',
}

export function createReliabilityLoopFSM({
  task,
  memoryGraphService,
  onEvent = () => {},
  handlers,
}) {
  const state = {
    current: RELIABILITY_STATES.PLAN,
    history: [],
    task,
    context: {
      plan: null,
      execution: null,
      verification: null,
      rollback: null,
    },
  }

  function transition(next, meta = {}) {
    state.current = next
    state.history.push({ state: next, at: new Date().toISOString(), ...meta })
    onEvent({ type: 'fsm_state', state: next, meta })
  }

  async function run() {
    transition(RELIABILITY_STATES.PLAN)
    state.context.plan = await handlers.plan()

    transition(RELIABILITY_STATES.EXECUTE)
    state.context.execution = await handlers.execute(state.context.plan)

    transition(RELIABILITY_STATES.VERIFY)
    state.context.verification = await handlers.verify({
      plan: state.context.plan,
      execution: state.context.execution,
    })

    if (state.context.verification?.passed) {
      transition(RELIABILITY_STATES.DONE)
      memoryGraphService?.ingestReliabilityRun?.({
        task,
        stateHistory: state.history,
        verification: state.context.verification,
        rolledBack: false,
      })
      return state
    }

    transition(RELIABILITY_STATES.ROLLBACK, { failedGates: state.context.verification?.failedGateIds || [] })
    state.context.rollback = await handlers.rollback({
      trace: state.context.execution?.mutationTrace || [],
      verification: state.context.verification,
    })

    const recovered = !!state.context.rollback?.rolledBack
    transition(recovered ? RELIABILITY_STATES.DONE : RELIABILITY_STATES.FAILED)

    memoryGraphService?.ingestReliabilityRun?.({
      task,
      stateHistory: state.history,
      verification: state.context.verification,
      rolledBack: recovered,
      rollback: state.context.rollback,
    })

    return state
  }

  return {
    state,
    run,
  }
}
