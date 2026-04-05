# V2V-SOS 🚨

A real-time Vehicle-to-Vehicle emergency alert system that enables drivers to send and receive SOS signals, connect with nearby vehicles, and access emergency services. Built as a progressive web app (PWA) with Firebase backend.

## Features

- 🚨 **One-tap SOS alerts** — Send emergency signals to nearby vehicles instantly
- 📍 **Live location tracking** — Real-time map view of SOS alerts in your area
- 📱 **Progressive Web App** — Works offline with service worker support
- 🔐 **Secure authentication** — Email/password auth with Firestore security rules
- 💬 **Alert history** — View past emergencies and response logs
- 🌐 **Multi-user support** — Drivers can register and maintain driver profiles
- 📞 **SMS notifications** — Integrates with Twilio for SMS alerts (Cloud Functions)
- ⚙️ **User settings** — Customize alert preferences and notification channels

## Technologies

- **Frontend:** HTML5, CSS, Vanilla JavaScript
- **Hosting:** Firebase Hosting
- **Database:** Cloud Firestore
- **Backend:** Firebase Cloud Functions + Express.js
- **Authentication:** Firebase Auth
- **SMS Integration:** Twilio API
- **PWA:** Service Worker for offline functionality

## Project Structure

```
V2V-SOS/
├── public/                      # Firebase Hosting root (frontend)
│   ├── index.html              # Home / SOS trigger page
│   ├── login.html              # User login
│   ├── register.html           # User registration
│   ├── map.html                # Live map view of alerts
│   ├── history.html            # Alert history & logs
│   ├── services.html           # Available emergency services
│   ├── settings.html           # User preferences & settings
│   ├── app.js                  # Main frontend application logic
│   ├── firebase-config.js      # Firebase initialization
│   ├── style.css               # Global styles & theming
│   ├── sw.js                   # Service Worker (PWA support)
│   ├── env-config.js           # Environment configuration
│   └── functions/              # Firebase Cloud Functions
│       ├── index.js            # Functions entry point
│       ├── server.js           # Express.js server (Twilio SMS, etc.)
│       └── package.json        # Function dependencies
├── firebase.json               # Firebase Hosting configuration
├── firestore.rules             # Firestore security rules
├── firestore.indexes.json      # Firestore index definitions
├── package.json                # Root dependencies
└── README.md                   # This file
```

## Quick Start

### Prerequisites
- Node.js 14+ and npm
- Firebase CLI: `npm install -g firebase-tools`
- Firebase account with active project

### Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Install Cloud Functions dependencies:**
   ```bash
   cd public/functions
   npm install
   cd ../..
   ```

3. **Configure environment:** Copy `public/env-config.example.js` to `public/env-config.js` and update with your settings

4. **Login to Firebase:**
   ```bash
   firebase login
   ```

5. **Initialize your Firebase project:**
   ```bash
   firebase init
   ```

6. **Deploy to Firebase:**
   ```bash
   firebase deploy
   ```

Your app is now live at `https://<your-project>.web.app`

## Configuration

### Firebase Setup
1. Create a project at [Firebase Console](https://console.firebase.google.com)
2. Enable Firestore, Firebase Auth, Hosting, and Cloud Functions
3. Add your Firebase credentials to `public/firebase-config.js`

### SMS Integration (Optional)
To enable SMS notifications via Twilio:
1. Create a Twilio account and get API credentials
2. Add Twilio credentials to your Cloud Functions environment:
   ```bash
   firebase functions:config:set twilio.sid="<YOUR_ACCOUNT_SID>" twilio.auth_token="<YOUR_AUTH_TOKEN>"
   ```

## Security

> ⚠️ **Important:** `firebase-config.js` contains your Firebase API key. For web apps, public API keys are expected (Firebase security is enforced through Auth and Firestore rules, not API key hiding).

**Best practices implemented:**
- ✅ Firestore rules restrict unauthorized access
- ✅ Firebase Auth authentication required for features
- ✅ Cloud Functions validate all requests server-side
- ✅ User data isolation enforced at database level
- ✅ HTTPS enforced by Firebase Hosting

**Before production deployment:**
1. Review and test all `firestore.rules`
2. Configure Firebase Auth security settings
3. Enable reCAPTCHA for registration if needed
4. Set up CORS properly for Cloud Functions

## Development

### Local Testing
```bash
firebase emulators:start
```

### Code Structure
- `public/app.js` — Main app logic (UI controllers, event listeners)
- `public/functions/index.js` — Cloud Functions exports
- `public/functions/server.js` — Express.js middleware & routes

### Debugging
Enable debug logs in browser console:
- Check `console.log` statements in `app.js`
- Monitor Firestore activity in Firebase Console
- View Cloud Functions logs: `firebase functions:log`

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Commit changes: `git commit -m "Add your feature"`
3. Push to branch: `git push origin feature/your-feature`
4. Open a Pull Request

## Troubleshooting

### Firebase deploy fails
- Verify `firebase.json` configuration
- Check Firebase CLI version: `firebase --version`
- Ensure you have proper permissions for the Firebase project

### SOS alerts not appearing on map
- Check browser console for errors (`F12`)
- Verify Firestore security rules allow reads
- Confirm location permissions are granted

### SMS notifications not sending
- Validate Twilio credentials in Cloud Functions config
- Check Cloud Functions logs: `firebase functions:log`
- Verify phone numbers are in valid E.164 format

## License

This project is licensed under the MIT License. See LICENSE file for details.

## Support

For issues, questions, or feature requests:
- 📧 Open an issue on GitHub
- 💬 Check existing documentation
- 🔍 Review Firebase and Twilio documentation

---

**Last updated:** April 2026 | **Version:** 2.0
