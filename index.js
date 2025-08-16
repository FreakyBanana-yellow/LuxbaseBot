import express from "express";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// Telegram-Webhook-Handler
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  console.log("📩 Telegram Update eingegangen:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
  console.log(`Webhook Endpoint: /bot${BOT_TOKEN}`);
});
