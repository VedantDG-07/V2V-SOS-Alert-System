# 🚨 V2V-SOS: Vehicle-to-Vehicle Emergency Alert System

A real-time **Vehicle-to-Vehicle (V2V) Emergency Alert System** built as a **Progressive Web App (PWA)** using modern web technologies.
The system enables vehicles (users) to instantly broadcast SOS alerts to nearby devices using cloud-based communication.

---

## 🌐 Live Application

🔗 https://v2v-sos.web.app/

---

## 📌 Overview

Road accidents often lead to delayed emergency response and secondary collisions.
This project solves the problem by enabling **instant alert broadcasting** to nearby vehicles using:

* Real-time GPS tracking
* Cloud-based communication
* Browser-native technologies (no special hardware required)

---

## 🚀 Key Features

* 📍 Real-time GPS location tracking
* 🚨 One-click SOS alert broadcasting
* 📡 Instant alert delivery to nearby users
* 🗺️ Live map visualization (Leaflet + OpenStreetMap)
* 📱 Installable as a PWA (Add to Home Screen)
* 📊 Alert history tracking
* ⚡ Low latency (~180–390 ms)
* ✅ High reliability (~98–100% delivery success)

---

## 🏗️ System Architecture

The system is divided into four layers:

1. **Vehicle Device Layer**

   * Collects GPS data using Geolocation API

2. **Communication Layer**

   * Uses HTTPS + Firebase real-time listeners

3. **Cloud Database Layer**

   * Firebase Firestore stores vehicle data & SOS events

4. **Alert & Visualization Layer**

   * Displays alerts with map and distance calculation

---

## 📂 Project Structure

```
V2V-SOS/
├── public/
│   ├── index.html
│   ├── login.html
│   ├── register.html
│   ├── map.html
│   ├── history.html
│   ├── services.html
│   ├── settings.html
│   ├── app.js
│   ├── firebase-config.js
│   ├── style.css
│   ├── sw.js
│   └── functions/
│       ├── index.js
│       ├── server.js
│       └── package.json
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── package.json
```

---

## ⚙️ Technologies Used

* **Frontend:** HTML5, CSS3, JavaScript
* **Maps:** Leaflet.js + OpenStreetMap
* **Backend/Cloud:** Firebase Firestore
* **Authentication:** Firebase Anonymous Auth
* **Hosting:** Firebase Hosting
* **Real-time Communication:** Firestore listeners
* **PWA Support:** Service Worker

---

## 🛠️ Installation & Setup

### 1. Clone Repository

```
git clone https://github.com/VedantDG-07/V2V-SOS-Alert-System.git
cd V2V-SOS-Alert-System
```

### 2. Install Dependencies

```
npm install
cd public/functions
npm install
```

### 3. Configure Firebase

* Go to Firebase Console
* Create/Select project
* Copy config
* Replace in `firebase-config.js`

### 4. Run Locally

```
npx serve public
```

or use **VS Code Live Server**

---

## ☁️ Deployment

```
firebase deploy
```

---

## 📱 Install as App (PWA)

1. Open the web app in browser
2. Click **“Add to Home Screen”**
3. App installs like a native mobile application

👉 No APK required — the PWA itself is installable.

---

## 📊 Performance

* ⏱️ Alert latency: **180–390 ms**
* 📡 Delivery success: **98–100%**
* 👥 Tested with: **2–20 concurrent users**

---

## 📁 Data Handling

* No static dataset is used
* Data is generated in real-time:

  * GPS coordinates
  * SOS alerts
  * User session data

---

## 🔐 Security Considerations

* Firebase API keys are public by design
* Security enforced via:

  * Firestore rules
  * Firebase Authentication

---

## ⚠️ Limitations

* Requires internet connectivity
* GPS accuracy depends on device
* Browser permissions required

---

## 🔮 Future Scope

* Automatic accident detection (sensors / AI)
* Integration with traffic systems
* 5G-based ultra-low latency alerts
* Emergency service integration

---

## 👨‍💻 Authors

* Vedant Gawde
* Bhavesh Gambhirrao
* Mrunmayee Shinde

---

## 📜 License

This project is developed for academic purposes.

---

## ⭐ Conclusion

V2V-SOS demonstrates a **scalable, cost-effective, and hardware-free solution** for real-time emergency communication using cloud-native technologies and Progressive Web App capabilities.
