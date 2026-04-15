import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

const requiredKeys = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.storageBucket,
  firebaseConfig.messagingSenderId,
  firebaseConfig.appId,
]
const firebaseReady = requiredKeys.every((value) => typeof value === 'string' && value.length > 0)

const app = firebaseReady ? initializeApp(firebaseConfig) : null

export const db = app ? getFirestore(app) : null

if (app && typeof window !== 'undefined') {
  void isSupported().then((supported) => {
    if (supported && firebaseConfig.measurementId) {
      getAnalytics(app)
    }
  })
}

export { firebaseReady }
