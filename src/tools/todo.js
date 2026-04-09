// ─── todo tool ────────────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'todo',
  name: 'Todo',
  version: '1.0.0',
  description: 'Track tasks during complex multi-step operations. Actions: add | in_progress | done.',
  category: 'utility',
  author: 'BLUSWAN',
}

// In-memory task list (shared per session)
const tasks = []

export async function execute(input, config = {}) {
  const { action, task } = input
  if (!action || !['add', 'in_progress', 'done'].includes(action)) {
    throw new Error('action must be one of: add, in_progress, done')
  }
  if (!task) throw new Error('task is required')

  if (action === 'add') {
    tasks.push({ task, status: 'pending', created: Date.now() })
    return { action, task, tasks: [...tasks] }
  }

  if (action === 'in_progress') {
    const entry = tasks.find(t => t.task === task && t.status !== 'done')
    if (entry) entry.status = 'in_progress'
    return { action, task, tasks: [...tasks] }
  }

  if (action === 'done') {
    const entry = tasks.find(t => t.task === task)
    if (entry) entry.status = 'done'
    return { action, task, tasks: [...tasks] }
  }
}

export async function test() {
  // Reset shared task list before trial
  tasks.length = 0
  const failures = []

  // Trial 1: add creates a pending task
  const r1 = await execute({ action: 'add', task: 'Alpha' })
  const alpha = r1.tasks.find(t => t.task === 'Alpha')
  if (!alpha)                       failures.push('Trial 1: task not found after add')
  if (alpha?.status !== 'pending')  failures.push(`Trial 1: expected pending, got "${alpha?.status}"`)

  // Trial 2: add multiple tasks — all appear in list
  await execute({ action: 'add', task: 'Beta' })
  await execute({ action: 'add', task: 'Gamma' })
  if (tasks.length !== 3) failures.push(`Trial 2: expected 3 tasks, got ${tasks.length}`)

  // Trial 3: in_progress transitions the right task only
  await execute({ action: 'in_progress', task: 'Alpha' })
  const alphaAfter = tasks.find(t => t.task === 'Alpha')
  const betaAfter  = tasks.find(t => t.task === 'Beta')
  if (alphaAfter?.status !== 'in_progress') failures.push(`Trial 3: Alpha should be in_progress, got "${alphaAfter?.status}"`)
  if (betaAfter?.status  !== 'pending')     failures.push(`Trial 3: Beta should still be pending, got "${betaAfter?.status}"`)

  // Trial 4: done marks task complete, others unchanged
  await execute({ action: 'done', task: 'Alpha' })
  const alphaDone  = tasks.find(t => t.task === 'Alpha')
  const gammaPend  = tasks.find(t => t.task === 'Gamma')
  if (alphaDone?.status !== 'done')    failures.push(`Trial 4: Alpha should be done, got "${alphaDone?.status}"`)
  if (gammaPend?.status !== 'pending') failures.push(`Trial 4: Gamma should still be pending, got "${gammaPend?.status}"`)

  // Trial 5: result snapshot includes all tasks
  const r5 = await execute({ action: 'done', task: 'Beta' })
  if (r5.tasks.length !== 3) failures.push(`Trial 5: snapshot should have 3 tasks, got ${r5.tasks.length}`)

  // Trial 6: invalid action throws descriptive error
  try {
    await execute({ action: 'delete', task: 'X' })
    failures.push('Trial 6: should throw for invalid action')
  } catch (e) {
    if (!e.message.includes('add') || !e.message.includes('done')) {
      failures.push(`Trial 6: error should list valid actions, got: "${e.message}"`)
    }
  }

  // Trial 7: missing task param throws
  try {
    await execute({ action: 'add' })
    failures.push('Trial 7: should throw for missing task')
  } catch (e) {
    if (!e.message.includes('task')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  tasks.length = 0  // cleanup
  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (add, in_progress, done lifecycle, isolation, error guards).' }
}
