import { useState, useEffect, useRef } from 'react'
import { loadModels, saveModels, testModelConnection } from '../services/aiService.js'

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••'
  return '••••••' + key.slice(-4)
}

function genId(name) {
  return 'model-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36)
}

const EMPTY_FORM = { name: '', baseUrl: '', modelId: '', apiKey: '' }

export default function ModelSetup({ models = [], onSave, onClose }) {
  const [localModels, setLocalModels] = useState(models)
  const [addForm, setAddForm] = useState(EMPTY_FORM)
  const [testing, setTesting] = useState(null)   // model id being tested
  const [testResults, setTestResults] = useState({})
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState(null)      // model id being edited
  const [editForm, setEditForm] = useState(EMPTY_FORM)

  // Refresh from storage on open (keys may have been loaded since App mounted)
  useEffect(() => {
    loadModels().then(m => setLocalModels(m)).catch(() => {})
  }, [])

  async function handleAdd(e) {
    e.preventDefault()
    if (!addForm.name.trim() || !addForm.baseUrl.trim() || !addForm.modelId.trim()) return
    const newModel = {
      id:      genId(addForm.name),
      name:    addForm.name.trim(),
      baseUrl: addForm.baseUrl.trim().replace(/\/$/, ''),
      modelId: addForm.modelId.trim(),
      apiKey:  addForm.apiKey.trim(),
    }
    const updated = [...localModels, newModel]
    setSaving(true)
    try {
      await saveModels(updated)
      setLocalModels(updated)
      onSave?.(updated)
      setAddForm(EMPTY_FORM)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id) {
    const updated = localModels.filter(m => m.id !== id)
    await saveModels(updated)
    setLocalModels(updated)
    onSave?.(updated)
  }

  async function handleTest(model) {
    setTesting(model.id)
    setTestResults(r => ({ ...r, [model.id]: null }))
    try {
      const result = await testModelConnection(model)
      setTestResults(r => ({ ...r, [model.id]: result }))
    } catch (err) {
      setTestResults(r => ({ ...r, [model.id]: { ok: false, error: err.message } }))
    } finally {
      setTesting(null)
    }
  }

  function startEdit(model) {
    setEditId(model.id)
    setEditForm({ name: model.name, baseUrl: model.baseUrl, modelId: model.modelId, apiKey: '' })
  }

  async function handleSaveEdit(e) {
    e.preventDefault()
    const updated = localModels.map(m => {
      if (m.id !== editId) return m
      return {
        ...m,
        name:    editForm.name.trim() || m.name,
        baseUrl: editForm.baseUrl.trim().replace(/\/$/, '') || m.baseUrl,
        modelId: editForm.modelId.trim() || m.modelId,
        ...(editForm.apiKey.trim() ? { apiKey: editForm.apiKey.trim() } : {}),
      }
    })
    setSaving(true)
    try {
      await saveModels(updated)
      setLocalModels(updated)
      onSave?.(updated)
      setEditId(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Model Setup">
      <div className="modal-content modal-content--lg">
        <div className="modal-header">
          <h2>AI Models &amp; API Keys</h2>
          <button className="btn-ghost modal-close" onClick={onClose} type="button" aria-label="Close">✕</button>
        </div>

        <p style={{ fontSize: '0.78rem', color: 'var(--lk-text-muted)', marginBottom: '1rem', marginTop: 0 }}>
          API keys are encrypted and stored locally. They are never sent to BLUSWAN servers.
        </p>

        {/* Existing models */}
        {localModels.length > 0 && (
          <div className="model-setup-list">
            {localModels.map(m => (
              <div key={m.id} className="model-card">
                {editId === m.id ? (
                  <form onSubmit={handleSaveEdit}>
                    <div className="model-form-grid">
                      <div className="model-form-row">
                        <label className="model-form-label">Name</label>
                        <input className="model-form-input" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} placeholder={m.name} />
                      </div>
                      <div className="model-form-row">
                        <label className="model-form-label">Model ID</label>
                        <input className="model-form-input" value={editForm.modelId} onChange={e => setEditForm(f => ({ ...f, modelId: e.target.value }))} placeholder={m.modelId} />
                      </div>
                      <div className="model-form-row model-form-row--full">
                        <label className="model-form-label">Base URL</label>
                        <input className="model-form-input" value={editForm.baseUrl} onChange={e => setEditForm(f => ({ ...f, baseUrl: e.target.value }))} placeholder={m.baseUrl} />
                      </div>
                      <div className="model-form-row model-form-row--full">
                        <label className="model-form-label">API Key (leave blank to keep current)</label>
                        <input className="model-form-input" type="password" value={editForm.apiKey} onChange={e => setEditForm(f => ({ ...f, apiKey: e.target.value }))} placeholder="sk-..." autoComplete="new-password" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                      <button className="btn-ghost" type="button" onClick={() => setEditId(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="model-card-header">
                      <span className="model-card-name">{m.name}</span>
                      <div className="model-card-actions">
                        <button
                          className={`model-card-btn model-card-btn--test${testing === m.id ? ' testing' : ''}`}
                          type="button"
                          onClick={() => handleTest(m)}
                          disabled={testing === m.id}
                        >
                          {testing === m.id ? 'Testing…' : 'Test'}
                        </button>
                        <button className="model-card-btn" type="button" onClick={() => startEdit(m)}>Edit</button>
                        <button className="model-card-btn model-card-btn--danger" type="button" onClick={() => handleDelete(m.id)}>Delete</button>
                      </div>
                    </div>
                    <div className="model-card-info">
                      <div className="model-card-info-item">
                        <span className="model-card-info-label">Model</span>
                        <span className="model-card-info-value">{m.modelId}</span>
                      </div>
                      <div className="model-card-info-item">
                        <span className="model-card-info-label">Endpoint</span>
                        <span className="model-card-info-value" style={{ maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.baseUrl}</span>
                      </div>
                      <div className="model-card-info-item">
                        <span className="model-card-info-label">API Key</span>
                        <span className="model-card-info-value">{maskKey(m.apiKey)}</span>
                      </div>
                    </div>
                    {testResults[m.id] !== undefined && testResults[m.id] !== null && (
                      <div className={`model-test-result model-test-result--${testResults[m.id].ok ? 'ok' : 'fail'}`}>
                        {testResults[m.id].ok
                          ? `✓ Connected — ${testResults[m.id].model || m.modelId} (${testResults[m.id].ms}ms)`
                          : `✗ ${testResults[m.id].error || 'Connection failed'}`}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add model form */}
        <div className="model-add-form">
          <div className="model-form-title">Add Model</div>
          <form onSubmit={handleAdd}>
            <div className="model-form-grid">
              <div className="model-form-row">
                <label className="model-form-label">Name *</label>
                <input
                  className="model-form-input"
                  placeholder="e.g. GPT-4o"
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div className="model-form-row">
                <label className="model-form-label">Model ID *</label>
                <input
                  className="model-form-input"
                  placeholder="e.g. gpt-4o"
                  value={addForm.modelId}
                  onChange={e => setAddForm(f => ({ ...f, modelId: e.target.value }))}
                  required
                />
              </div>
              <div className="model-form-row model-form-row--full">
                <label className="model-form-label">Base URL *</label>
                <input
                  className="model-form-input"
                  placeholder="e.g. https://api.openai.com/v1"
                  value={addForm.baseUrl}
                  onChange={e => setAddForm(f => ({ ...f, baseUrl: e.target.value }))}
                  required
                />
              </div>
              <div className="model-form-row model-form-row--full">
                <label className="model-form-label">API Key</label>
                <input
                  className="model-form-input"
                  type="password"
                  placeholder="sk-... (stored encrypted)"
                  value={addForm.apiKey}
                  onChange={e => setAddForm(f => ({ ...f, apiKey: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button className="btn-primary" type="submit" disabled={saving || !addForm.name || !addForm.baseUrl || !addForm.modelId}>
                {saving ? 'Saving…' : 'Add Model'}
              </button>
              <span style={{ fontSize: '0.7rem', color: 'var(--lk-text-muted)' }}>
                Supports OpenAI-compatible endpoints and Anthropic API
              </span>
            </div>
          </form>
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  )
}
