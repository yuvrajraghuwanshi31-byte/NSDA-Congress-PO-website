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

export async function createRound(name: string, participantNames: string[]) {
  const roundId = createRoundId()
  const timestamp = now()
  const round: Round = {
    id: roundId,
    name: name.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
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
  const alreadyExists = participantSnapshots.docs.some((snapshot) => {
    const participant = snapshot.data() as Participant
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
    speakCount: 0,
    lastActionTime: null,
  }
  const batch = writeBatch(assertDb())

  batch.set(participantDoc, participant)
  batch.set(roundRef(roundId), { updatedAt: timestamp }, { merge: true })
  await batch.commit()
}

export async function requestAction(roundId: string, participantId: string, type: ActionType) {
  const roundSnapshot = await getDoc(roundRef(roundId))

  if (!roundSnapshot.exists()) {
    throw new Error('Round not found.')
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
  const nextRound: Round = {
    ...round,
    updatedAt: timestamp,
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
    },
  }
  const batch = writeBatch(assertDb())

  batch.set(doc(actionsRef(roundId), selectedAction.id), nextAction)
  batch.set(doc(participantsRef(roundId), participant.id), nextParticipant)
  batch.set(roundRef(roundId), nextRound)
  batch.set(nextHistoryRef, historyEntry)
  await batch.commit()
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
