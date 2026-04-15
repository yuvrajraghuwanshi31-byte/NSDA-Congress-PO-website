export type ActionType = 'speak' | 'question'

export type ActionStatus = 'pending' | 'approved' | 'skipped'

export type RoundStatus = 'setup' | 'live'
export type SpeechPhase = 'idle' | 'awaiting_start' | 'timing'

export interface Round {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  status: RoundStatus
  placardWindowEndsAt: number | null
  speechPhase: SpeechPhase
  activeSpeechStartedAt: number | null
  activeActionId: string | null
  activeParticipantId: string | null
  activeType: ActionType | null
}

export interface Participant {
  id: string
  name: string
  initialPrecedence: number
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
    relatedActions?: Action[]
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
