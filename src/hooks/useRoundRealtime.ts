import { useEffect, useState } from 'react'
import { collection, doc, onSnapshot, orderBy, query } from 'firebase/firestore'
import { db, firebaseReady } from '../lib/firebase'
import type { Action, HistoryEntry, Participant, Round, RoundSnapshot } from '../types'

const emptySnapshot: RoundSnapshot = {
  round: null,
  participants: [],
  actions: [],
  history: [],
  loading: false,
  error: null,
  firebaseReady,
}

export function useRoundRealtime(roundId: string | null): RoundSnapshot {
  const [snapshot, setSnapshot] = useState<RoundSnapshot>({
    ...emptySnapshot,
    loading: Boolean(roundId && firebaseReady),
  })

  useEffect(() => {
    if (!firebaseReady || !db) {
      const resetTimer = window.setTimeout(() => {
        setSnapshot(emptySnapshot)
      }, 0)

      return () => window.clearTimeout(resetTimer)
    }

    if (!roundId) {
      const resetTimer = window.setTimeout(() => {
        setSnapshot({
          ...emptySnapshot,
          firebaseReady: true,
        })
      }, 0)

      return () => window.clearTimeout(resetTimer)
    }

    const loadingTimer = window.setTimeout(() => {
      setSnapshot((current) => ({
        ...current,
        loading: true,
        error: null,
        firebaseReady: true,
      }))
    }, 0)

    const unsubscribers = [
      onSnapshot(
        doc(db, 'rounds', roundId),
        (roundSnapshot) => {
          setSnapshot((current) => ({
            ...current,
            round: roundSnapshot.exists() ? ({ ...roundSnapshot.data(), id: roundId } as Round) : null,
            loading: false,
            error: null,
          }))
        },
        (error) => {
          setSnapshot((current) => ({ ...current, loading: false, error: error.message }))
        },
      ),
      onSnapshot(
        query(collection(db, 'rounds', roundId, 'participants')),
        (participantsSnapshot) => {
          setSnapshot((current) => ({
            ...current,
            participants: participantsSnapshot.docs.map((docSnapshot) => docSnapshot.data() as Participant),
            loading: false,
          }))
        },
        (error) => {
          setSnapshot((current) => ({ ...current, loading: false, error: error.message }))
        },
      ),
      onSnapshot(
        query(collection(db, 'rounds', roundId, 'actions')),
        (actionsSnapshot) => {
          setSnapshot((current) => ({
            ...current,
            actions: actionsSnapshot.docs.map((docSnapshot) => docSnapshot.data() as Action),
            loading: false,
          }))
        },
        (error) => {
          setSnapshot((current) => ({ ...current, loading: false, error: error.message }))
        },
      ),
      onSnapshot(
        query(collection(db, 'rounds', roundId, 'history'), orderBy('createdAt', 'desc')),
        (historySnapshot) => {
          setSnapshot((current) => ({
            ...current,
            history: historySnapshot.docs.map((docSnapshot) => docSnapshot.data() as HistoryEntry),
            loading: false,
          }))
        },
        (error) => {
          setSnapshot((current) => ({ ...current, loading: false, error: error.message }))
        },
      ),
    ]

    return () => {
      window.clearTimeout(loadingTimer)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [roundId])

  return snapshot
}
