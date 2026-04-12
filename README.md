# PO Queue + P&R Live System

A laptop-first NSDA tournament tool for live speaker queues, automatic precedence and recency tracking, and real-time syncing across multiple devices with Firebase Firestore.

## Features

- Live participant request buttons for `speak` and `question`
- Real-time `onSnapshot` syncing for rounds, participants, actions, and undo history
- Auto-ranked precedence sheet using:
  - lower `speakCount` first
  - then older `lastActionTime`
  - then `speak` over `question` when a PO needs one next action to skip
- One-click PO controls for approve, skip, and undo
- Shareable round codes via URL hash for judges or secondary devices

## Firestore shape

Each round is stored as:

- `rounds/{roundId}`
- `rounds/{roundId}/participants/{participantId}`
- `rounds/{roundId}/actions/{actionId}`
- `rounds/{roundId}/history/{historyId}`

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and paste your Firebase web app config values.

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open the printed local URL, create a round, and share the `#ROUNDID` URL with any other device that should sync into the same live room.

## Recommended Firestore rules

This app assumes authenticated or trusted tournament usage. For a quick development setup, start with restrictive rules that only allow known users or a test project. If you want anonymous public access later, add proper auth and rate limiting before using it at a real tournament.
