import { useEffect, useMemo, useState } from 'react'
import { useRoundRealtime } from './hooks/useRoundRealtime'
import { firebaseReady } from './lib/firebase'
import { buildParticipantIndex, getParticipantStatus, rankPendingActions, sortParticipants } from './lib/roundEngine'
import {
  addParticipant,
  approveNextAction,
  castVote,
  closeVote,
  createRound,
  endSpeechTimer,
  joinParticipant,
  openVote,
  openPlacardWindow,
  requestAction,
  skipAction,
  startSpeechTimer,
  startRound,
  undoLatestChange,
  updateParticipant,
} from './lib/roundStore'
import type { Participant, VoteRequirement } from './types'

type UserRole = 'po' | 'participant'
type LandingStep = 'home' | 'po' | 'participant-room' | 'participant-name'

type EditableParticipant = {
  name: string
  initialPrecedence: string
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

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function createEditableParticipant(participant: Participant): EditableParticipant {
  return {
    name: participant.name,
    initialPrecedence: String(participant.initialPrecedence),
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(errorMessage))
    }, timeoutMs)

    void promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function App() {
  const [currentRoundId, setCurrentRoundId] = useState<string | null>(getInitialRoundId)
  const [role, setRole] = useState<UserRole | null>(getInitialRole)
  const [landingStep, setLandingStep] = useState<LandingStep>('home')
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [roundNameInput, setRoundNameInput] = useState('NSDA Round 1')
  const [joinRoundCode, setJoinRoundCode] = useState(getInitialRoundId() ?? '')
  const [joinPreviewRoundId, setJoinPreviewRoundId] = useState<string | null>(null)
  const [selectedJoinParticipantId, setSelectedJoinParticipantId] = useState('')
  const [voteRequirement, setVoteRequirement] = useState<VoteRequirement>('majority')
  const [newParticipantName, setNewParticipantName] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [uiError, setUiError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [joinedParticipantId, setJoinedParticipantId] = useState<string | null>(
    currentRoundId ? window.localStorage.getItem(participantStorageKey(currentRoundId)) : null,
  )
  const [editableParticipants, setEditableParticipants] = useState<Record<string, EditableParticipant>>({})

  const snapshot = useRoundRealtime(currentRoundId)
  const joinPreviewSnapshot = useRoundRealtime(joinPreviewRoundId)

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
  const activeVote =
    snapshot.round?.activeVoteId
      ? snapshot.votes.find((vote) => vote.id === snapshot.round?.activeVoteId) ?? null
      : null
  const latestClosedVote = snapshot.votes.find((vote) => vote.status === 'closed') ?? null
  const activeVoteBallots = activeVote
    ? snapshot.ballots.filter((ballot) => ballot.voteId === activeVote.id)
    : []
  const currentParticipantBallot =
    activeVote && joinedParticipantId
      ? activeVoteBallots.find((ballot) => ballot.participantId === joinedParticipantId) ?? null
      : null
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
  const speechPhase = snapshot.round?.speechPhase ?? 'idle'
  const voteOpen = Boolean(activeVote && activeVote.status === 'open')
  const speechElapsedMs =
    speechPhase === 'timing' && snapshot.round?.activeSpeechStartedAt
      ? currentTime - snapshot.round.activeSpeechStartedAt
      : 0
  const sortedJoinPreviewParticipants = useMemo(
    () => sortParticipants(joinPreviewSnapshot.participants),
    [joinPreviewSnapshot.participants],
  )

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
    if (!snapshot.round?.placardWindowEndsAt && speechPhase !== 'timing') {
      return
    }

    const timer = window.setInterval(() => {
      setCurrentTime(Date.now())
    }, 250)

    return () => window.clearInterval(timer)
  }, [snapshot.round?.placardWindowEndsAt, speechPhase])

  useEffect(() => {
    if (!currentRoundId || !activeVote || activeVote.status !== 'open') {
      return
    }

    if (snapshot.participants.length === 0 || activeVoteBallots.length < snapshot.participants.length) {
      return
    }

    void closeVote(currentRoundId).catch(() => {})
  }, [activeVote, activeVoteBallots.length, currentRoundId, snapshot.participants.length])

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
    setJoinPreviewRoundId(null)
    setSelectedJoinParticipantId('')
    setJoinedParticipantId(null)
    setUiError(null)
    setLandingStep('home')
  }

  async function handleCreateRound() {
    const roundName = roundNameInput.trim()

    if (!roundName) {
      setUiError('Enter a round name before creating the round.')
      return
    }

    await runMutation('create-round', async () => {
      const roundId = await withTimeout(
        createRound(roundName, []),
        12000,
        'Creating the round timed out. Check Firestore permissions and try again.',
      )
      setRole('po')
      selectRound(roundId)
    })
  }

  function handleOpenJoinRoom() {
    const normalizedCode = joinRoundCode.trim().toUpperCase()

    if (!normalizedCode) {
      setUiError('Enter a round code before joining the room.')
      return
    }

    setUiError(null)
    setSelectedJoinParticipantId('')
    setJoinPreviewRoundId(normalizedCode)
    setJoinRoundCode(normalizedCode)
    setLandingStep('participant-name')
  }

  async function handleJoinRound() {
    const normalizedCode = joinPreviewRoundId ?? joinRoundCode.trim().toUpperCase()

    if (!normalizedCode) {
      setUiError('Join a room before choosing your name.')
      return
    }

    await runMutation('join-round', async () => {
      const participantId = await joinParticipant(normalizedCode, selectedJoinParticipantId)
      window.localStorage.setItem(participantStorageKey(normalizedCode), participantId)
      setJoinedParticipantId(participantId)
      setRole('participant')
      setLandingStep('participant-name')
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

    const initialPrecedence = Number.parseInt(draft.initialPrecedence, 10)

    await runMutation(`save-participant-${participantId}`, async () => {
      await updateParticipant(currentRoundId, {
        ...existing,
        name: draft.name,
        initialPrecedence: Number.isNaN(initialPrecedence) ? existing.initialPrecedence : initialPrecedence,
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
      await openPlacardWindow(currentRoundId, 10000)
    })
  }

  async function handleOpenVote() {
    if (!currentRoundId) {
      return
    }

    await runMutation('open-vote', async () => {
      await openVote(currentRoundId, voteRequirement)
    })
  }

  async function handleCastVote(choice: 'aye' | 'nay' | 'abstain') {
    if (!currentRoundId || !activeVote || !joinedParticipantId) {
      return
    }

    await runMutation(`cast-vote-${choice}`, async () => {
      await castVote(currentRoundId, activeVote.id, joinedParticipantId, choice)
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

  async function handleStartSpeechTimer() {
    if (!currentRoundId) {
      return
    }

    await runMutation('start-speech', async () => {
      await startSpeechTimer(currentRoundId)
    })
  }

  async function handleEndSpeechTimer() {
    if (!currentRoundId) {
      return
    }

    await runMutation('end-speech', async () => {
      await endSpeechTimer(currentRoundId)
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

              {landingStep === 'home' ? (
                <section className="entry-grid">
                  <article className="control-card">
                    <p className="eyebrow">Presiding officer</p>
                    <h2>Create a round</h2>
                    <p className="muted">
                      Start a room, then add or edit the precedence sheet on the next screen.
                    </p>
                    <div className="entry-card-actions">
                      <button
                        className="primary-button"
                        onClick={() => {
                          setUiError(null)
                          setLandingStep('po')
                        }}
                      >
                        Create round
                      </button>
                    </div>
                  </article>

                  <article className="control-card">
                    <p className="eyebrow">Participant</p>
                    <h2>Join a round</h2>
                    <p className="muted">
                      Enter the PO's round code and your name on the next screen to join live.
                    </p>
                    <div className="entry-card-actions">
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setUiError(null)
                          setLandingStep('participant-room')
                        }}
                      >
                        Join round
                      </button>
                    </div>
                  </article>
                </section>
              ) : landingStep === 'po' ? (
                <section className="centered-flow">
                  <article className="control-card flow-card">
                    <p className="eyebrow">Presiding officer</p>
                    <h2>Create your room</h2>
                    <p className="muted">
                      Create the round first. You will add participants and set precedence on the
                      next screen.
                    </p>
                    <label className="field">
                      <span>Round name</span>
                      <input
                        value={roundNameInput}
                        onChange={(event) => setRoundNameInput(event.target.value)}
                        placeholder="NSDA Round 1"
                      />
                    </label>
                    <div className="button-row flow-actions">
                      <button
                        className="primary-button"
                        onClick={handleCreateRound}
                        disabled={Boolean(busyAction)}
                      >
                        {busyAction === 'create-round' ? 'Creating...' : 'Create round'}
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => setLandingStep('home')}
                        disabled={Boolean(busyAction)}
                      >
                        Back
                      </button>
                    </div>
                  </article>
                </section>
              ) : landingStep === 'participant-room' ? (
                <section className="centered-flow">
                  <article className="control-card flow-card">
                    <p className="eyebrow">Participant</p>
                    <h2>Join your room</h2>
                    <label className="field">
                      <span>Round code</span>
                      <input
                        value={joinRoundCode}
                        onChange={(event) => {
                          setJoinRoundCode(event.target.value.toUpperCase())
                          setJoinPreviewRoundId(null)
                          setSelectedJoinParticipantId('')
                        }}
                        placeholder="Paste the PO's round code"
                      />
                    </label>
                    <div className="button-row flow-actions">
                      <button
                        className="secondary-button"
                        onClick={handleOpenJoinRoom}
                        disabled={Boolean(busyAction)}
                      >
                        Join room
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setJoinPreviewRoundId(null)
                          setLandingStep('home')
                        }}
                        disabled={Boolean(busyAction)}
                      >
                        Back
                      </button>
                    </div>
                  </article>
                </section>
              ) : (
                <section className="centered-flow">
                  <article className="control-card flow-card">
                    <p className="eyebrow">Participant</p>
                    <h2>Choose your name</h2>
                    <p className="muted">
                      Room code <strong>{joinPreviewRoundId ?? joinRoundCode.trim().toUpperCase()}</strong>
                    </p>
                    <label className="field">
                      <span>Your name</span>
                      <select
                        value={selectedJoinParticipantId}
                        onChange={(event) => setSelectedJoinParticipantId(event.target.value)}
                        disabled={!joinPreviewRoundId || joinPreviewSnapshot.loading || !joinPreviewSnapshot.round}
                      >
                        <option value="">
                          {joinPreviewRoundId
                            ? joinPreviewSnapshot.loading
                              ? 'Loading participants...'
                              : !joinPreviewSnapshot.round
                                ? 'Room not found'
                              : sortedJoinPreviewParticipants.length > 0
                                ? 'Choose your name'
                                : 'No participants added yet'
                            : 'Enter a round code first'}
                        </option>
                        {sortedJoinPreviewParticipants.map((participant) => (
                          <option key={participant.id} value={participant.id}>
                            {participant.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {joinPreviewRoundId && !joinPreviewSnapshot.loading && !joinPreviewSnapshot.round ? (
                      <p className="muted">That room code was not found. Go back and check the code.</p>
                    ) : null}
                    {joinPreviewRoundId && sortedJoinPreviewParticipants.length > 0 ? (
                      <div className="table-wrap compact-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Precedence</th>
                              <th>Name</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedJoinPreviewParticipants.map((participant) => (
                              <tr key={participant.id}>
                                <td>{participant.initialPrecedence}</td>
                                <td>{participant.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    <div className="button-row flow-actions">
                      <button
                        className="secondary-button"
                        onClick={handleJoinRound}
                        disabled={
                          Boolean(busyAction) ||
                          !selectedJoinParticipantId ||
                          !joinPreviewRoundId ||
                          !joinPreviewSnapshot.round
                        }
                      >
                        {busyAction === 'join-round' ? 'Joining...' : 'Join round'}
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() => {
                          setJoinPreviewRoundId(null)
                          setSelectedJoinParticipantId('')
                          setLandingStep('participant-room')
                        }}
                        disabled={Boolean(busyAction)}
                      >
                        Back
                      </button>
                    </div>
                  </article>
                </section>
              )}
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
                    <h2>Set the precedence list</h2>
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
                        <th>Save</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedParticipants.map((participant) => {
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
                                value={draft.initialPrecedence}
                                onChange={(event) =>
                                  setEditableParticipants((current) => ({
                                    ...current,
                                    [participant.id]: {
                                      ...draft,
                                      initialPrecedence: event.target.value,
                                    },
                                  }))
                                }
                                inputMode="numeric"
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

                {speechPhase === 'idle' ? (
                  <>
                    <div className="spotlight-card">
                      <span className="card-label">Next speaker</span>
                      <strong>
                        {nextSpeaker
                          ? participantIndex.get(nextSpeaker.participantId)?.name ?? 'Unknown participant'
                          : 'No placards raised'}
                      </strong>
                      <span>
                        {nextSpeaker
                          ? `Precedence ${participantIndex.get(nextSpeaker.participantId)?.initialPrecedence ?? '-'}`
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
                            : 'Open placards for 10s'}
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
                  </>
                ) : (
                  <div className="timing-stage">
                    <div className="spotlight-card">
                      <span className="card-label">
                        {speechPhase === 'awaiting_start' ? 'Speaker approved' : 'Speech in progress'}
                      </span>
                      <strong>
                        {snapshot.round.activeParticipantId
                          ? participantIndex.get(snapshot.round.activeParticipantId)?.name ?? 'Unknown participant'
                          : 'No active speaker'}
                      </strong>
                      <span>
                        {speechPhase === 'awaiting_start'
                          ? 'Start the speech timer when the student begins speaking.'
                          : `Started at ${formatTime(snapshot.round.activeSpeechStartedAt ?? null)}`}
                      </span>
                      {speechPhase === 'timing' ? (
                        <div className="stopwatch-display">{formatDuration(speechElapsedMs)}</div>
                      ) : null}
                    </div>

                    <div className="command-row">
                      {speechPhase === 'awaiting_start' ? (
                        <button
                          className="primary-button"
                          onClick={handleStartSpeechTimer}
                          disabled={Boolean(busyAction)}
                        >
                          {busyAction === 'start-speech' ? 'Starting...' : 'Start speech'}
                        </button>
                      ) : (
                        <button
                          className="primary-button"
                          onClick={handleEndSpeechTimer}
                          disabled={Boolean(busyAction)}
                        >
                          {busyAction === 'end-speech' ? 'Ending...' : 'End speech'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

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
                        ? `Precedence ${participantIndex.get(snapshot.round.activeParticipantId)?.initialPrecedence ?? '-'}`
                        : 'Approve a raised placard to mark the active speaker.'}
                    </span>
                  </article>
                  <article className="summary-card">
                    <span className="card-label">Round code</span>
                    <strong>{snapshot.round.id}</strong>
                    <span>{copied ? 'Copied to clipboard' : 'Share this code so students can join.'}</span>
                  </article>
                </div>

                <div className="summary-card vote-card">
                  <span className="card-label">Vote controls</span>
                  <div className="vote-controls">
                    <select
                      value={voteRequirement}
                      onChange={(event) => setVoteRequirement(event.target.value as VoteRequirement)}
                      disabled={voteOpen || Boolean(busyAction)}
                    >
                      <option value="majority">Majority</option>
                      <option value="two_thirds">2/3 rounding up</option>
                    </select>
                    <button
                      className="secondary-button"
                      onClick={handleOpenVote}
                      disabled={voteOpen || Boolean(busyAction)}
                    >
                      {voteOpen
                        ? 'Vote open'
                        : busyAction === 'open-vote'
                          ? 'Opening...'
                          : 'Open vote'}
                    </button>
                  </div>
                  <span>
                    {activeVote
                      ? `${activeVote.requirement === 'majority' ? 'Majority' : '2/3 rounding up'} vote in progress • ${activeVoteBallots.length}/${snapshot.participants.length} voted`
                      : 'Open a floor vote when the chamber needs to vote aye, nay, or abstain.'}
                  </span>
                </div>

                <div className="summary-card vote-card">
                  <span className="card-label">Last vote record</span>
                  <strong>
                    {latestClosedVote
                      ? `${latestClosedVote.ayeCount} ayes to ${latestClosedVote.nayCount} nays`
                      : 'No vote record yet'}
                  </strong>
                  <span>
                    {latestClosedVote
                      ? `${latestClosedVote.abstainCount} abstains • ${latestClosedVote.requirement === 'majority' ? 'Majority' : '2/3 rounding up'} • ${latestClosedVote.passed ? 'Passed' : 'Failed'}`
                      : 'Completed votes will appear here once everyone has voted.'}
                  </span>
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
                            <p>Precedence {participant.initialPrecedence}</p>
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
                        <th>Precedence</th>
                        <th>Name</th>
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
                            <td>{participant.initialPrecedence}</td>
                            <td>{participant.name}</td>
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
                        ? 'When the PO opens placards, this button activates for ten seconds.'
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
                      {joinedParticipant
                        ? `Precedence ${joinedParticipant.initialPrecedence}`
                        : 'Not found'}
                    </strong>
                    <span>
                      {joinedParticipant
                        ? joinedParticipant.name
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

                <div className="summary-card vote-card">
                  <span className="card-label">Vote</span>
                  <strong>
                    {voteOpen
                      ? `${activeVote?.requirement === 'majority' ? 'Majority' : '2/3 rounding up'} vote open`
                      : latestClosedVote
                        ? `${latestClosedVote.ayeCount} ayes to ${latestClosedVote.nayCount} nays`
                        : 'No active vote'}
                  </strong>
                  <span>
                    {voteOpen
                      ? `${activeVoteBallots.length} of ${snapshot.participants.length} have voted`
                      : latestClosedVote
                        ? `${latestClosedVote.abstainCount} abstains`
                        : 'The PO can open a vote at any time.'}
                  </span>
                  <div className="vote-actions">
                    <button
                      className="secondary-button"
                      onClick={() => handleCastVote('aye')}
                      disabled={!voteOpen || Boolean(busyAction)}
                    >
                      {currentParticipantBallot?.choice === 'aye' ? 'Aye selected' : 'Aye'}
                    </button>
                    <button
                      className="ghost-button"
                      onClick={() => handleCastVote('nay')}
                      disabled={!voteOpen || Boolean(busyAction)}
                    >
                      {currentParticipantBallot?.choice === 'nay' ? 'Nay selected' : 'Nay'}
                    </button>
                    <button
                      className="ghost-button"
                      onClick={() => handleCastVote('abstain')}
                      disabled={!voteOpen || Boolean(busyAction)}
                    >
                      {currentParticipantBallot?.choice === 'abstain' ? 'Abstain selected' : 'Abstain'}
                    </button>
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Precedence</th>
                        <th>Name</th>
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
                            <td>{participant.initialPrecedence}</td>
                            <td>{participant.name}</td>
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
