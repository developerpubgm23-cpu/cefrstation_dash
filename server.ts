import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import admin from "firebase-admin";
import { readFileSync, existsSync } from "fs";
import cors from "cors";

dotenv.config();

// Telegram OAuth Configuration
const TG_CLIENT_ID = process.env.TELEGRAM_CLIENT_ID;
const TG_CLIENT_SECRET = process.env.TELEGRAM_CLIENT_SECRET;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL || process.env.VITE_APP_URL || "https://cefrstation.uz";

function getRedirectUri(req?: any) {
  // 1. Prioritize explicit redirect URI from env (most reliable for Telegram)
  if (process.env.TELEGRAM_REDIRECT_URI) {
    return process.env.TELEGRAM_REDIRECT_URI;
  }

  // 2. Use current host if request is available (handles production vs dev automatically)
  if (req && req.get('host')) {
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = req.get('host');
    // If we are on a run.app domain, ensure it's https
    const finalProtocol = host.includes('run.app') ? 'https' : protocol;
    return `${finalProtocol}://${host}/auth/telegram/callback`;
  }
  
  // 3. Fallback to configured APP_URL
  const base = APP_URL.endsWith('/') ? APP_URL.slice(0, -1) : APP_URL;
  return `${base}/auth/telegram/callback`;
}

// Attempt to load Firebase Config for Admin SDK
let firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
let serviceAccountEmail = process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL;

try {
  if (existsSync("./firebase-applet-config.json")) {
    const config = JSON.parse(readFileSync("./firebase-applet-config.json", "utf-8"));
    firebaseProjectId = firebaseProjectId || config.projectId;
  }
} catch (e) {
  console.warn("Could not read local firebase-applet-config.json");
}

if (firebaseProjectId) {
  try {
    if (!admin.apps.length) {
      // For Cloud Run and other GCP environments, providing the serviceAccountEmail 
      // helps the SDK find the correct IAM resource for signBlob.
      const initConfig: any = {
        projectId: firebaseProjectId,
      };

      if (serviceAccountEmail) {
        initConfig.serviceAccountEmail = serviceAccountEmail;
      }

      admin.initializeApp(initConfig);
      console.log(`Firebase Admin initialized for project: ${firebaseProjectId}${serviceAccountEmail ? ` with service account: ${serviceAccountEmail}` : ''}`);
    }
  } catch (e) {
    console.error("Firebase Admin initialization failed", e);
  }
}

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      "https://cefrstation.uz",
      "https://ais-dev-omqejq7vdneasgbqdlhios-506593598228.asia-southeast1.run.app",
      "https://ais-pre-omqejq7vdneasgbqdlhios-506593598228.asia-southeast1.run.app"
    ];

    // Allow any github.io, vercel.app domain, or localhost
    if (
      allowedOrigins.includes(origin) || 
      origin.endsWith(".github.io") || 
      origin.endsWith(".vercel.app") ||
      origin.includes("localhost")
    ) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  credentials: true
}));
app.use(express.json());
const PORT = 3000;

// Health check for Vercel
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", environment: process.env.VERCEL ? "vercel" : "other" });
});

// 1. Generate Auth URL
app.get("/api/auth/telegram/url", (req, res) => {
  const clientId = TG_CLIENT_ID || (TG_BOT_TOKEN ? TG_BOT_TOKEN.split(':')[0] : null);
  
  if (!clientId) {
    return res.status(500).json({ error: "TELEGRAM_CLIENT_ID yoki TELEGRAM_BOT_TOKEN sozlanmagan." });
  }

  const redirectUri = getRedirectUri(req);
  console.log(`Generating Telegram OAuth URL with redirect_uri: ${redirectUri}`);

  const params = new URLSearchParams({
    client_id: clientId,
    bot_id: clientId, // Some bridges use bot_id
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "profile", 
  });

  const providerUrl = "https://oauth.telegram.org/auth"; 
  res.json({ url: `${providerUrl}?${params.toString()}` });
});

// 2. Callback Handler (Supports both standard and requested paths)
const callbackHandler = async (req: any, res: any) => {
  const { code, hash, ...data } = req.query as any;
  console.log("Telegram callback received. Params present:", { hasCode: !!code, hasHash: !!hash });

  try {
    let userData: any = null;

    if (code) {
      // Logic for OAuth2 bridges
      const tokenResponse = await axios.post("https://oauth.telegram.org/token", {
        client_id: TG_CLIENT_ID,
        client_secret: TG_CLIENT_SECRET,
        code,
        redirect_uri: getRedirectUri(req),
        grant_type: "authorization_code",
      }).catch(e => {
        console.error("Token exchange failed:", e.response?.data || e.message);
        throw new Error("Token exchange failed");
      });

      const { access_token } = tokenResponse.data;
      const profileResponse = await axios.get("https://oauth.telegram.org/userinfo", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      userData = profileResponse.data;
    } 
    else if (hash && TG_BOT_TOKEN) {
      // Standard Telegram Login Widget logic
      const secretKey = crypto.createHash('sha256').update(TG_BOT_TOKEN).digest();
      const dataCheckString = Object.keys(data)
        .sort()
        .map(key => `${key}=${data[key]}`)
        .join('\n');
      
      const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
      
      if (hmac !== hash) {
        throw new Error("Ma'lumotlar butunligi tekshiruvi muvaffaqiyatsiz tugadi (Hash mismatch)");
      }
      userData = data;
    } else {
      throw new Error("Autentifikatsiya ma'lumotlari yetishmayapti (code yoki hash)");
    }

    let customToken: string | null = null;
    if (admin.apps.length > 0 && userData) {
      const uid = `telegram_${userData.id || userData.sub}`;
      try {
        customToken = await admin.auth().createCustomToken(uid, {
          telegramId: String(userData.id || userData.sub),
          username: userData.username,
        });
      } catch (tokenErr: any) {
        console.error("Failed to create custom token:", tokenErr);
        if (tokenErr.message && tokenErr.message.includes('signBlob')) {
          throw new Error(
            `Firebase Admin permission xatosi: IAM 'Service Account Token Creator' roli yetishmayapti. ` +
            `Iltimos, Google Cloud Console-da xizmat hisobiga ushbu rolni qo'shing yoki .env fayliga FIREBASE_SERVICE_ACCOUNT_EMAIL ni qo'shing.`
          );
        }
        throw tokenErr;
      }
    }

    res.send(`
      <html>
        <head><title>Muvaffaqiyatli kirildi</title></head>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f4f4f9;">
          <div style="text-align: center; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #333;">Muvaffaqiyatli kirildi!</h2>
            <p style="color: #666;">Ushbu oyna hozir yopiladi...</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                payload: ${JSON.stringify({ customToken, user: userData })} 
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
        </body>
      </html>
    `);

  } catch (err: any) {
    console.error("Telegram OAuth error:", err);
    res.status(500).send(`Xatolik yuz berdi: ${err.message}`);
  }
};

app.get("/api/auth/telegram/callback", callbackHandler);
app.get("/auth/telegram/callback", callbackHandler);

// Octobank Configuration
const OCTO_SHOP_ID = process.env.OCTO_SHOP_ID;
const OCTO_API_KEY = process.env.OCTO_API_KEY;
const OCTO_API_URL = "https://secure.octo.uz";

// 3. Payment Creation (Octobank)
app.post("/api/payment/create", async (req, res) => {
  const { amount, orderId, description } = req.body;

  if (!OCTO_SHOP_ID || !OCTO_API_KEY) {
    return res.status(500).json({ error: "OCTO_SHOP_ID yoki OCTO_API_KEY sozlanmagan." });
  }

  try {
    const shopTransactionId = orderId || `order_${Date.now()}`;
    const initTime = new Date().toISOString().slice(0, 19).replace('T', ' ');

    const requestBody = {
      octo_shop_id: OCTO_SHOP_ID,
      octo_secret: OCTO_API_KEY,
      shop_transaction_id: shopTransactionId,
      auto_capture: true,
      test: true,
      init_time: initTime,
      total_sum: amount || 5000000,
      currency: 'UZS',
      description: description || "CEFRStation Pro obunasi",
      return_url: `${APP_URL}/payment/success`,
      notify_url: `${APP_URL}/api/payment/notify`,
      language: 'uz',
      ttl: 15
    };

    const response = await axios.post(`${OCTO_API_URL}/prepare_payment`, requestBody, {
      headers: {
        "Content-Type": "application/json",
      },
    });

    const result = response.data;

    if (result.error !== 0) {
      return res.status(400).json({ error: result.errMessage || "Payment creation failed" });
    }

    // Return compatible format
    res.json({
      id: result.data.octo_payment_UUID,
      payment_url: result.data.octo_pay_url,
      shop_transaction_id: shopTransactionId
    });
  } catch (err: any) {
    console.error("Octobank payment creation error:", err.response?.data || err.message);
    res.status(500).json({ 
      error: "To'lov linkini yaratishda xatolik yuz berdi.",
      details: err.response?.data
    });
  }
});

// Export app for Vercel serverless functions
export default app;

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Only start listening if not running as a Vercel serverless function
  if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

startServer();
