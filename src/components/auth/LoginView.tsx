import React, { useState, useEffect } from 'react';
import { 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  signInWithCustomToken,
  sendPasswordResetEmail,
  type User as FirebaseUser
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider } from '../../lib/firebase';
import { handleFirestoreError, OperationType } from '../../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { LogIn, Mail, ChevronLeft, SendHorizontal, LogOut, CheckCircle2, Chrome } from 'lucide-react';
import axios from 'axios';

interface AppUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  phoneNumber: string | null;
  authMethod: 'google' | 'email' | 'telegram';
}

export default function LoginView() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [view, setView] = useState<'initial' | 'email' | 'forgot-password' | 'phone'>('initial');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Email form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // Telegram state removed in favor of OAuth popup

  // Use the API URL from env or fallback to current origin if on same domain
  const API_BASE_URL = (import.meta as any).env?.VITE_API_URL || '';
  
  useEffect(() => {
    console.log("Current API Base URL:", API_BASE_URL || "Same origin (relative)");
  }, [API_BASE_URL]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Validate origin is from AI Studio preview, current location or production domain
      const origin = event.origin;
      if (
        !origin.endsWith('.run.app') && 
        !origin.includes('localhost') && 
        !origin.includes('cefrstation.uz') &&
        !origin.endsWith('.github.io') &&
        !origin.endsWith('.vercel.app')
      ) {
        return;
      }

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const { customToken, user: tgUser } = event.data.payload;
        try {
          if (customToken) {
            await signInWithCustomToken(auth, customToken);
          } else {
            // Fallback for non-firebase environments
            setUser({
              uid: `telegram_${tgUser.id || tgUser.sub}`,
              displayName: `${tgUser.first_name || tgUser.firstName} ${tgUser.last_name || tgUser.lastName || ''}`,
              email: tgUser.email || null,
              photoURL: tgUser.photo_url || null,
              phoneNumber: tgUser.phone_number || null,
              authMethod: 'telegram'
            });
          }
          setSuccess("Telegram orqali muvaffaqiyatli kirildi!");
        } catch (err: any) {
          handleAuthError(err);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const appUser: AppUser = {
          uid: firebaseUser.uid,
          displayName: firebaseUser.displayName,
          email: firebaseUser.email,
          photoURL: firebaseUser.photoURL,
          phoneNumber: firebaseUser.phoneNumber,
          authMethod: firebaseUser.providerData[0]?.providerId === 'google.com' ? 'google' : 'email'
        };
        setUser(appUser);
        await syncUserToFirestore(firebaseUser);
      } else {
        setUser(null);
      }
    });

    return () => {
      unsubscribe();
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleTelegramLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/auth/telegram/url`);
      const { url } = response.data;

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const authWindow = window.open(
        url,
        'telegram_oauth',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      if (!authWindow) {
        setError("Popup oynasi bloklandi. Iltimos, ruxsat bering.");
      }
    } catch (err: any) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  };

  const syncUserToFirestore = async (user: FirebaseUser) => {
    const userRef = doc(db, 'users', user.uid);
    try {
      const userSnap = await getDoc(userRef);
      if (!userSnap.exists()) {
        await setDoc(userRef, {
          uid: user.uid,
          email: user.email || null,
          displayName: user.displayName || null,
          photoURL: user.photoURL || null,
          phoneNumber: user.phoneNumber || null,
          createdAt: serverTimestamp(),
          lastLogin: serverTimestamp(),
        });
      } else {
        await setDoc(userRef, {
          lastLogin: serverTimestamp(),
        }, { merge: true });
      }
    } catch (err: any) {
      if (err.code === 'permission-denied') {
        console.warn('Firestore permissions issues.');
      } else {
        handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
      }
    }
  };

  const handleAuthError = (err: any) => {
    console.error("Auth Error:", err);
    if (err.code === 'auth/popup-closed-by-user') {
      setError("Kirish oynasi yopildi.");
    } else if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
      setError("Email yoki parol noto'g'ri.");
    } else if (err.code === 'auth/email-already-in-use') {
      setError("Ushbu email allaqachon ro'yxatdan o'tgan.");
    } else if (err.code === 'auth/invalid-email') {
      setError("Email manzili noto'g'ri.");
    } else if (err.code === 'auth/too-many-requests') {
      setError("Juda ko'p urinish. Bir ozdan keyin qayta urinib ko'ring.");
    } else {
      setError(err.response?.data?.error || err.message || "Xatolik yuz berdi");
    }
  };

  useEffect(() => {
    // If user is logged in, automatically redirect to main domain after a short delay
    // to allow session to persist and give feedback to user
    if (user && !loading && !error) {
      const redirectUrl = 'https://cefrstation.uz';
      const timer = setTimeout(() => {
        try {
          // Try to redirect the current window
          window.location.replace(redirectUrl);
          
          // Fallback for some browsers or embedded scenarios
          setTimeout(() => {
             window.location.href = redirectUrl;
          }, 500);
        } catch (e) {
          console.error("Redirect error:", e);
          window.location.href = redirectUrl;
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [user, loading, error]);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
        setSuccess("Ro'yxatdan o'tish muvaffaqiyatli yakunlandi!");
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await sendPasswordResetEmail(auth, email);
      setSuccess("Parolni tiklash havolasi emailingizga yuborildi!");
    } catch (err: any) {
      handleAuthError(err);
    } finally {
      setLoading(false);
    }
  };


  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    setView('initial');
    setSuccess(null);
    setError(null);
  };

  if (user) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#f0f4f8] p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 w-full max-w-md overflow-hidden rounded-[3rem] bg-white p-12 shadow-[0_20px_50px_rgba(0,0,0,0.05)]"
        >
          <div className="text-center">
            <div className="mx-auto mb-8 flex h-24 w-24 items-center justify-center rounded-[2rem] bg-gradient-to-br from-[#3b5cf6] to-[#2563eb] p-1 shadow-xl shadow-blue-100">
              <div className="flex h-full w-full items-center justify-center rounded-[1.85rem] bg-white overflow-hidden">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="Profile" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-blue-50 text-[32px] font-bold text-[#3b5cf6]">
                    {user.displayName?.[0] || user.email?.[0] || '?'}
                  </div>
                )}
              </div>
            </div>
            <h2 className="text-[28px] font-extrabold tracking-tight text-[#1a1c1e]">{user.displayName || 'Foydalanuvchi'}</h2>
            <p className="mt-2 text-sm font-medium text-[#94a3b8]">
              {user.email || user.phoneNumber}
            </p>
            <div className="mt-6 flex flex-col items-center gap-2">
              <div className="h-1 w-24 overflow-hidden rounded-full bg-blue-100">
                <motion.div 
                  initial={{ x: '-100%' }}
                  animate={{ x: '100%' }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  className="h-full w-full bg-[#3b5cf6]"
                />
              </div>
              <p className="text-xs font-bold text-[#3b5cf6] animate-pulse">
                Saytga yo'naltirilmoqdasiz...
              </p>
            </div>
          </div>
          
          <div className="mt-10 space-y-4">
            <Button 
              className="h-14 w-full rounded-2xl bg-[#3b5cf6] text-[15px] font-bold tracking-wide text-white shadow-lg shadow-blue-100 hover:bg-[#2563eb]"
              onClick={() => window.location.href = 'https://cefrstation.uz'}
            >
              Asosiy saytga o'tish
            </Button>

            <div className="rounded-[2rem] bg-gradient-to-br from-amber-50 to-orange-50 p-6 border border-amber-100">
              <h3 className="text-lg font-bold text-amber-900 mb-1 flex items-center gap-2">
                <CheckCircle2 size={18} className="text-amber-600" />
                CEFRStation Pro
              </h3>
              <p className="text-sm text-amber-700/80 mb-5 leading-relaxed">
                Barcha premium darslar va yopiq guruhlarga cheksiz kirish imkoniyatini oling.
              </p>
              <Button 
                onClick={async () => {
                  setLoading(true);
                  setError(null);
                  try {
                    const response = await axios.post(`${API_BASE_URL}/api/payment/create`, {
                      amount: 5900000, // 59,000 UZS
                      description: `Premium obuna: ${user.email || user.uid}`,
                      orderId: `PRO_${user.uid}_${Date.now()}`
                    });
                    
                    if (response.data?.payment_url) {
                      window.location.href = response.data.payment_url;
                    } else if (response.data?.url) {
                      window.location.href = response.data.url;
                    } else {
                      throw new Error("To'lov linki olinmadi");
                    }
                  } catch (err: any) {
                    setError("To'lovni boshlashda xatolik yuz berdi. CHECKOUT_API_KEY o'rnatilganligini tekshiring.");
                    handleAuthError(err);
                  } finally {
                    setLoading(false);
                  }
                }}
                className="h-12 w-full rounded-2xl bg-amber-600 text-[14px] font-black tracking-wide text-white shadow-lg shadow-amber-200 hover:bg-amber-700"
                isLoading={loading}
              >
                Premiumga o'tish — 59 000 so'm
              </Button>
            </div>

            <Button 
              variant="outline" 
              className="h-12 w-full rounded-2xl border-[#e2e8f0] bg-white text-[14px] font-bold text-red-500 transition-all hover:bg-red-50 hover:text-red-600"
              onClick={handleLogout}
            >
              <LogOut size={16} className="mr-2" />
              Chiqish
            </Button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#f0f4f8] p-6 font-sans">
      {/* Soft Background Ornaments */}
      <div className="absolute top-0 left-0 -translate-x-1/4 -translate-y-1/4 transform opacity-40">
        <div className="h-[600px] w-[600px] rounded-full bg-blue-100 blur-[80px]"></div>
      </div>
      <div className="absolute bottom-0 right-0 translate-x-1/4 translate-y-1/4 transform opacity-40">
        <div className="h-[600px] w-[600px] rounded-full bg-indigo-100 blur-[80px]"></div>
      </div>

      <motion.div 
        layout
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
        className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-[3rem] bg-white p-12 shadow-[0_20px_50px_rgba(0,0,0,0.05)]"
      >
        <div className="space-y-10">
          <AnimatePresence mode="wait">
            {view === 'initial' && (
              <motion.div
                key="initial"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="flex flex-col items-center"
              >
                {/* Logo Section */}
                <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#3b5cf6] text-white shadow-[0_8px_16px_rgba(59,92,246,0.3)]">
                  <span className="text-2xl font-bold tracking-tight">CS</span>
                </div>

                <div className="mb-10 text-center">
                  <h1 className="text-[32px] font-extrabold tracking-tight text-[#1a1c1e]">CEFRStation</h1>
                  <p className="mt-2 text-[13px] font-bold uppercase tracking-[0.2em] text-[#3b5cf6]">Premium Learning Hub</p>
                </div>

                <div className="w-full space-y-4">
                  <Button 
                    variant="outline" 
                    className="flex h-14 w-full items-center justify-center gap-3 rounded-full border-[#e2e8f0] bg-white text-[15px] font-semibold text-[#1a1c1e] transition-all hover:bg-zinc-50 hover:shadow-sm"
                    onClick={handleGoogleLogin}
                    isLoading={loading}
                    id="google-login-btn"
                  >
                    <Chrome size={20} className="text-[#ea4335]" />
                    <span>Google orqali kirish</span>
                  </Button>

                  <Button 
                    variant="outline" 
                    className="flex h-14 w-full items-center justify-center gap-3 rounded-full border-[#e2e8f0] bg-white text-[15px] font-semibold text-[#1a1c1e] transition-all hover:bg-zinc-50 hover:shadow-sm"
                    onClick={() => setView('email')}
                    id="email-login-btn"
                  >
                    <Mail size={20} className="text-[#3b5cf6]" />
                    <span>Email orqali kirish</span>
                  </Button>

                  <div className="flex items-center justify-center py-4">
                    <div className="h-[1px] w-full bg-[#f1f5f9]"></div>
                    <span className="px-4 text-[10px] font-bold uppercase tracking-[0.25em] text-[#94a3b8]">Yoki</span>
                    <div className="h-[1px] w-full bg-[#f1f5f9]"></div>
                  </div>

                  <Button 
                    variant="outline" 
                    className="flex h-14 w-full items-center justify-center gap-3 rounded-full border-[#e2e8f0] bg-white text-[15px] font-semibold text-[#1a1c1e] transition-all hover:bg-zinc-50 hover:shadow-sm"
                    onClick={handleTelegramLogin}
                    isLoading={loading}
                    id="telegram-login-btn"
                  >
                    <SendHorizontal size={20} className="text-[#24a1de]" />
                    <span>Telegram orqali kirish</span>
                  </Button>
                </div>
              </motion.div>
            )}

            {view === 'email' && (
              <motion.div
                key="email"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <div className="flex items-center gap-4">
                  <button onClick={() => setView('initial')} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f8fafc] text-zinc-500 transition-all hover:bg-[#3b5cf6] hover:text-white">
                    <ChevronLeft size={20} />
                  </button>
                  <h2 className="text-2xl font-bold tracking-tight text-[#1a1c1e]">{isRegistering ? "Hisob yaratish" : "Xush kelibsiz"}</h2>
                </div>

                <form onSubmit={handleEmailAuth} className="space-y-5">
                  <div className="space-y-4">
                    <Input 
                      type="email" 
                      label="Elektron pochta" 
                      placeholder="nomiz@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="h-14 rounded-2xl border-[#e2e8f0]"
                    />
                    <div className="space-y-2">
                      <Input 
                        type="password" 
                        label="Maxfiy kod" 
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className="h-14 rounded-2xl border-[#e2e8f0]"
                      />
                      {!isRegistering && (
                        <div className="flex justify-end">
                          <button 
                            type="button"
                            onClick={() => setView('forgot-password')}
                            className="text-xs font-bold text-[#3b5cf6] hover:underline"
                          >
                            Parolni unutdingizmi?
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <Button 
                    type="submit" 
                    className="h-14 w-full rounded-2xl bg-[#3b5cf6] text-[15px] font-bold tracking-wide text-white shadow-lg shadow-blue-100 hover:bg-[#2563eb]"
                    isLoading={loading}
                    id="email-auth-submit"
                  >
                    {isRegistering ? "Ro'yxatdan o'tish" : "Tizimga kirish"}
                  </Button>

                  <div className="text-center pt-2">
                    <p className="text-sm text-zinc-500">
                      {isRegistering ? "Profilingiz bormi?" : "Hali ro'yxatdan o'tmaganmisiz?"}{' '}
                      <button 
                        type="button"
                        className="font-bold text-[#3b5cf6] hover:underline"
                        onClick={() => setIsRegistering(!isRegistering)}
                      >
                        {isRegistering ? "Kirish" : "Yaratish"}
                      </button>
                    </p>
                  </div>
                </form>
              </motion.div>
            )}

            {view === 'forgot-password' && (
              <motion.div
                key="forgot"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-8"
              >
                <div className="flex items-center gap-4">
                  <button onClick={() => setView('email')} className="flex h-10 w-10 items-center justify-center rounded-full bg-[#f8fafc] text-zinc-500 hover:bg-[#3b5cf6] hover:text-white">
                    <ChevronLeft size={20} />
                  </button>
                  <h2 className="text-2xl font-bold tracking-tight text-[#1a1c1e]">Parolni tiklash</h2>
                </div>

                <form onSubmit={handleForgotPassword} className="space-y-6">
                  <Input 
                    type="email" 
                    label="Elektron pochta" 
                    placeholder="nomiz@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="h-14 rounded-2xl border-[#e2e8f0]"
                  />
                  <Button 
                    type="submit" 
                    className="h-14 w-full rounded-2xl bg-[#1a1c1e] text-[15px] font-bold tracking-wide text-white hover:bg-black"
                    isLoading={loading}
                    id="forgot-password-submit"
                  >
                    Havolani yuborish
                  </Button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Status Messages */}
        <AnimatePresence>
          {error && (
            <motion.div 
              key="auth-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-red-50 px-8 py-3 text-sm font-bold text-red-600 flex items-center justify-center gap-2 border-t border-red-100"
            >
              {error}
            </motion.div>
          )}
          {success && (
            <motion.div 
              key="auth-success"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-green-50 px-8 py-3 text-sm font-bold text-green-600 flex items-center justify-center border-t border-green-100"
            >
              {success}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <p className="mt-8 text-sm font-medium text-[#94a3b8]">
        © {new Date().getFullYear()} CEFRStation Platform
      </p>
    </div>
  );
}
