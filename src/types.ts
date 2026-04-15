export type ActionType = 'speak' | 'question'

export type ActionStatus = 'pending' | 'approved' | 'skipped'

export type RoundStatus = 'setup' | 'live'
export type SpeechPhase = 'idle' | 'awaiting_start' | 'timing'
export type VoteRequirement = 'majority' | 'two_thirds'
export type VoteChoice = 'aye' | 'nay' | 'abstain'
export type VoteStatus = 'open' | 'closed'

export interface Round {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  status: RoundStatus
  placardWindowEndsAt: number | null
  speechPhase: SpeechPhase
  activeSpeechStartedAt: number | null
  activeVoteId: string | null
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

export interface Vote {
  id: string
  requirement: VoteRequirement
  status: VoteStatus
  openedAt: number
  endsAt: number | null
  closedAt: number | null
  ayeCount: number
  nayCount: number
  abstainCount: number
  thresholdNeeded: number | null
  passed: boolean | null
}

export interface Ballot {
  id: string
  voteId: string
  participantId: string
  choice: VoteChoice
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
  votes: Vote[]
  ballots: Ballot[]
  loading: boolean
  error: string | null
  firebaseReady: boolean
}
