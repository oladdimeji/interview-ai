import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Firebase configuration from firebase-applet-config.json
const firebaseConfig = {
  apiKey: "AIzaSyCHdm5ul1qMsp9qHbUeJeRdkXjjqU6skjo",
  authDomain: "gen-lang-client-0637900846.firebaseapp.com",
  projectId: "gen-lang-client-0637900846",
  storageBucket: "gen-lang-client-0637900846.firebasestorage.app",
  messagingSenderId: "241211697878",
  appId: "1:241211697878:web:647b009170a9257d5a3777"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Use custom Firestore Database ID if present
const databaseId = "ai-studio-interviewai-8c2a3b00-8d1c-4052-9862-9c10f4636ec7";
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
}, databaseId || undefined);

export const storage = getStorage(app);
