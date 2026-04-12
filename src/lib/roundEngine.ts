import type { Action, ActionType, Participant } from '../types'

const recencyValue = (participant: Participant) => participant.lastActionTime ?? 0

export function sortParticipants(participants: Participant[]): Participant[] {
  return [...participants].sort((left, right) => {
    if (left.speakCount !== right.speakCount) {
      return left.speakCount - right.speakCount
    }

    if (recencyValue(left) !== recencyValue(right)) {
      return recencyValue(left) - recencyValue(right)
    }

    return left.name.localeCompare(right.name)
  })
}

export function buildParticipantIndex(participants: Participant[]): Map<string, Participant> {
  return new Map(participants.map((participant) => [participant.id, participant]))
}

export function buildRankIndex(participants: Participant[]): Map<string, number> {
  return new Map(sortParticipants(participants).map((participant, index) => [participant.id, index]))
}

export function rankPendingActions(
  actions: Action[],
  participants: Participant[],
  type: ActionType,
): Action[] {
  const rankIndex = buildRankIndex(participants)

  return actions
    .filter((action) => action.status === 'pending' && action.type === type)
    .sort((left, right) => {
      const leftRank = rankIndex.get(left.participantId) ?? Number.MAX_SAFE_INTEGER
      const rightRank = rankIndex.get(right.participantId) ?? Number.MAX_SAFE_INTEGER

      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }

      return left.timestamp - right.timestamp
    })
}

export function pickFeaturedAction(
  nextSpeaker: Action | null,
  nextQuestion: Action | null,
  participants: Participant[],
): Action | null {
  if (!nextSpeaker) {
    return nextQuestion
  }

  if (!nextQuestion) {
    return nextSpeaker
  }

  const rankIndex = buildRankIndex(participants)
  const speakerRank = rankIndex.get(nextSpeaker.participantId) ?? Number.MAX_SAFE_INTEGER
  const questionRank = rankIndex.get(nextQuestion.participantId) ?? Number.MAX_SAFE_INTEGER

  if (speakerRank === questionRank) {
    return nextSpeaker
  }

  return speakerRank < questionRank ? nextSpeaker : nextQuestion
}

export function getParticipantStatus(
  participantId: string,
  roundActiveParticipantId: string | null,
  actions: Action[],
): 'idle' | 'waiting' | 'active' {
  if (roundActiveParticipantId === participantId) {
    return 'active'
  }

  const hasPending = actions.some(
    (action) => action.participantId === participantId && action.status === 'pending',
  )

  return hasPending ? 'waiting' : 'idle'
}
