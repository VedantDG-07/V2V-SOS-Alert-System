const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "16kb" }));

// Keys loaded from environment variables — never hardcode secrets here.
// Copy .env.example → .env and fill in your values.
require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

const smsApiKey = process.env.SMS_API_KEY;

function isValidE164(number) {
  return typeof number === "string" && /^\+[1-9]\d{7,14}$/.test(number);
}

/* ================= SEND SMS ================= */

app.post("/send-sms", async (req, res) => {
  if (smsApiKey && req.headers["x-api-key"] !== smsApiKey) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (!accountSid || !authToken || !twilioNumber) {
    return res.status(500).json({ success: false, error: "SMS service misconfigured" });
  }
  const client = twilio(accountSid, authToken);

  const { message, to } = req.body;
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  if (!normalizedMessage || normalizedMessage.length > 500) {
    return res.status(400).json({ success: false, error: "Invalid message" });
  }

  if (!isValidE164(to)) {
    return res.status(400).json({ success: false, error: "Invalid destination number" });
  }

  try {
    await client.messages.create({
      body: normalizedMessage,
      from: twilioNumber,
      to: to
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.listen(5000, () => {
  console.log("SMS Server running on http://localhost:5000");
});
