/******************************************************************
 Firebase Configuration – COMPLETE MODULE EXPORT
******************************************************************/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  serverTimestamp,
  orderBy 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* ================= YOUR FIREBASE CONFIG ================= */
// Keys are loaded from window.__env, injected by env-config.js at deploy time.
// Never hardcode secrets here. See .env.example and env-config.js for setup.

const env = window.__env || {};
const firebaseConfig = {
  apiKey:            env.FIREBASE_API_KEY,
  authDomain:        env.FIREBASE_AUTH_DOMAIN,
  projectId:         env.FIREBASE_PROJECT_ID,
  storageBucket:     env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             env.FIREBASE_APP_ID,
  measurementId:     env.FIREBASE_MEASUREMENT_ID
};

/* ================= INIT ================= */

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* ================= EXPORT EVERYTHING ================= */

export {
  db,
  auth,
  collection,
  doc,
  setDoc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  onSnapshot,
  query,
  serverTimestamp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInAnonymously,
  signOut,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential
};


