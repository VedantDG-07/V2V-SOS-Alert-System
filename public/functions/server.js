require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const accountSid   = process.env.TWILIO_ACCOUNT_SID;
const authToken    = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioNumber) {
  console.error("❌ Missing Twilio env vars — check your .env file");
  process.exit(1);
}

const client = twilio(accountSid, authToken);

/* ── Health check ── */
app.get("/health", (req, res) => res.json({ ok: true }));

/* ── Send SMS ── */
app.post("/send-sms", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: "Missing to or message" });
  }

  // Normalize Indian numbers — add +91 if not already international
  let phone = to.replace(/\s+/g, "");
  if (!phone.startsWith("+")) {
    phone = "+91" + phone.replace(/^0+/, "");
  }

  try {
    const msg = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });
    console.log(`✅ SMS sent to ${phone} — SID: ${msg.sid}`);
    res.json({ success: true, sid: msg.sid });
  } catch(err) {
    console.error(`❌ SMS failed to ${phone}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`📡 SMS Server running on http://localhost:${PORT}`));
