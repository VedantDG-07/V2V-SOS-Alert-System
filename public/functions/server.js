const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Keys loaded from environment variables — never hardcode secrets here.
// Copy .env.example → .env and fill in your values.
require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

/* ================= SEND SMS ================= */

app.post("/send-sms", async (req, res) => {
  const { message, to } = req.body;

  try {
    await client.messages.create({
      body: message,
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
