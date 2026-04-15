import { useEffect, useMemo, useState } from 'react'
import { useRoundRealtime } from './hooks/useRoundRealtime'
import { firebaseReady } from './lib/firebase'
import { buildParticipantIndex, getParticipantStatus, rankPendingActions, sortParticipants } from './lib/roundEngine'
import {
  addParticipant,
  approveNextAction,
  createRound,
  joinParticipant,
  openPlacardWindow,
  requestAction,
  skipAction,
  startRound,
  undoLatestChange,
  updateParticipant,
} from './lib/roundStore'
import type { Participant } from './types'

type UserRole = 'po' | 'participant'

type EditableParticipant = {
  name: string
  speakCount: string
  lastActionTime: string
}

const ROUND_STORAGE_KEY = 'po-live-round-id'
const ROLE_STORAGE_KEY = 'po-live-role'

function getHashRoundId() {
  return window.location.hash.replace('#', '').trim().toUpperCase() || null
}

function getInitialRoundId() {
  return getHashRoundId() ?? window.localStorage.getItem(ROUND_STORAGE_KEY)?.toUpperCase() ?? null
}

function getInitialRole(): UserRole | null {
  const storedRole = window.localStorage.getItem(ROLE_STORAGE_KEY)
  return storedRole === 'po' || storedRole === 'participant' ? storedRole : null
}

function participantStorageKey(roundId: string) {
  return `po-live-participant-${roundId}`
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

function formatDateTimeInput(timestamp: number | null) {
  if (!timestamp) {
    return ''
  }

  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60000)
  return local.toISOString().slice(0, 16)
}

function parseDateTimeInput(value: string) {
  if (!value) {
    return null
  }

  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function createEditableParticipant(participant: Participant): EditableParticipant {
  return {
    name: participant.name,
    speakCount: String(participant.speakCount),
    lastActionTime: formatDateTimeInput(participant.lastActionTime),
  }
}

function App() {
  const [currentRoundId, setCurrentRoundId] = useState<string | null>(getInitialRoundId)
  const [role, setRole] = useState<UserRole | null>(getInitialRole)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [roundNameInput, setRoundNameInput] = useState('NSDA Round 1')
  const [seedParticipantsInput, setSeedParticipantsInput] = useState('')
  const [joinRoundCode, setJoinRoundCode] = useState(getInitialRoundId() ?? '')
  const [joinNameInput, setJoinNameInput] = useState('')
  const [newParticipantName, setNewParticipantName] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [uiError, setUiError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [joinedParticipantId, setJoinedParticipantId] = useState<string | null>(
    currentRoundId ? window.localStorage.getItem(participantStorageKey(currentRoundId)) : null,
  )
  const [editableParticipants, setEditableParticipants] = useState<Record<string, EditableParticipant>>({})

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
  const canUndo = snapshot.history.some((entry) => !entry.undone)
  const joinedParticipant = joinedParticipantId ? participantIndex.get(joinedParticipantId) ?? null : null
  const hasPendingSpeak = Boolean(
    joinedParticipantId &&
      snapshot.actions.some(
        (action) =>
          action.participantId === joinedParticipantId &&
          action.type === 'speak' &&
          action.status === 'pending',
      ),
  )
  const roundMissing = Boolean(currentRoundId && !snapshot.loading && !snapshot.round)
  const placardWindowRemainingMs = Math.max(
    0,
    (snapshot.round?.placardWindowEndsAt ?? 0) - currentTime,
  )
  const placardsOpen = placardWindowRemainingMs > 0

  useEffect(() => {
    const onHashChange = () => {
      const nextRoundId = getHashRoundId()
      setCurrentRoundId(nextRoundId)
      setJoinRoundCode(nextRoundId ?? '')
    }

    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!currentRoundId) {
      window.localStorage.removeItem(ROUND_STORAGE_KEY)
      setJoinedParticipantId(null)
      return
    }

    window.localStorage.setItem(ROUND_STORAGE_KEY, currentRoundId)
    setJoinedParticipantId(window.localStorage.getItem(participantStorageKey(currentRoundId)))
  }, [currentRoundId])

  useEffect(() => {
    if (!role) {
      window.localStorage.removeItem(ROLE_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(ROLE_STORAGE_KEY, role)
  }, [role])

  useEffect(() => {
    setEditableParticipants((current) => {
      const nextState: Record<string, EditableParticipant> = {}

      for (const participant of snapshot.participants) {
        nextState[participant.id] = current[participant.id] ?? createEditableParticipant(participant)
      }

      return nextState
    })
  }, [snapshot.participants])

  useEffect(() => {
    if (!snapshot.round?.placardWindowEndsAt) {
      return
    }

    const timer = window.setInterval(() => {
      setCurrentTime(Date.now())
    }, 250)

    return () => window.clearInterval(timer)
  }, [snapshot.round?.placardWindowEndsAt])

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
    setJoinRoundCode(normalized ?? '')
    window.location.hash = normalized ?? ''
  }

  function leaveRound() {
    if (currentRoundId) {
      window.localStorage.removeItem(participantStorageKey(currentRoundId))
    }

    setRole(null)
    setCurrentRoundId(null)
    setJoinRoundCode('')
    setJoinNameInput('')
    setJoinedParticipantId(null)
    setUiError(null)
  }

  async function handleCreateRound() {
    const roundName = roundNameInput.trim()

    if (!roundName) {
      setUiError('Enter a round name before creating the round.')
      return
    }

    await runMutation('create-round', async () => {
      const roundId = await createRound(roundName, parseParticipantNames(seedParticipantsInput))
      setRole('po')
      selectRound(roundId)
    })
  }

  async function handleJoinRound() {
    const normalizedCode = joinRoundCode.trim().toUpperCase()

    if (!normalizedCode) {
      setUiError('Enter a round code before joining.')
      return
    }

    await runMutation('join-round', async () => {
      const participantId = await joinParticipant(normalizedCode, joinNameInput)
      window.localStorage.setItem(participantStorageKey(normalizedCode), participantId)
      setJoinedParticipantId(participantId)
      setRole('participant')
      selectRound(normalizedCode)
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

  async function handleSaveParticipant(participantId: string) {
    if (!currentRoundId) {
      return
    }

    const draft = editableParticipants[participantId]
    const existing = participantIndex.get(participantId)

    if (!draft || !existing) {
      return
    }

    const speakCount = Number.parseInt(draft.speakCount, 10)

    await runMutation(`save-participant-${participantId}`, async () => {
      await updateParticipant(currentRoundId, {
        ...existing,
        name: draft.name,
        speakCount: Number.isNaN(speakCount) ? 0 : speakCount,
        lastActionTime: parseDateTimeInput(draft.lastActionTime),
      })
    })
  }

  async function handleStartRound() {
    if (!currentRoundId) {
      return
    }

    await runMutation('start-round', async () => {
      await startRound(currentRoundId)
    })
  }

  async function handleOpenPlacards() {
    if (!currentRoundId) {
      return
    }

    await runMutation('open-placards', async () => {
      await openPlacardWindow(currentRoundId, 5000)
    })
  }

  async function handleRaisePlacard() {
    if (!currentRoundId || !joinedParticipantId) {
      return
    }

    await runMutation('raise-placard', async () => {
      await requestAction(currentRoundId, joinedParticipantId, 'speak')
    })
  }

  async function handleApproveNextSpeaker() {
    if (!currentRoundId) {
      return
    }

    await runMutation('approve-speak', async () => {
      await approveNextAction(currentRoundId, 'speak')
    })
  }

  async function handleSkipNextSpeaker() {
    if (!currentRoundId || !nextSpeaker) {
      return
    }

    await runMutation('skip-speak', async () => {
      await skipAction(currentRoundId, nextSpeaker.id)
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

    await navigator.clipboard.writeText(
      `${window.location.origin}${window.location.pathname}#${currentRoundId}`,
    )
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const showLanding = !currentRoundId || !role
  const setupMode = role === 'po' && snapshot.round?.status === 'setup'
  const livePoMode = role === 'po' && snapshot.round?.status === 'live'
  const participantMode = role === 'participant'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Real-time tournament mode</p>
          <h1>PO Queue + P&amp;R Live System</h1>
          <p className="subcopy">
            A simpler NSDA round flow: land, choose PO or participant, join the same room, then
            run timed placard windows live.
          </p>
        </div>

        <div className="topbar-actions">
          <div className="badge">{firebaseReady ? 'Firebase live' : 'Firebase setup needed'}</div>
          {snapshot.round ? <div className="badge accent">{snapshot.round.name}</div> : null}
        </div>
      </header>

      {!snapshot.firebaseReady ? (
        <section className="setup-card">
          <h2>Connect Firestore first</h2>
          <p>Add your Firebase web config as Vite environment variables, then restart the app.</p>
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
          {uiError || snapshot.error ? <div className="error-banner">{uiError ?? snapshot.error}</div> : null}

          {showLanding ? (
            <main className="landing-grid">
              <section className="hero-card">
                <p className="eyebrow">Start here</p>
                <h2>Choose how you are entering the round</h2>
                <p className="subcopy">
                  Presiding officers create the room and set the initial precedence sheet. Students
                  join with their name and appear automatically on the PO screen.
                </p>
              </section>

              <section className="entry-grid">
                <article className="control-card">
                  <p className="eyebrow">Presiding officer</p>
                  <h2>Create a round</h2>
                  <label className="field">
                    <span>Round name</span>
                    <input
                      value={roundNameInput}
                      onChange={(event) => setRoundNameInput(event.target.value)}
                      placeholder="NSDA Round 1"
                    />
                  </label>
                  <label className="field">
                    <span>Optional starting roster</span>
                    <textarea
                      value={seedParticipantsInput}
                      onChange={(event) => setSeedParticipantsInput(event.target.value)}
                      placeholder={'One participant per line\nAlice\nBen\nRoger'}
                      rows={6}
                    />
                  </label>
                  <button
                    className="primary-button"
                    onClick={handleCreateRound}
                    disabled={Boolean(busyAction)}
                  >
                    {busyAction === 'create-round' ? 'Creating...' : 'Create round as PO'}
                  </button>
                </article>

                <article className="control-card">
                  <p className="eyebrow">Participant</p>
                  <h2>Join a round</h2>
                  <label className="field">
                    <span>Round code</span>
                    <input
                      value={joinRoundCode}
                      onChange={(event) => setJoinRoundCode(event.target.value.toUpperCase())}
                      placeholder="Paste the PO's round code"
                    />
                  </label>
                  <label className="field">
                    <span>Your name</span>
                    <input
                      value={joinNameInput}
                      onChange={(event) => setJoinNameInput(event.target.value)}
                      placeholder="Enter your name"
                    />
                  </label>
                  <button
                    className="secondary-button"
                    onClick={handleJoinRound}
                    disabled={Boolean(busyAction)}
                  >
                    {busyAction === 'join-round' ? 'Joining...' : 'Join round'}
                  </button>
                </article>
              </section>
            </main>
          ) : roundMissing ? (
            <section className="setup-card">
              <h2>Round not found</h2>
              <p>
                That round code does not exist yet. Go back and enter a valid code or create a new
                room as the PO.
              </p>
              <button className="ghost-button" onClick={leaveRound}>
                Back to landing page
              </button>
            </section>
          ) : setupMode && snapshot.round ? (
            <main className="po-layout">
              <aside className="side-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Round setup</p>
                    <h2>{snapshot.round.name}</h2>
                  </div>
                </div>
                <div className="status-stack">
                  <div className="status-metric">
                    <span>Round code</span>
                    <strong>{snapshot.round.id}</strong>
                  </div>
                  <div className="status-metric">
                    <span>Participants joined</span>
                    <strong>{snapshot.participants.length}</strong>
                  </div>
                  <div className="status-metric">
                    <span>Status</span>
                    <strong>Setup</strong>
                  </div>
                </div>
                <div className="button-column">
                  <button className="secondary-button" onClick={handleCopyLink}>
                    {copied ? 'Copied link' : 'Copy join link'}
                  </button>
                  <button
                    className="primary-button"
                    onClick={handleStartRound}
                    disabled={Boolean(busyAction)}
                  >
                    {busyAction === 'start-round' ? 'Starting...' : 'Start round'}
                  </button>
                  <button className="ghost-button" onClick={leaveRound}>
                    Leave round
                  </button>
                </div>
              </aside>

              <section className="main-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">PO controls</p>
                    <h2>Set precedence and recency</h2>
                  </div>
                </div>

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

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Precedence</th>
                        <th>Last Action</th>
                        <th>Save</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.participants.map((participant) => {
                        const draft = editableParticipants[participant.id] ?? createEditableParticipant(participant)

                        return (
                          <tr key={participant.id}>
                            <td>
                              <input
                                value={draft.name}
                                onChange={(event) =>
                                  setEditableParticipants((current) => ({
                                    ...current,
                                    [participant.id]: {
                                      ...draft,
                                      name: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                value={draft.speakCount}
                                onChange={(event) =>
                                  setEditableParticipants((current) => ({
                                    ...current,
                                    [participant.id]: {
                                      ...draft,
                                      speakCount: event.target.value,
                                    },
                                  }))
                                }
                                inputMode="numeric"
                              />
                            </td>
                            <td>
                              <input
                                type="datetime-local"
                                value={draft.lastActionTime}
                                onChange={(event) =>
                                  setEditableParticipants((current) => ({
                                    ...current,
                                    [participant.id]: {
                                      ...draft,
                                      lastActionTime: event.target.value,
                                    },
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <button
                                className="ghost-button compact-button"
                                onClick={() => handleSaveParticipant(participant.id)}
                                disabled={Boolean(busyAction)}
                              >
                                Save
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </main>
          ) : livePoMode && snapshot.round ? (
            <main className="dashboard-grid simplified">
              <section className="panel focus-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Live floor</p>
                    <h2>PO controls</h2>
                  </div>
                </div>

                <div className="spotlight-card">
                  <span className="card-label">Next speaker</span>
                  <strong>
                    {nextSpeaker
                      ? participantIndex.get(nextSpeaker.participantId)?.name ?? 'Unknown participant'
                      : 'No placards raised'}
                  </strong>
                  <span>
                    {nextSpeaker
                      ? `Queued at ${formatTime(nextSpeaker.timestamp)}`
                      : 'Open placards to let students raise for the next speech.'}
                  </span>
                </div>

                <div className="command-row">
                  <button
                    className="primary-button"
                    onClick={handleOpenPlacards}
                    disabled={placardsOpen || Boolean(busyAction)}
                  >
                    {placardsOpen
                      ? `Placards open ${Math.ceil(placardWindowRemainingMs / 1000)}s`
                      : busyAction === 'open-placards'
                        ? 'Opening...'
                        : 'Open placards for 5s'}
                  </button>
                  <button
                    className="secondary-button"
                    onClick={handleApproveNextSpeaker}
                    disabled={!nextSpeaker || Boolean(busyAction)}
                  >
                    {busyAction === 'approve-speak' ? 'Approving...' : 'Approve next speaker'}
                  </button>
                  <button
                    className="ghost-button"
                    onClick={handleSkipNextSpeaker}
                    disabled={!nextSpeaker || Boolean(busyAction)}
                  >
                    {busyAction === 'skip-speak' ? 'Skipping...' : 'Skip'}
                  </button>
                  <button
                    className="ghost-button"
                    onClick={handleUndo}
                    disabled={!canUndo || Boolean(busyAction)}
                  >
                    {busyAction === 'undo' ? 'Undoing...' : 'Undo'}
                  </button>
                </div>

                <div className="summary-grid single-column">
                  <article className="summary-card">
                    <span className="card-label">Current active speaker</span>
                    <strong>
                      {snapshot.round.activeParticipantId
                        ? participantIndex.get(snapshot.round.activeParticipantId)?.name ?? 'Unknown participant'
                        : 'No active speaker'}
                    </strong>
                    <span>
                      {snapshot.round.activeParticipantId
                        ? `Last approved at ${formatTime(
                            participantIndex.get(snapshot.round.activeParticipantId)?.lastActionTime ?? null,
                          )}`
                        : 'Approve a raised placard to mark the active speaker.'}
                    </span>
                  </article>
                  <article className="summary-card">
                    <span className="card-label">Round code</span>
                    <strong>{snapshot.round.id}</strong>
                    <span>{copied ? 'Copied to clipboard' : 'Share this code so students can join.'}</span>
                  </article>
                </div>

                <div className="button-row">
                  <button className="secondary-button" onClick={handleCopyLink}>
                    {copied ? 'Copied link' : 'Copy join link'}
                  </button>
                  <button className="ghost-button" onClick={leaveRound}>
                    Leave round
                  </button>
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Joined participants</p>
                    <h2>Round roster</h2>
                  </div>
                </div>
                <div className="participant-list">
                  {sortedParticipants.map((participant) => {
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
                      </article>
                    )
                  })}
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Live ranking</p>
                    <h2>Precedence sheet</h2>
                  </div>
                </div>
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
              </section>
            </main>
          ) : participantMode && snapshot.round ? (
            <main className="participant-layout">
              <section className="participant-hero">
                <p className="eyebrow">Joined round</p>
                <h2>{snapshot.round.name}</h2>
                <p className="subcopy">
                  {joinedParticipant
                    ? `You are in as ${joinedParticipant.name}. Wait for the PO to open placards, then raise yours.`
                    : 'You are connected to the round. If your name is missing, rejoin from the landing page.'}
                </p>
              </section>

              <section className="participant-card-large">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Your controls</p>
                    <h2>Raise placard</h2>
                  </div>
                </div>

                <div className="spotlight-card participant-spotlight">
                  <span className="card-label">Placard window</span>
                  <strong>
                    {snapshot.round.status === 'setup'
                      ? 'Waiting for the PO to start the round'
                      : placardsOpen
                        ? `Open for ${Math.ceil(placardWindowRemainingMs / 1000)} seconds`
                        : 'Closed'}
                  </strong>
                  <span>
                    {hasPendingSpeak
                      ? 'Your placard is already in the queue.'
                      : snapshot.round.status === 'live'
                        ? 'When the PO opens placards, this button activates for five seconds.'
                        : 'The room is still in setup mode.'}
                  </span>
                </div>

                <button
                  className="primary-button giant-button"
                  onClick={handleRaisePlacard}
                  disabled={
                    !joinedParticipant ||
                    !placardsOpen ||
                    hasPendingSpeak ||
                    Boolean(busyAction) ||
                    snapshot.round.status !== 'live'
                  }
                >
                  {hasPendingSpeak
                    ? 'Placard raised'
                    : busyAction === 'raise-placard'
                      ? 'Submitting...'
                      : 'Raise placard'}
                </button>

                <div className="summary-grid single-column">
                  <article className="summary-card">
                    <span className="card-label">Your standing</span>
                    <strong>
                      {joinedParticipant ? `Precedence ${joinedParticipant.speakCount}` : 'Not found'}
                    </strong>
                    <span>
                      {joinedParticipant
                        ? `Last action ${formatTime(joinedParticipant.lastActionTime)}`
                        : 'Ask the PO to confirm your name is in the round.'}
                    </span>
                  </article>
                  <article className="summary-card">
                    <span className="card-label">Current speaker</span>
                    <strong>
                      {snapshot.round.activeParticipantId
                        ? participantIndex.get(snapshot.round.activeParticipantId)?.name ?? 'Unknown participant'
                        : 'No one active'}
                    </strong>
                    <span>Round code {snapshot.round.id}</span>
                  </article>
                </div>

                <button className="ghost-button" onClick={leaveRound}>
                  Leave round
                </button>
              </section>
            </main>
          ) : (
            <section className="setup-card">
              <h2>Loading round</h2>
              <p>Connecting to Firestore and syncing the latest room state.</p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

export default App
