import { useState, useCallback } from 'react'
import {
  listWorkflows,
  dispatchWorkflow,
  getWorkflowRuns,
  getWorkflowRun,
} from '../../services/githubService'

export function useGithubActions({ hasGithub, githubToken, repoOwner, repoName, baseBranch, logActivity, updateActivity }) {
  const [workflows,    setWorkflows]    = useState([])
  const [workflowRuns, setWorkflowRuns] = useState([])
  const [isPollingCI,  setIsPollingCI]  = useState(false)

  const loadWorkflows = useCallback(async () => {
    if (!hasGithub) return
    try {
      const res = await listWorkflows(githubToken, repoOwner, repoName)
      setWorkflows(res?.workflows || [])
    } catch { setWorkflows([]) }
  }, [hasGithub, githubToken, repoOwner, repoName])

  const triggerWorkflow = useCallback(async () => {
    if (!hasGithub) return
    const wf = workflows.find(w => w.events?.includes('workflow_dispatch')) || workflows[0]
    if (!wf) return
    setIsPollingCI(true)
    const id = logActivity('ci', `⊙ Triggering workflow ${wf.name || wf.path}`)
    try {
      const dispatch = await dispatchWorkflow(githubToken, repoOwner, repoName, wf.id, baseBranch)
      if (!dispatch) {
        updateActivity(id, { status: 'error', msg: `⊙ Failed to trigger ${wf.name || wf.path}` })
        return
      }
      updateActivity(id, { status: 'done', msg: `⊙ Workflow triggered: ${wf.name || wf.path}` })
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000))
        const runs = await getWorkflowRuns(githubToken, repoOwner, repoName, baseBranch, 5, wf.id)
        const run  = runs?.workflow_runs?.find(r => r.workflow_id === wf.id)
        if (run && run.status !== 'queued' && run.status !== 'in_progress') {
          setWorkflowRuns([run])
          updateActivity(id, {
            status: run.conclusion === 'success' ? 'done' : 'error',
            msg: `⊙ Workflow ${run.name} ${run.conclusion || run.status}`,
            detail: run.html_url,
          })
          break
        }
      }
    } catch (e) {
      updateActivity(id, { status: 'error', msg: `⊙ Workflow trigger failed: ${e.message}` })
    } finally { setIsPollingCI(false) }
  }, [hasGithub, workflows, githubToken, repoOwner, repoName, baseBranch, logActivity, updateActivity])

  return { workflows, workflowRuns, isPollingCI, loadWorkflows, triggerWorkflow }
}
