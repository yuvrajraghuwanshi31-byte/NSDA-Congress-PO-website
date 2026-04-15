import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from './firebase'
import { pickFeaturedAction, rankPendingActions } from './roundEngine'
import type { Action, ActionType, HistoryEntry, Participant, Round } from '../types'

function assertDb() {
  if (!db) {
    throw new Error('Firebase is not configured. Add your VITE_FIREBASE_* values first.')
  }

  return db
}

function roundRef(roundId: string) {
  return doc(assertDb(), 'rounds', roundId)
}

function participantsRef(roundId: string) {
  return collection(roundRef(roundId), 'participants')
}

function actionsRef(roundId: string) {
  return collection(roundRef(roundId), 'actions')
}

function historyRef(roundId: string) {
  return collection(roundRef(roundId), 'history')
}

function now() {
  return Date.now()
}

function createRoundId() {
  return crypto.randomUUID().split('-')[0].toUpperCase()
}

function normalizeNames(input: string[]) {
  return [...new Set(input.map((name) => name.trim()).filter(Boolean))]
}

function nextInitialPrecedence(participants: Participant[]) {
  const highest = participants.reduce(
    (maxValue, participant) => Math.max(maxValue, participant.initialPrecedence),
    0,
  )

  return highest + 1
}

export async function createRound(name: string, participantNames: string[]) {
  const roundId = createRoundId()
  const timestamp = now()
  const round: Round = {
    id: roundId,
    name: name.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'setup',
    placardWindowEndsAt: null,
    speechPhase: 'idle',
    activeSpeechStartedAt: null,
    activeActionId: null,
    activeParticipantId: null,
    activeType: null,
  }
  const cleanedNames = normalizeNames(participantNames)
  const batch = writeBatch(assertDb())

  batch.set(roundRef(roundId), round)

  for (const participantName of cleanedNames) {
    const participantDoc = doc(participantsRef(roundId))
    const participant: Participant = {
      id: participantDoc.id,
      name: participantName,
      initialPrecedence: cleanedNames.indexOf(participantName) + 1,
      speakCount: 0,
      lastActionTime: null,
    }

    batch.set(participantDoc, participant)
  }

  await batch.commit()

  return roundId
}

export async function addParticipant(roundId: string, name: string) {
  const trimmedName = name.trim()

  if (!trimmedName) {
    return
  }

  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const participantSnapshots = await getDocs(query(participantsRef(roundId)))
  const existingParticipants = participantSnapshots.docs.map((snapshot) => snapshot.data() as Participant)
  const alreadyExists = existingParticipants.some((participant) => {
    return participant.name.toLowerCase() === trimmedName.toLowerCase()
  })

  if (alreadyExists) {
    throw new Error('A participant with that name already exists in this round.')
  }

  const timestamp = now()
  const participantDoc = doc(participantsRef(roundId))
  const participant: Participant = {
    id: participantDoc.id,
    name: trimmedName,
    initialPrecedence: nextInitialPrecedence(existingParticipants),
    speakCount: 0,
    lastActionTime: null,
  }
  const batch = writeBatch(assertDb())

  batch.set(participantDoc, participant)
  batch.set(roundRef(roundId), { updatedAt: timestamp }, { merge: true })
  await batch.commit()
}

export async function joinParticipant(roundId: string, participantId: string) {
  const trimmedId = participantId.trim()

  if (!trimmedId) {
    throw new Error('Choose your name before joining the round.')
  }

  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const participantSnapshot = await getDoc(doc(participantsRef(roundId), trimmedId))

  if (!participantSnapshot.exists()) {
    throw new Error('That participant is not on the precedence sheet yet.')
  }

  return trimmedId
}

export async function updateParticipant(roundId: string, participant: Participant) {
  const trimmedName = participant.name.trim()

  if (!trimmedName) {
    throw new Error('Participant name cannot be empty.')
  }

  const existingSnapshot = await getDoc(doc(participantsRef(roundId), participant.id))

  if (!existingSnapshot.exists()) {
    throw new Error('Participant not found.')
  }

  const batch = writeBatch(assertDb())
  const timestamp = now()

  batch.set(
    doc(participantsRef(roundId), participant.id),
    {
      ...participant,
      name: trimmedName,
      initialPrecedence: Math.max(1, participant.initialPrecedence),
      speakCount: Math.max(0, participant.speakCount),
    },
    { merge: true },
  )
  batch.set(roundRef(roundId), { updatedAt: timestamp }, { merge: true })
  await batch.commit()
}

export async function startRound(roundId: string) {
  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const timestamp = now()
  await setRoundFields(roundId, {
    status: 'live',
    placardWindowEndsAt: null,
    speechPhase: 'idle',
    activeSpeechStartedAt: null,
    updatedAt: timestamp,
  })
}

export async function openPlacardWindow(roundId: string, durationMs = 10000) {
  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const round = roundSnapshot.data() as Round

  if (round.status !== 'live') {
    throw new Error('Start the round before opening placards.')
  }

  const timestamp = now()
  await setRoundFields(roundId, {
    placardWindowEndsAt: timestamp + durationMs,
    updatedAt: timestamp,
  })
}

async function setRoundFields(roundId: string, fields: Partial<Round>) {
  const batch = writeBatch(assertDb())
  batch.set(roundRef(roundId), fields, { merge: true })
  await batch.commit()
}

export async function requestAction(roundId: string, participantId: string, type: ActionType) {
  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const round = roundSnapshot.data() as Round

  if (round.status !== 'live') {
    throw new Error('The round has not started yet.')
  }

  if (type === 'speak' && (!round.placardWindowEndsAt || round.placardWindowEndsAt <= now())) {
    throw new Error('Placards are not open right now.')
  }

  const participantSnapshot = await getDoc(doc(participantsRef(roundId), participantId))

  if (!participantSnapshot.exists()) {
    throw new Error('Participant not found.')
  }

  const existingSnapshot = await getDocs(
    query(
      actionsRef(roundId),
      where('participantId', '==', participantId),
      where('type', '==', type),
      where('status', '==', 'pending'),
    ),
  )

  if (!existingSnapshot.empty) {
    return
  }

  const timestamp = now()
  const actionDoc = doc(actionsRef(roundId))
  const action: Action = {
    id: actionDoc.id,
    participantId,
    type,
    status: 'pending',
    timestamp,
  }
  const batch = writeBatch(assertDb())

  batch.set(actionDoc, action)
  batch.set(roundRef(roundId), { updatedAt: timestamp }, { merge: true })
  await batch.commit()
}

export async function approveNextAction(roundId: string, type: ActionType) {
  const currentRoundSnapshot = await getDoc(roundRef(roundId))

  if (!currentRoundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const participantSnapshots = await getDocs(query(participantsRef(roundId)))
  const actionSnapshots = await getDocs(
    query(actionsRef(roundId), where('status', '==', 'pending'), where('type', '==', type)),
  )

  const participants = participantSnapshots.docs.map((snapshot) => snapshot.data() as Participant)
  const pendingActions = actionSnapshots.docs.map((snapshot) => snapshot.data() as Action)
  const selectedAction = rankPendingActions(pendingActions, participants, type)[0]

  if (!selectedAction) {
    return
  }

  const participant = participants.find((candidate) => candidate.id === selectedAction.participantId)

  if (!participant) {
    throw new Error('Participant record missing for pending request.')
  }

  const timestamp = now()
  const round = currentRoundSnapshot.data() as Round
  const nextParticipant: Participant = {
    ...participant,
    speakCount: participant.speakCount + (type === 'speak' ? 1 : 0),
    lastActionTime: timestamp,
  }
  const nextAction: Action = {
    ...selectedAction,
    status: 'approved',
  }
  const relatedActions =
    type === 'speak'
      ? pendingActions.filter((action) => action.id !== selectedAction.id)
      : []
  const nextRound: Round = {
    ...round,
    updatedAt: timestamp,
    placardWindowEndsAt: type === 'speak' ? null : round.placardWindowEndsAt,
    speechPhase: type === 'speak' ? 'awaiting_start' : round.speechPhase,
    activeSpeechStartedAt: type === 'speak' ? null : round.activeSpeechStartedAt,
    activeActionId: nextAction.id,
    activeParticipantId: participant.id,
    activeType: type,
  }
  const nextHistoryRef = doc(historyRef(roundId))
  const historyEntry: HistoryEntry = {
    id: nextHistoryRef.id,
    kind: 'approve',
    createdAt: timestamp,
    undone: false,
    actionId: selectedAction.id,
    participantId: participant.id,
    before: {
      round,
      participant,
      action: selectedAction,
      relatedActions,
    },
  }
  const batch = writeBatch(assertDb())

  batch.set(doc(actionsRef(roundId), selectedAction.id), nextAction)
  for (const action of relatedActions) {
    batch.set(doc(actionsRef(roundId), action.id), { ...action, status: 'skipped' })
  }
  batch.set(doc(participantsRef(roundId), participant.id), nextParticipant)
  batch.set(roundRef(roundId), nextRound)
  batch.set(nextHistoryRef, historyEntry)
  await batch.commit()
}

export async function startSpeechTimer(roundId: string) {
  const currentRoundSnapshot = await getDoc(roundRef(roundId))

  if (!currentRoundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const round = currentRoundSnapshot.data() as Round

  if (!round.activeParticipantId || round.speechPhase !== 'awaiting_start') {
    throw new Error('Approve a speaker before starting the timer.')
  }

  const timestamp = now()
  await setRoundFields(roundId, {
    speechPhase: 'timing',
    activeSpeechStartedAt: timestamp,
    updatedAt: timestamp,
  })
}

export async function endSpeechTimer(roundId: string) {
  const currentRoundSnapshot = await getDoc(roundRef(roundId))

  if (!currentRoundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const round = currentRoundSnapshot.data() as Round

  if (round.speechPhase !== 'timing') {
    throw new Error('The speech timer has not started yet.')
  }

  const timestamp = now()
  await setRoundFields(roundId, {
    speechPhase: 'idle',
    activeSpeechStartedAt: null,
    activeActionId: null,
    activeParticipantId: null,
    activeType: null,
    updatedAt: timestamp,
  })
}

export async function skipAction(roundId: string, actionId: string) {
  const currentRoundSnapshot = await getDoc(roundRef(roundId))
  const actionSnapshot = await getDoc(doc(actionsRef(roundId), actionId))

  if (!currentRoundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  if (!actionSnapshot.exists()) {
    throw new Error('Action not found.')
  }

  const round = currentRoundSnapshot.data() as Round
  const action = actionSnapshot.data() as Action

  if (action.status !== 'pending') {
    return
  }

  const timestamp = now()
  const nextAction: Action = {
    ...action,
    status: 'skipped',
  }
  const nextRound: Round = {
    ...round,
    updatedAt: timestamp,
  }
  const nextHistoryRef = doc(historyRef(roundId))
  const historyEntry: HistoryEntry = {
    id: nextHistoryRef.id,
    kind: 'skip',
    createdAt: timestamp,
    undone: false,
    actionId: action.id,
    participantId: null,
    before: {
      round,
      participant: null,
      action,
    },
  }
  const batch = writeBatch(assertDb())

  batch.set(doc(actionsRef(roundId), action.id), nextAction)
  batch.set(roundRef(roundId), nextRound)
  batch.set(nextHistoryRef, historyEntry)
  await batch.commit()
}

export async function undoLatestChange(roundId: string) {
  const currentRoundSnapshot = await getDoc(roundRef(roundId))

  if (!currentRoundSnapshot.exists()) {
    throw new Error('Round not found.')
  }

  const historySnapshots = await getDocs(query(historyRef(roundId), orderBy('createdAt', 'desc')))
  const latestHistorySnapshot = historySnapshots.docs.find((snapshot) => {
    const entry = snapshot.data() as HistoryEntry
    return !entry.undone
  })

  if (!latestHistorySnapshot) {
    return
  }

  const historyEntry = latestHistorySnapshot.data() as HistoryEntry
  const timestamp = now()
  const batch = writeBatch(assertDb())

  batch.set(roundRef(roundId), historyEntry.before.round)
  batch.set(doc(actionsRef(roundId), historyEntry.before.action.id), historyEntry.before.action)
  for (const action of historyEntry.before.relatedActions ?? []) {
    batch.set(doc(actionsRef(roundId), action.id), action)
  }

  if (historyEntry.before.participant) {
    batch.set(
      doc(participantsRef(roundId), historyEntry.before.participant.id),
      historyEntry.before.participant,
    )
  }

  batch.set(latestHistorySnapshot.ref, { undone: true, undoneAt: timestamp }, { merge: true })
  await batch.commit()
}

export async function skipFeaturedAction(roundId: string, participants: Participant[], actions: Action[]) {
  const nextSpeaker = rankPendingActions(actions, participants, 'speak')[0] ?? null
  const nextQuestion = rankPendingActions(actions, participants, 'question')[0] ?? null
  const featured = pickFeaturedAction(nextSpeaker, nextQuestion, participants)

  if (!featured) {
    return
  }

  await skipAction(roundId, featured.id)
}
