// ─────────────────────────────────────────────
// crustly-auth.js — Central auth for all pages
// Import this on every protected page
// ─────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  where,
  getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Firebase config ──
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBee_VnVrM0Q_oqK8UX5n8rf2m-xkppRS0",
  authDomain:        "crustly-adbd3.firebaseapp.com",
  projectId:         "crustly-adbd3",
  storageBucket:     "crustly-adbd3.firebasestorage.app",
  messagingSenderId: "858995665332",
  appId:             "1:858995665332:web:8ebfb5a54ea02c3094aae1"
};

// ── Init (avoid duplicate app) ──
const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app, 'crustly');

// ─────────────────────────────────────────────
// requireAuth(callback)
// Call on every protected page.
// Redirects to crustly-login.html if not logged in.
// callback(user, restaurantData) when logged in.
// ─────────────────────────────────────────────
export function requireAuth(callback) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'crustly-login.html';
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (!snap.exists()) {
        await signOut(auth);
        window.location.href = 'crustly-login.html';
        return;
      }
      const userData = snap.data();
      // Fetch restaurant data
      const restSnap = await getDoc(doc(db, 'restaurants', userData.restaurantId));
      const restaurantData = restSnap.exists() ? { id: userData.restaurantId, ...restSnap.data() } : null;
      callback(user, userData, restaurantData);
    } catch (e) {
      console.error('Auth error:', e);
      callback(user, null, null);
    }
  });
}

// ─────────────────────────────────────────────
// requireAdmin(callback)
// Only for Crustly super-admin (your own account)
// ─────────────────────────────────────────────
export function requireAdmin(callback) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = 'crustly-login.html';
      return;
    }
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists() || snap.data().role !== 'admin') {
      window.location.href = 'crustly-login.html';
      return;
    }
    callback(user, snap.data());
  });
}

// ─────────────────────────────────────────────
// login(email, password) → { success, error }
// ─────────────────────────────────────────────
export async function login(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return { success: true, user: cred.user };
  } catch (e) {
    return { success: false, error: friendlyError(e.code) };
  }
}

// ─────────────────────────────────────────────
// logout() → redirects to login page
// ─────────────────────────────────────────────
export async function logout() {
  await signOut(auth);
  window.location.href = 'crustly-login.html';
}

// ─────────────────────────────────────────────
// resetPassword(email) → { success, error }
// ─────────────────────────────────────────────
export async function resetPassword(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    return { success: true };
  } catch (e) {
    return { success: false, error: friendlyError(e.code) };
  }
}

// ─────────────────────────────────────────────
// createRestaurantUser(email, password, restaurantId, restaurantName)
// Called during onboarding to create owner account
// ─────────────────────────────────────────────
export async function createRestaurantUser(email, password, restaurantId, restaurantName) {
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    // Save user profile in Firestore
    await setDoc(doc(db, 'users', cred.user.uid), {
      email,
      restaurantId,
      restaurantName,
      role: 'owner',
      createdAt: new Date().toISOString()
    });
    return { success: true, user: cred.user };
  } catch (e) {
    return { success: false, error: friendlyError(e.code) };
  }
}

// ─────────────────────────────────────────────
// getCurrentRestaurantId()
// Returns restaurantId for current user or null
// ─────────────────────────────────────────────
export async function getCurrentRestaurantId() {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, 'users', user.uid));
  return snap.exists() ? snap.data().restaurantId : null;
}

// ─────────────────────────────────────────────
// Friendly Swedish error messages
// ─────────────────────────────────────────────
function friendlyError(code) {
  const errors = {
    'auth/invalid-email':            'Ogiltig e-postadress.',
    'auth/user-not-found':           'Ingen användare med denna e-post.',
    'auth/wrong-password':           'Fel lösenord.',
    'auth/invalid-credential':       'Fel e-post eller lösenord.',
    'auth/too-many-requests':        'För många försök. Vänta en stund.',
    'auth/email-already-in-use':     'E-postadressen används redan.',
    'auth/weak-password':            'Lösenordet måste vara minst 6 tecken.',
    'auth/network-request-failed':   'Nätverksfel. Kontrollera din anslutning.',
  };
  return errors[code] || 'Ett fel uppstod. Försök igen.';
}

export { auth, db };
