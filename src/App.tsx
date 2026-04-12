import { useEffect, useMemo, useState } from 'react'
import { useRoundRealtime } from './hooks/useRoundRealtime'
import { firebaseReady } from './lib/firebase'
import {
  buildParticipantIndex,
  getParticipantStatus,
  pickFeaturedAction,
  rankPendingActions,
  sortParticipants,
} from './lib/roundEngine'
import {
  addParticipant,
  approveNextAction,
  createRound,
  requestAction,
  skipAction,
  undoLatestChange,
} from './lib/roundStore'
import type { ActionType } from './types'

const STORAGE_KEY = 'po-live-round-id'

function getInitialRoundId() {
  const hashRoundId = window.location.hash.replace('#', '').trim()

  if (hashRoundId) {
    return hashRoundId.toUpperCase()
  }

  return window.localStorage.getItem(STORAGE_KEY)?.toUpperCase() ?? null
}

function parseParticipantNames(value: string) {
  return value
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
}

function formatTime(timestamp: number | null) {
  if (!timestamp) {
    return 'Never'
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
}

function describeAction(type: ActionType) {
  return type === 'speak' ? 'Speaker' : 'Question'
}

function App() {
  const [currentRoundId, setCurrentRoundId] = useState<string | null>(getInitialRoundId)
  const [roundCodeInput, setRoundCodeInput] = useState(currentRoundId ?? '')
  const [roundNameInput, setRoundNameInput] = useState('NSDA Round 1')
  const [participantInput, setParticipantInput] = useState('')
  const [newParticipantName, setNewParticipantName] = useState('')
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [uiError, setUiError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const snapshot = useRoundRealtime(currentRoundId)

  const participantIndex = useMemo(
    () => buildParticipantIndex(snapshot.participants),
    [snapshot.participants],
  )
  const sortedParticipants = useMemo(
    () => sortParticipants(snapshot.participants),
    [snapshot.participants],
  )
  const nextSpeaker = useMemo(
    () => rankPendingActions(snapshot.actions, snapshot.participants, 'speak')[0] ?? null,
    [snapshot.actions, snapshot.participants],
  )
  const nextQuestion = useMemo(
    () => rankPendingActions(snapshot.actions, snapshot.participants, 'question')[0] ?? null,
    [snapshot.actions, snapshot.participants],
  )
  const defaultFeaturedAction = useMemo(
    () => pickFeaturedAction(nextSpeaker, nextQuestion, snapshot.participants),
    [nextQuestion, nextSpeaker, snapshot.participants],
  )
  const selectedPendingAction = useMemo(
    () =>
      snapshot.actions.find(
        (action) => action.id === selectedActionId && action.status === 'pending',
      ) ?? null,
    [selectedActionId, snapshot.actions],
  )
  const featuredAction = selectedPendingAction ?? defaultFeaturedAction
  const canUndo = snapshot.history.some((entry) => !entry.undone)

  useEffect(() => {
    const onHashChange = () => {
      const nextRoundId = window.location.hash.replace('#', '').trim().toUpperCase()
      const resolvedRoundId = nextRoundId || null
      setCurrentRoundId(resolvedRoundId)
      setRoundCodeInput(resolvedRoundId ?? '')
    }

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!currentRoundId) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }

    window.localStorage.setItem(STORAGE_KEY, currentRoundId)
  }, [currentRoundId])

  useEffect(() => {
    if (!featuredAction) {
      setSelectedActionId(null)
      return
    }

    if (!selectedPendingAction) {
      setSelectedActionId(featuredAction.id)
    }
  }, [featuredAction, selectedPendingAction])

  async function runMutation(key: string, action: () => Promise<void>) {
    setBusyAction(key)
    setUiError(null)

    try {
      await action()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.'
      setUiError(message)
    } finally {
      setBusyAction(null)
    }
  }

  function selectRound(roundId: string | null) {
    const normalized = roundId?.trim().toUpperCase() ?? null
    setCurrentRoundId(normalized)
    setRoundCodeInput(normalized ?? '')
    window.location.hash = normalized ?? ''
  }

  async function handleCreateRound() {
    const roundName = roundNameInput.trim()

    if (!roundName) {
      setUiError('Enter a round name before creating a room.')
      return
    }

    await runMutation('create-round', async () => {
      const nextRoundId = await createRound(roundName, parseParticipantNames(participantInput))
      selectRound(nextRoundId)
    })
  }

  async function handleAddParticipant() {
    if (!currentRoundId) {
      return
    }

    await runMutation('add-participant', async () => {
      await addParticipant(currentRoundId, newParticipantName)
      setNewParticipantName('')
    })
  }

  async function handleRequest(participantId: string, type: ActionType) {
    if (!currentRoundId) {
      return
    }

    await runMutation(`request-${participantId}-${type}`, async () => {
      await requestAction(currentRoundId, participantId, type)
    })
  }

  async function handleApprove(type: ActionType) {
    if (!currentRoundId) {
      return
    }

    await runMutation(`approve-${type}`, async () => {
      await approveNextAction(currentRoundId, type)
    })
  }

  async function handleSkip() {
    if (!currentRoundId || !featuredAction) {
      return
    }

    await runMutation('skip-action', async () => {
      await skipAction(currentRoundId, featuredAction.id)
    })
  }

  async function handleUndo() {
    if (!currentRoundId) {
      return
    }

    await runMutation('undo', async () => {
      await undoLatestChange(currentRoundId)
    })
  }

  async function handleCopyLink() {
    if (!currentRoundId) {
      return
    }

    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${currentRoundId}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const roundMissing = Boolean(currentRoundId && !snapshot.loading && !snapshot.round)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Real-time tournament mode</p>
          <h1>PO Queue + P&amp;R Live System</h1>
          <p className="subcopy">
            Live queueing, automatic precedence and recency, and instant multi-device syncing for
            NSDA rounds.
          </p>
        </div>

        <div className="topbar-actions">
          <div className="badge">{firebaseReady ? 'Firebase live' : 'Firebase setup needed'}</div>
          {currentRoundId ? <div className="badge accent">Round {currentRoundId}</div> : null}
        </div>
      </header>

      {!snapshot.firebaseReady ? (
        <section className="setup-card">
          <h2>Connect Firestore first</h2>
          <p>
            Add your Firebase web config as Vite environment variables, then restart the dev
            server.
          </p>
          <code className="setup-code">
            VITE_FIREBASE_API_KEY
            <br />
            VITE_FIREBASE_AUTH_DOMAIN
            <br />
            VITE_FIREBASE_PROJECT_ID
            <br />
            VITE_FIREBASE_STORAGE_BUCKET
            <br />
            VITE_FIREBASE_MESSAGING_SENDER_ID
            <br />
            VITE_FIREBASE_APP_ID
          </code>
        </section>
      ) : (
        <>
          <section className="controls-strip">
            <div className="control-card">
              <h2>Create round</h2>
              <label className="field">
                <span>Round name</span>
                <input
                  value={roundNameInput}
                  onChange={(event) => setRoundNameInput(event.target.value)}
                  placeholder="NSDA Round 1"
                />
              </label>
              <label className="field">
                <span>Starting participants</span>
                <textarea
                  value={participantInput}
                  onChange={(event) => setParticipantInput(event.target.value)}
                  placeholder={'Enter one student per line\nAlice\nBen\nCarmen'}
                  rows={5}
                />
              </label>
              <button className="primary-button" onClick={handleCreateRound} disabled={Boolean(busyAction)}>
                {busyAction === 'create-round' ? 'Creating...' : 'Create live round'}
              </button>
            </div>

            <div className="control-card">
              <h2>Open round</h2>
              <label className="field">
                <span>Round code</span>
                <input
                  value={roundCodeInput}
                  onChange={(event) => setRoundCodeInput(event.target.value.toUpperCase())}
                  placeholder="Paste shared code"
                />
              </label>
              <div className="button-row">
                <button
                  className="secondary-button"
                  onClick={() => selectRound(roundCodeInput)}
                  disabled={!roundCodeInput.trim() || Boolean(busyAction)}
                >
                  Join round
                </button>
                <button
                  className="ghost-button"
                  onClick={() => selectRound(null)}
                  disabled={!currentRoundId || Boolean(busyAction)}
                >
                  Clear
                </button>
              </div>
              <p className="muted">
                Share the round code or the full URL hash to keep the PO and any observer devices
                on the same Firestore document.
              </p>
              {currentRoundId ? (
                <button className="ghost-button" onClick={handleCopyLink}>
                  {copied ? 'Copied link' : 'Copy share link'}
                </button>
              ) : null}
            </div>

            <div className="control-card status-card">
              <h2>Round status</h2>
              <div className="status-metric">
                <span>Connected round</span>
                <strong>{snapshot.round?.name ?? (roundMissing ? 'Round not found' : 'None selected')}</strong>
              </div>
              <div className="status-metric">
                <span>Participants</span>
                <strong>{snapshot.participants.length}</strong>
              </div>
              <div className="status-metric">
                <span>Pending speaks</span>
                <strong>{snapshot.actions.filter((action) => action.status === 'pending' && action.type === 'speak').length}</strong>
              </div>
              <div className="status-metric">
                <span>Pending questions</span>
                <strong>{snapshot.actions.filter((action) => action.status === 'pending' && action.type === 'question').length}</strong>
              </div>
            </div>
          </section>

          {uiError || snapshot.error ? <div className="error-banner">{uiError ?? snapshot.error}</div> : null}

          <main className="dashboard-grid">
            <aside className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Participants</p>
                  <h2>Request panel</h2>
                </div>
              </div>

              {snapshot.round ? (
                <>
                  <div className="add-participant">
                    <input
                      value={newParticipantName}
                      onChange={(event) => setNewParticipantName(event.target.value)}
                      placeholder="Add participant"
                    />
                    <button
                      className="secondary-button"
                      onClick={handleAddParticipant}
                      disabled={!newParticipantName.trim() || Boolean(busyAction)}
                    >
                      {busyAction === 'add-participant' ? 'Adding...' : 'Add'}
                    </button>
                  </div>

                  <div className="participant-list">
                    {sortedParticipants.map((participant) => {
                      const speakPending = snapshot.actions.some(
                        (action) =>
                          action.participantId === participant.id &&
                          action.type === 'speak' &&
                          action.status === 'pending',
                      )
                      const questionPending = snapshot.actions.some(
                        (action) =>
                          action.participantId === participant.id &&
                          action.type === 'question' &&
                          action.status === 'pending',
                      )
                      const status = getParticipantStatus(
                        participant.id,
                        snapshot.round?.activeParticipantId ?? null,
                        snapshot.actions,
                      )

                      return (
                        <article key={participant.id} className="participant-card">
                          <div className="participant-head">
                            <div>
                              <h3>{participant.name}</h3>
                              <p>
                                P{participant.speakCount} • Last action {formatTime(participant.lastActionTime)}
                              </p>
                            </div>
                            <span className={`status-chip ${status}`}>{status}</span>
                          </div>
                          <div className="participant-actions">
                            <button
                              className="primary-button"
                              disabled={speakPending || Boolean(busyAction)}
                              onClick={() => handleRequest(participant.id, 'speak')}
                            >
                              {speakPending ? 'Speak queued' : 'I Want to Speak'}
                            </button>
                            <button
                              className="secondary-button"
                              disabled={questionPending || Boolean(busyAction)}
                              onClick={() => handleRequest(participant.id, 'question')}
                            >
                              {questionPending ? 'Question queued' : 'I Have a Question'}
                            </button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="empty-panel">
                  Select or create a round to start accepting live requests.
                </div>
              )}
            </aside>

            <section className="panel center-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Round dashboard</p>
                  <h2>Live floor controls</h2>
                </div>
              </div>

              {snapshot.round ? (
                <>
                  <div className="next-grid">
                    {[nextSpeaker, nextQuestion].map((action, index) => {
                      const fallbackType: ActionType = index === 0 ? 'speak' : 'question'
                      const participant = action ? participantIndex.get(action.participantId) : null
                      const selected = action?.id === featuredAction?.id

                      return (
                        <button
                          key={fallbackType}
                          className={`next-card ${selected ? 'selected' : ''}`}
                          onClick={() => setSelectedActionId(action?.id ?? null)}
                          disabled={!action}
                        >
                          <span className="card-label">Next {describeAction(fallbackType)}</span>
                          <strong>{participant?.name ?? 'No pending request'}</strong>
                          <span>
                            {action
                              ? `Queued at ${formatTime(action.timestamp)} · precedence ${participant?.speakCount ?? 0}`
                              : 'Waiting for a request'}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  <div className="command-row">
                    <button
                      className="primary-button"
                      disabled={!nextSpeaker || Boolean(busyAction)}
                      onClick={() => handleApprove('speak')}
                    >
                      {busyAction === 'approve-speak' ? 'Approving...' : 'Approve Speak'}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!nextQuestion || Boolean(busyAction)}
                      onClick={() => handleApprove('question')}
                    >
                      {busyAction === 'approve-question' ? 'Approving...' : 'Approve Question'}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={!featuredAction || Boolean(busyAction)}
                      onClick={handleSkip}
                    >
                      {busyAction === 'skip-action' ? 'Skipping...' : 'Skip'}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={!canUndo || Boolean(busyAction)}
                      onClick={handleUndo}
                    >
                      {busyAction === 'undo' ? 'Undoing...' : 'Undo'}
                    </button>
                  </div>

                  <div className="summary-grid">
                    <article className="summary-card">
                      <span className="card-label">Current active floor</span>
                      <strong>
                        {snapshot.round.activeParticipantId
                          ? participantIndex.get(snapshot.round.activeParticipantId)?.name ?? 'Unknown participant'
                          : 'No active action'}
                      </strong>
                      <span>
                        {snapshot.round.activeType
                          ? `${describeAction(snapshot.round.activeType)} approved`
                          : 'Approve a request to mark the active speaker or questioner'}
                      </span>
                    </article>
                    <article className="summary-card">
                      <span className="card-label">Selected for skip</span>
                      <strong>
                        {featuredAction
                          ? participantIndex.get(featuredAction.participantId)?.name ?? 'Unknown participant'
                          : 'No pending item'}
                      </strong>
                      <span>
                        {featuredAction
                          ? `${describeAction(featuredAction.type)} request from ${formatTime(featuredAction.timestamp)}`
                          : 'Select a next card or wait for a request'}
                      </span>
                    </article>
                  </div>

                  <section className="history-panel">
                    <div className="panel-header compact">
                      <div>
                        <p className="eyebrow">Recent actions</p>
                        <h3>Undo timeline</h3>
                      </div>
                    </div>
                    <div className="history-list">
                      {snapshot.history.slice(0, 6).map((entry) => {
                        const participantName = entry.participantId
                          ? participantIndex.get(entry.participantId)?.name ?? 'Unknown participant'
                          : participantIndex.get(entry.before.action.participantId)?.name ?? 'Unknown participant'

                        return (
                          <div key={entry.id} className="history-item">
                            <strong>{participantName}</strong>
                            <span>
                              {entry.kind === 'approve' ? 'Approved' : 'Skipped'} {entry.before.action.type}
                            </span>
                            <span>{formatTime(entry.createdAt)}</span>
                            {entry.undone ? <span className="history-undone">Undone</span> : null}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                </>
              ) : (
                <div className="empty-panel large">
                  {roundMissing
                    ? 'That round code does not exist yet. Create it on one device, then open the same code here.'
                    : 'Create or join a round to open the live dashboard.'}
                </div>
              )}
            </section>

            <aside className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Live ranking</p>
                  <h2>Precedence sheet</h2>
                </div>
              </div>

              {snapshot.round ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Name</th>
                        <th>Speak Count</th>
                        <th>Last Action</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedParticipants.map((participant, index) => {
                        const status = getParticipantStatus(
                          participant.id,
                          snapshot.round?.activeParticipantId ?? null,
                          snapshot.actions,
                        )

                        return (
                          <tr key={participant.id}>
                            <td>{index + 1}</td>
                            <td>{participant.name}</td>
                            <td>{participant.speakCount}</td>
                            <td>{formatTime(participant.lastActionTime)}</td>
                            <td>
                              <span className={`status-chip ${status}`}>{status}</span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-panel">The precedence sheet will appear once a round is live.</div>
              )}
            </aside>
          </main>
        </>
      )}
    </div>
  )
}

export default App
