# Financial Planner — setup guide

This is your budgeting app as a standalone web app. It uses:
- **Firebase** (free Spark plan) — stores your data (Firestore) and locks the app behind a login (Authentication), so only you can see your numbers.
- **Vercel** (free) — hosts the app at a real URL you can open from your phone or PC.

Total cost: **₹0**. No credit card required for either service on the free tiers used here.

Follow these steps in order. It takes about 20–30 minutes the first time.

---

## Part 1 — Create your Firebase project

1. Go to https://console.firebase.google.com and sign in with any Google account.
2. Click **Add project**, give it a name (e.g. "my-financial-planner"), and finish the wizard. You can disable Google Analytics for this project — you don't need it.
3. Once the project opens, click the **web icon (`</>`)** on the project overview page to register a new web app. Give it any nickname. You do **not** need Firebase Hosting for this — skip that checkbox.
4. Firebase will show you a `firebaseConfig` object with values like `apiKey`, `authDomain`, `projectId`, etc. **Keep this tab open** — you'll need these values in Part 3.

### Enable Firestore (the database)
1. In the left sidebar, click **Build → Firestore Database**.
2. Click **Create database**. Choose **Start in production mode**. Pick any location close to you.
3. Once created, go to the **Rules** tab and replace the contents with what's in `firestore.rules` in this project (it restricts access to signed-in users only). Click **Publish**.

### Enable Authentication (your login)
1. In the left sidebar, click **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Go to the **Users** tab and click **Add user**. Enter the email and password *you* want to log in with. This is the only account that will exist — there's no public sign-up page, so nobody else can create an account even if they find your app's URL.

That's it for Firebase.

---

## Part 2 — Get the code onto GitHub

1. If you don't have one, create a free account at https://github.com.
2. Create a new empty repository (e.g. "financial-planner"). Don't initialize it with a README — you already have one.
3. On your computer, unzip this project folder, then run:
   ```
   cd financial-planner
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/financial-planner.git
   git push -u origin main
   ```
   (If you don't have `git` installed, GitHub Desktop is a simpler drag-and-drop alternative — https://desktop.github.com.)

---

## Part 3 — Deploy on Vercel

1. Go to https://vercel.com and sign up using your GitHub account (free).
2. Click **Add New → Project**, and import the GitHub repo you just pushed.
3. Vercel will auto-detect it's a Vite project. Before clicking Deploy, open **Environment Variables** and add each of these (values come from the `firebaseConfig` object from Part 1, step 4):

   | Name | Value |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | your `apiKey` |
   | `VITE_FIREBASE_AUTH_DOMAIN` | your `authDomain` |
   | `VITE_FIREBASE_PROJECT_ID` | your `projectId` |
   | `VITE_FIREBASE_STORAGE_BUCKET` | your `storageBucket` |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | your `messagingSenderId` |
   | `VITE_FIREBASE_APP_ID` | your `appId` |

4. Click **Deploy**. In about a minute, Vercel gives you a live URL like `financial-planner-yourname.vercel.app`.
5. Open that URL on your phone or PC, log in with the email/password you created in Part 1, and you're in.

### Keeping it updated later
Any time you (or I) change the code, just `git push` again — Vercel automatically redeploys within a minute or two. No manual re-upload needed.

### Using it day to day
- Bookmark the URL, or on your phone use "Add to Home Screen" from your browser's share menu — it'll behave like a regular app icon.
- Your data lives in Firestore under your Google account, not tied to this chat or Claude in any way.
- Because you're the only registered user, nobody else can log in or see your data, even if they discover the URL.

---

## Local development (optional)

If you want to run it on your own computer before deploying:
```
npm install
cp .env.example .env   # then fill in your Firebase values
npm run dev
```
This starts a local dev server (usually at `http://localhost:5173`).
