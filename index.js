// index.js
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const bot = new TelegramBot(process.env.BOT_TOKEN);
const webhookUrl = `${process.env.BASE_URL}/bot${process.env.BOT_TOKEN}`;

bot.setWebHook(webhookUrl);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

app.use(express.json());
app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Startbefehl
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const startParam = match[1] ? match[1].replace("=", "").trim() : null;

  // Creator-ID aus Start-Param extrahieren
  let creatorId = null;
  if (startParam && startParam.startsWith("creator_")) {
    creatorId = startParam.replace("creator_", "");
  }

  if (!creatorId) {
    bot.sendMessage(chatId, "❌ Kein gültiger Start-Link benutzt.");
    return;
  }

  // In vip_users eintragen
  await supabase.from("vip_users").upsert({
    telegram_id: msg.from.id.toString(),
    username: msg.from.username,
    creator_id: creatorId,
    status: "gestartet"
  }, { onConflict: ["telegram_id"] });

  bot.sendMessage(chatId, "👋 Willkommen! Bitte bestätige dein Alter:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Über 18", callback_data: "age_ok" }],
        [{ text: "❌ Unter 18", callback_data: "age_no" }]
      ]
    }
  });
});

// Callback-Handler
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();

  if (query.data === "age_ok") {
    await supabase.from("vip_users").update({ alter_ok: true }).eq("telegram_id", userId);
    bot.sendMessage(chatId, "📜 Lies bitte unsere Regeln:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Regeln gelesen ✅", callback_data: "rules_ok" }]
        ]
      }
    });
  }

  if (query.data === "rules_ok") {
    const { data } = await supabase
      .from("vip_users")
      .select("creator_id")
      .eq("telegram_id", userId)
      .single();

    if (!data) {
      bot.sendMessage(chatId, "❌ Fehler: Creator nicht gefunden.");
      return;
    }

    const { data: creator } = await supabase
      .from("creator_config")
      .select("gruppe_link")
      .eq("creator_id", data.creator_id)
      .single();

    if (creator?.gruppe_link) {
      bot.sendMessage(chatId, `✅ Willkommen im VIP!\nHier ist dein Gruppenlink: ${creator.gruppe_link}`);
    } else {
      bot.sendMessage(chatId, "⚠️ Kein Gruppenlink hinterlegt.");
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Luxbot läuft auf ${PORT}, Webhook: ${webhookUrl}`);
});
