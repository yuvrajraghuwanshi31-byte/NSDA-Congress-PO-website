export type ActionType = 'speak' | 'question'

export type ActionStatus = 'pending' | 'approved' | 'skipped'

export interface Round {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  activeActionId: string | null
  activeParticipantId: string | null
  activeType: ActionType | null
}

export interface Participant {
  id: string
  name: string
  speakCount: number
  lastActionTime: number | null
}

export interface Action {
  id: string
  participantId: string
  type: ActionType
  status: ActionStatus
  timestamp: number
}

export interface HistoryEntry {
  id: string
  kind: 'approve' | 'skip'
  createdAt: number
  undone: boolean
  undoneAt?: number
  actionId: string
  participantId: string | null
  before: {
    round: Round
    participant: Participant | null
    action: Action
  }
}

export interface RoundSnapshot {
  round: Round | null
  participants: Participant[]
  actions: Action[]
  history: HistoryEntry[]
  loading: boolean
  error: string | null
  firebaseReady: boolean
}
