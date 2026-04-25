import { useState, useCallback, useRef } from 'react'
import { listUserRepos } from '../../services/githubService'

export function useRepoPicker(githubToken) {
  const [repoPickerOpen,    setRepoPickerOpen]    = useState(false)
  const [repoPickerSearch,  setRepoPickerSearch]  = useState('')
  const [userRepos,         setUserRepos]         = useState([])
  const [repoPickerLoading, setRepoPickerLoading] = useState(false)
  const [repoPickerError,   setRepoPickerError]   = useState(null)
  const repoPickerRef = useRef(null)

  const loadRepos = useCallback(async () => {
    if (!githubToken) return
    setRepoPickerLoading(true); setRepoPickerError(null)
    try {
      const repos = await listUserRepos(githubToken)
      setUserRepos(repos)
      if (repos.length === 0) setRepoPickerError('No repositories returned. Check token scopes (needs repo).')
    } catch (err) { setRepoPickerError(err.message || 'Failed to load repositories') }
    finally { setRepoPickerLoading(false) }
  }, [githubToken])

  const openRepoPicker = useCallback(async () => {
    setRepoPickerOpen(true); setRepoPickerSearch('')
    if (userRepos.length > 0) return
    await loadRepos()
  }, [userRepos.length, loadRepos])

  return {
    repoPickerOpen, setRepoPickerOpen,
    repoPickerSearch, setRepoPickerSearch,
    userRepos,
    repoPickerLoading,
    repoPickerError,
    repoPickerRef,
    loadRepos,
    openRepoPicker,
  }
}
