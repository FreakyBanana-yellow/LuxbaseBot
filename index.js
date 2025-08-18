// index.js – Luxbot @ Render (Telegram + Stripe Connect + Supabase)
import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import cron from "node-cron";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL  = (process.env.BASE_URL || "").replace(/\/+$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_ACCOUNT_COUNTRY = process.env.STRIPE_ACCOUNT_COUNTRY || ""; // z.B. "DE"

if (!BOT_TOKEN || !BASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ENV fehlt. Setze: BOT_TOKEN, BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const nowTS = () => new Date().toISOString().replace("T"," ").replace("Z","");
const todayISO = () => new Date().toISOString().slice(0,10);
const addDaysISO = (d) => new Date(Date.now()+d*864e5).toISOString().slice(0,10);

async function getCreatorCfgById(creator_id) {
  if (!creator_id) return null;
  const { data, error } = await supabase
    .from("creator_config")
    .select("creator_id, preis, vip_days, gruppe_link, group_chat_id, stripe_price_id, stripe_account_id, application_fee_pct, welcome_text, regeln_text")
    .eq("creator_id", creator_id)
    .maybeSingle();
  if (error) {
    console.error("DB getCreatorCfgById error:", error.message);
    return null;
  }
  return data || null;
}

async function sendDynamicInvite(group_chat_id, chat_id_or_user_id) {
  if (!group_chat_id) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: group_chat_id,
        expire_date: Math.floor(Date.now()/1000) + 3600,
        member_limit: 1
      })
    }).then(r => r.json());

    if (resp?.ok && resp?.result?.invite_link) {
      await bot.sendMessage(Number(chat_id_or_user_id), `🎟️ Dein VIP‑Zugang: ${resp.result.invite_link}`);
      return true;
    }
  } catch (e) { console.error("InviteLink error:", e.message); }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware (Stripe-Webhook braucht RAW)
// ──────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/stripe/webhook")) {
    return bodyParser.raw({ type: "application/json" })(req, res, next);
  }
  return bodyParser.json()(req, res, next);
});

// ──────────────────────────────────────────────────────────────────────────────
// Telegram – Webhook
// ──────────────────────────────────────────────────────────────────────────────
const telegramPath = `/bot${BOT_TOKEN}`;
const telegramWebhook = `${BASE_URL}${telegramPath}`;
const bot = new TelegramBot(BOT_TOKEN);

async function bootstrapTelegram() {
  await bot.setWebHook(telegramWebhook);
  console.log("✅ Telegram Webhook:", telegramWebhook);
// Wenn der Bot einer Gruppe hinzugefügt wird → Admins prüfen → Gruppe automatisch verknüpfen
bot.on("my_chat_member", async (upd) => {
  const chat = upd.chat;
  const me = upd.new_chat_member;
  if (!chat || !me) return;

  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const activeNow = me.status === "administrator" || me.status === "member";
  if (!isGroup || !activeNow) return;

  try {
    // 1) Admins der Gruppe holen
    const adminsResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatAdministrators`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat.id })
    }).then(r => r.json());

    const adminIds = (adminsResp?.result || [])
      .map(a => String(a?.user?.id))
      .filter(Boolean);

    if (!adminIds.length) {
      await bot.sendMessage(chat.id,
        "👋 Ich bin jetzt hier. Konnte keine Admins erkennen. Bitte stelle sicher, dass ich Admin bin.");
      return;
    }

    // 2) Creator suchen, dessen admin-telegram-id unter den Admins ist
    //    ↳ wir nutzen bei dir das Feld `creator_config.telegram_id`
    const { data: matches, error } = await supabase
      .from("creator_config")
      .select("creator_id, telegram_id")
      .in("telegram_id", adminIds);

    if (error) {
      console.error("match admin error:", error.message);
      await bot.sendMessage(chat.id, "⚠️ Konnte die Gruppe nicht automatisch verknüpfen (DB‑Fehler).");
      return;
    }

    if (!matches || matches.length === 0) {
      // Kein registrierter Admin gefunden → Hinweis, wie koppeln
      await bot.sendMessage(
        chat.id,
        "👋 Ich bin jetzt hier. Um automatisch zu verknüpfen, öffne in meinem DM den Link „Telegram verbinden“ aus den VIP‑Einstellungen (Luxbase) " +
        "und füge mich danach hier erneut als Admin hinzu."
      );
      return;
    }

    if (matches.length > 1) {
      // Mehrere Creator matchen (mehrere Admins sind Creator) → keine Verknüpfung, Hinweis
      await bot.sendMessage(
        chat.id,
        "⚠️ Mehrere Creator‑Admins erkannt. Bitte lass nur den gewünschten Creator‑Admin aktiv oder verknüpfe zunächst nur einen Creator."
      );
      return;
    }

    // 3) Eindeutigen Creator gefunden → Gruppe binden
    const creator_id = matches[0].creator_id;
    await supabase.from("creator_config")
      .update({ group_chat_id: String(chat.id) })
      .eq("creator_id", creator_id);

    await bot.sendMessage(
      chat.id,
      "✅ Gruppe wurde automatisch mit deinem VIP‑Bot verknüpft.\n" +
      "Bitte stelle sicher, dass ich Admin‑Rechte habe (Einladen & Kicken)."
    );
  } catch (e) {
    console.error("my_chat_member auto-bind error:", e?.message || e);
  }
});
  app.post(telegramPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  // /start (DM & Gruppe)
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const payload = (match?.[1] || "").trim();
    const m = /^creator_(.+)$/i.exec(payload);
    const creator_id = m ? m[1] : null;

    // In Gruppe → Chat-ID binden
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      if (!creator_id) {
        await bot.sendMessage(msg.chat.id, "❓ Kein Creator‑Payload. Nutze den „Gruppe verbinden“-Button in den Einstellungen.");
        return;
      }
      await supabase.from("creator_config").update({ group_chat_id: String(msg.chat.id) }).eq("creator_id", creator_id);
      await bot.sendMessage(msg.chat.id, "✅ Gruppe verbunden! Bitte Admin‑Rechte geben.");
      return;
    }
// Sonderfall: DM-Verknüpfung "link_creator_<id>" (Creator paart sein Telegram)
const linkMatch = /^link_creator_(.+)$/i.exec((match?.[1] || "").trim());
if (linkMatch && (msg.chat.type === "private")) {
  const cId = linkMatch[1];

  // Telegram-ID & Username als Besitzer dieses Creators speichern
  await supabase.from("creator_config")
    .update({
      telegram_id: String(msg.from.id),              // nutzt DEIN vorhandenes Feld
      admin_telegram_username: msg.from.username || null
    })
    .eq("creator_id", cId);

  await bot.sendMessage(
    msg.chat.id,
    "✅ Dein Telegram wurde mit deinem Luxbase‑Account verknüpft.\n" +
    "Als Nächstes: Füge mich als Admin in deine VIP‑Gruppe hinzu – ich verknüpfe sie automatisch."
  );
  return;
}
    // DM
    if (!creator_id) {
      await bot.sendMessage(msg.chat.id, "❌ Ungültiger Start‑Link. Bitte den Link aus deinen VIP‑Einstellungen verwenden.");
      return;
    }

    const creator = await getCreatorCfgById(creator_id);
    if (!creator) {
      await bot.sendMessage(msg.chat.id, "❌ Creator‑Konfiguration nicht gefunden.");
      return;
    }

    await supabase.from("vip_users").upsert({
      creator_id,
      telegram_id: String(msg.from.id),
      chat_id: String(msg.chat.id),
      username: msg.from.username || null,
      status: "gestartet",
      letzter_kontakt: nowTS()
    }, { onConflict: "creator_id,telegram_id" });

    await bot.sendMessage(
      msg.chat.id,
      `👋 Willkommen, ${msg.from.first_name}!\n\nPreis: ${Number(creator.preis || 0).toFixed(0)} €\nDauer: ${creator.vip_days || 30} Tage`,
      { reply_markup: { inline_keyboard: [[{ text: "Jetzt bezahlen", callback_data: "pay_now" }]] } }
    );
  });

  // Inline‑Button „Jetzt bezahlen“ → Stripe Checkout (Direct Charge)
  bot.on("callback_query", async (q) => {
    if (q.data !== "pay_now") return;
    const chatId = q.message.chat.id;
    const userId = String(q.from.id);

    const { data: row } = await supabase.from("vip_users")
      .select("creator_id").eq("telegram_id", userId)
      .order("letzter_kontakt", { ascending: false }).limit(1).maybeSingle();

    if (!row?.creator_id) { await bot.answerCallbackQuery(q.id, { text: "Bitte zuerst /start nutzen." }); return; }

    const creator = await getCreatorCfgById(row.creator_id);
    if (!creator) { await bot.answerCallbackQuery(q.id, { text: "Konfiguration fehlt." }); return; }
    if (!stripe) { await bot.answerCallbackQuery(q.id, { text: "Stripe nicht konfiguriert." }); return; }
    if (!creator.stripe_account_id) {
      await bot.answerCallbackQuery(q.id, { text: "Stripe nicht verbunden. Bitte in den VIP‑Einstellungen verbinden." });
      return;
    }

    try {
      const amount = Math.max(0, Math.round(Number(creator.preis || 0) * 100));
      const feePct = Number(creator.application_fee_pct || 0);
      const application_fee_amount = feePct ? Math.round((amount * feePct) / 100) : undefined;

      const lineItem = {
        price_data: {
          currency: "eur",
          product_data: { name: `VIP ${row.creator_id.slice(0,8)}` },
          unit_amount: amount
        },
        quantity: 1
      };

      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [lineItem],
          success_url: `${BASE_URL}/stripe/success`,
          cancel_url: `${BASE_URL}/stripe/cancel`,
          payment_intent_data: application_fee_amount ? { application_fee_amount } : undefined,
          metadata: { creator_id: row.creator_id, telegram_id: userId, chat_id: String(chatId) }
        },
        { stripeAccount: creator.stripe_account_id } // ← Direct Charge
      );

      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, "💳 Bezahlung starten:", {
        reply_markup: { inline_keyboard: [[{ text: "Jetzt bezahlen", url: session.url }]] }
      });
    } catch (e) {
      console.error("Stripe session error:", e.message);
      await bot.answerCallbackQuery(q.id, { text: "Stripe Fehler. Später erneut versuchen." });
    }
  });

  // /status
  bot.onText(/\/status/, async (msg) => {
    const userId = String(msg.from.id);
    const { data: row } = await supabase.from("vip_users")
      .select("status, vip_bis").eq("telegram_id", userId)
      .order("letzter_kontakt", { ascending: false }).limit(1).maybeSingle();

    await bot.sendMessage(
      msg.chat.id,
      row ? `Status: <b>${row.status||"—"}</b>\nVIP bis: <b>${row.vip_bis||"—"}</b>` : "Noch kein VIP. Nutze /start.",
      { parse_mode: "HTML" }
    );
  });

  // jede Message → Kontaktzeit
  bot.on("message", async (msg) => {
    if (!msg?.from) return;
    await supabase.from("vip_users").update({ letzter_kontakt: nowTS() }).eq("telegram_id", String(msg.from.id));
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Stripe Connect – Onboarding
// ──────────────────────────────────────────────────────────────────────────────

// JSON: erstellt/holt Express‑Konto (mit Capabilities), speichert acct_…, liefert Onboarding‑URL
app.get("/api/stripe/connect-link", async (req, res) => {
  try {
    const creator_id = req.query.creator_id;
    if (!creator_id) return res.status(400).json({ error: "creator_id fehlt" });
    if (!stripe) return res.status(500).json({ error: "Stripe nicht konfiguriert" });

    const { data: cfg, error: dbErr } = await supabase
      .from("creator_config")
      .select("stripe_account_id")
      .eq("creator_id", creator_id)
      .maybeSingle();
    if (dbErr) return res.status(500).json({ error: "DB: " + dbErr.message });
    if (!cfg) return res.status(404).json({ error: "creator_config Zeile fehlt" });

    let accountId = cfg.stripe_account_id;
    if (!accountId) {
      const params = {
        type: "express",
        ...(STRIPE_ACCOUNT_COUNTRY ? { country: STRIPE_ACCOUNT_COUNTRY } : {}),
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        metadata: { creator_id }
      };
      const account = await stripe.accounts.create(params);
      accountId = account.id;

      const { error: upErr } = await supabase
        .from("creator_config")
        .update({ stripe_account_id: accountId })
        .eq("creator_id", creator_id);
      if (upErr) return res.status(500).json({ error: "DB update: " + upErr.message });
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${BASE_URL}/stripe/connect/refresh?creator_id=${encodeURIComponent(creator_id)}`,
      return_url:  `${BASE_URL}/stripe/connect/return?creator_id=${encodeURIComponent(creator_id)}`
    });

    return res.json({ url: link.url, account: accountId });
  } catch (e) {
    console.error("connect-link failed:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Redirect‑Variante
app.get("/api/stripe/connect-redirect", async (req, res) => {
  try {
    const creator_id = req.query.creator_id;
    if (!creator_id) return res.status(400).send("creator_id fehlt");
    const r = await fetch(`${BASE_URL}/api/stripe/connect-link?creator_id=${encodeURIComponent(creator_id)}`);
    const j = await r.json();
    if (!j.url) return res.status(500).send("connect-redirect failed: " + (j.error || "kein url Feld"));
    return res.redirect(303, j.url);
  } catch (e) {
    console.error("connect-redirect failed:", e);
    return res.status(500).send("connect-redirect failed: " + (e?.message || String(e)));
  }
});

// minimale Landing‑Seiten
app.get("/stripe/connect/refresh", (req, res) => {
  res.send("🔄 Onboarding abgebrochen – bitte in Luxbase erneut auf „Stripe verbinden“ klicken.");
});
app.get("/stripe/connect/return", (req, res) => {
  res.send("✅ Onboarding abgeschlossen (oder fortgesetzt). Du kannst dieses Fenster schließen.");
});

// ──────────────────────────────────────────────────────────────────────────────
// Stripe – Webhook (⚠️ in Stripe „Events on Connected accounts“ anhaken!)
// ──────────────────────────────────────────────────────────────────────────────
app.post("/stripe/webhook", async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe sig error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const creator_id = s.metadata?.creator_id;
    const telegram_id = s.metadata?.telegram_id;
    const chat_id = s.metadata?.chat_id;

    try {
      const cfg = await getCreatorCfgById(creator_id);
      const vip_bis = addDaysISO(Number(cfg?.vip_days || 30));

      const { data: vipRow } = await supabase.from("vip_users").upsert(
        { creator_id, telegram_id, chat_id, status: "aktiv", vip_bis },
        { onConflict: "creator_id,telegram_id" }
      ).select("telegram_id, chat_id").maybeSingle();

      if (cfg?.welcome_text) await bot.sendMessage(Number(chat_id), cfg.welcome_text);
      if (cfg?.regeln_text)  await bot.sendMessage(Number(chat_id), cfg.regeln_text);

      const ok = await sendDynamicInvite(cfg?.group_chat_id, vipRow?.chat_id || chat_id);
      if (!ok && cfg?.gruppe_link) {
        await bot.sendMessage(Number(chat_id), `🎟️ Dein VIP‑Zugang: ${cfg.gruppe_link}`);
      }
    } catch (e) { console.error("Fulfill error:", e.message); }
  }

  res.json({ received: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Daily Cron – Reminder & Kick
// ──────────────────────────────────────────────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  const today = todayISO();
  const warnDate = addDaysISO(5);

  // Warnen (5 Tage vorher)
  const { data: warnUsers } = await supabase.from("vip_users")
    .select("telegram_id, chat_id, vip_bis")
    .gte("vip_bis", today).lte("vip_bis", warnDate).eq("status", "aktiv");
  for (const u of warnUsers || []) {
    await bot.sendMessage(Number(u.chat_id || u.telegram_id),
      `⏰ Dein VIP läuft am ${u.vip_bis} ab. Verlängere rechtzeitig mit /start → „Jetzt bezahlen“.`);
  }

  // Abgelaufen → kicken
  const { data: expired } = await supabase.from("vip_users")
    .select("creator_id, telegram_id, chat_id, vip_bis")
    .lt("vip_bis", today).eq("status", "aktiv");

  if (expired?.length) {
    const { data: cfgs } = await supabase.from("creator_config").select("creator_id, group_chat_id");
    const map = new Map((cfgs||[]).map(c => [c.creator_id, c.group_chat_id]));
    for (const u of expired) {
      const group = map.get(u.creator_id);
      if (!group) continue;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id: group, user_id: Number(u.telegram_id) })
      });
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id: group, user_id: Number(u.telegram_id), only_if_banned: true })
      });
      await supabase.from("vip_users").update({ status: "abgelaufen" })
        .eq("creator_id", u.creator_id).eq("telegram_id", u.telegram_id);
      await bot.sendMessage(Number(u.chat_id || u.telegram_id),
        `❌ Dein VIP ist abgelaufen. Du wurdest aus der Gruppe entfernt. Mit /start → „Jetzt bezahlen“ kannst du jederzeit verlängern.`);
    }
  }
  console.log("⏲️ daily cron done");
});

// ──────────────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("Luxbot up"));
app.get("/stripe/success", (_, res) => res.send("✅ Zahlung erfolgreich. Der Bot sendet dir gleich den Zugang in Telegram."));
app.get("/stripe/cancel",  (_, res) => res.send("❌ Zahlung abgebrochen."));

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 on :${PORT}  webhook: ${telegramWebhook}`);
  await bootstrapTelegram();
});
