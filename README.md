# V2V-SOS 🚨

Vehicle-to-Vehicle SOS emergency alert web app built with Firebase Hosting + Firestore + Cloud Functions.

## Project Structure

```
V2V-SOS/
├── public/               # Firebase Hosting root (frontend)
│   ├── index.html        # Home / SOS trigger page
│   ├── login.html        # Login page
│   ├── register.html     # Registration page
│   ├── map.html          # Live map view
│   ├── history.html      # Alert history
│   ├── services.html     # Services page
│   ├── settings.html     # User settings
│   ├── app.js            # Main frontend logic
│   ├── firebase-config.js# Firebase init & exports
│   ├── style.css         # Global styles
│   ├── sw.js             # Service Worker (PWA)
│   └── functions/        # Firebase Cloud Functions
│       ├── index.js      # Functions entry point
│       ├── server.js     # Express server (Twilio SMS etc.)
│       └── package.json  # Functions dependencies
├── firebase.json         # Firebase Hosting config
├── firestore.rules       # Firestore security rules
├── firestore.indexes.json# Firestore indexes
├── package.json          # Root package (server deps)
└── _trash/               # Review & delete — not committed
```

## Setup

```bash
# Install root dependencies
npm install

# Install functions dependencies
cd public/functions && npm install

# Deploy to Firebase
firebase deploy
```

## ⚠️ Security Note
`firebase-config.js` contains your Firebase API key. For a web app this is normal  
(Firebase keys are public by design), but make sure your **Firestore rules** and  
**Firebase Auth** are properly configured to restrict access.
