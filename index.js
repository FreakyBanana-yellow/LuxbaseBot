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
const STRIPE_ACCOUNT_COUNTRY = process.env.STRIPE_ACCOUNT_COUNTRY || ""; // optional, z.B. "DE"

if (!BOT_TOKEN || !BASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ENV fehlt. Setze: BOT_TOKEN, BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ──────────────────────────────────────────────────────────────────────────────
// Hinweise für DB (optional, nicht zwingend):
//
// create table if not exists invite_links (
//   id uuid primary key default gen_random_uuid(),
//   creator_id text not null,
//   telegram_id text not null,
//   chat_id text,
//   group_chat_id text not null,
//   invite_link text not null,
//   expires_at timestamptz not null,
//   member_limit int not null default 1,
//   used boolean not null default false,
//   created_at timestamptz not null default now()
// );
// create index if not exists invite_links_creator_idx on invite_links (creator_id);
// create index if not exists invite_links_telegram_idx on invite_links (telegram_id);
// ──────────────────────────────────────────────────────────────────────────────

const nowTS = () => new Date().toISOString().replace("T"," ").replace("Z","");
const todayISO = () => new Date().toISOString().slice(0,10);
const addDaysISO = (d) => new Date(Date.now()+d*864e5).toISOString().slice(0,10);
const log = (...args) => console.log("ℹ️", ...args);

// Zustimmungs-Tracker (In-Memory) für Alterscheck & Regeln vor Zahlung
// key = `${creator_id}:${telegram_id}` → { age: boolean, rules: boolean }
const consentState = new Map();

async function getCreatorCfgById(creator_id) {
  if (!creator_id) return null;
  const { data, error } = await supabase
    .from("creator_config")
    .select("creator_id, preis, vip_days, vip_dauer, gruppe_link, group_chat_id, stripe_price_id, stripe_account_id, application_fee_pct, welcome_text, regeln_text")
    .eq("creator_id", creator_id)
    .maybeSingle();
  if (error) {
    console.error("DB getCreatorCfgById error:", error.message);
    return null;
  }
  return data || null;
}

// Einmallink pro Model (1 Mitglied, 15 Min gültig) + DB-Logging mit klaren Logs
async function sendDynamicInvitePerModel({ creator_id, group_chat_id, chat_id_or_user_id }) {
  if (!group_chat_id) {
    console.error("sendDynamicInvite: group_chat_id fehlt");
    return { ok: false, reason: "NO_GROUP" };
  }
  try {
    // Einmallink erzeugen
    const expire = Math.floor(Date.now() / 1000) + (15 * 60);
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: group_chat_id,
        expire_date: expire,
        member_limit: 1,
        creates_join_request: false
      }),
    }).then(r => r.json());

    if (!(resp?.ok && resp?.result?.invite_link)) {
      console.error("❌ createChatInviteLink failed:", resp);
      return { ok: false, reason: "TG_API" };
    }

    const invite_link = resp.result.invite_link;
    const expires_at = new Date(expire * 1000).toISOString();

    // →→ Verstärktes Logging beim Insert:
    const { data: ins, error: insErr } = await supabase
      .from("invite_links")
      .insert({
        creator_id,
        telegram_id: String(chat_id_or_user_id),
        chat_id: String(chat_id_or_user_id),
        group_chat_id: String(group_chat_id),
        invite_link,
        expires_at,
        member_limit: 1,
        used: false
      })
      .select("id, created_at")
      .maybeSingle();

    if (insErr) {
      console.error("❌ invite_links insert error:", insErr);
    } else {
      console.log("✅ invite_links inserted:", ins);
    }

    await bot.sendMessage(Number(chat_id_or_user_id), `🎟️ Dein VIP‑Zugang (15 Min gültig): ${invite_link}`);
    return { ok: true, invite_link, expires_at };
  } catch (e) {
    console.error("sendDynamicInvite error:", e.message);
    return { ok: false, reason: "EXCEPTION" };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware (Stripe‑Webhook braucht RAW)
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
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// Express-Handler + Logging der Updates
app.post(telegramPath, (req, res) => {
  console.log("📩 Incoming Telegram Update:", JSON.stringify(req.body, null, 2));
  try { bot.processUpdate(req.body); } catch (err) { console.error("processUpdate error:", err); }
  res.sendStatus(200);
});

async function bootstrapTelegram() {
  try {
    // alten Webhook entfernen, dann neu setzen
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "" })
    });
    const setResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: telegramWebhook })
    }).then(r => r.json());
    console.log("Telegram setWebHook response:", setResp);

    const info = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`).then(r => r.json());
    console.log("Telegram getWebhookInfo:", JSON.stringify(info, null, 2));
  } catch (err) {
    console.error("❌ bootstrapTelegram error:", err.message);
  }

  // Auto‑Bind beim Hinzufügen in Gruppe (optional hilfreich)
  bot.on("my_chat_member", async (upd) => {
    const chat = upd.chat;
    const me = upd.new_chat_member;
    if (!chat || !me) return;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    const activeNow = me.status === "administrator" || me.status === "member";
    if (!isGroup || !activeNow) return;

    try {
      const adminsResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatAdministrators`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat.id })
      }).then(r => r.json());

      const adminIds = (adminsResp?.result || []).map(a => String(a?.user?.id)).filter(Boolean);
      if (!adminIds.length) {
        await bot.sendMessage(chat.id, "👋 Ich bin jetzt hier. Bitte stelle sicher, dass ich Admin bin.");
        return;
      }

      const { data: matches, error } = await supabase
        .from("creator_config")
        .select("creator_id, telegram_id")
        .in("telegram_id", adminIds);

      if (error) { console.error("match admin error:", error.message); return; }
      if (!matches || matches.length !== 1) { return; }

      await supabase.from("creator_config")
        .update({ group_chat_id: String(chat.id) })
        .eq("creator_id", matches[0].creator_id);

      await bot.sendMessage(chat.id, "✅ Gruppe wurde automatisch verknüpft. Bitte gib mir Admin‑Rechte für Einladungen & Kicks.");
    } catch (e) {
      console.error("my_chat_member auto-bind error:", e?.message || e);
    }
  });

  // /start (DM & Gruppe) – mit Alterscheck & Regeln vor Zahlung
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const payload = (match?.[1] || "").trim();
    const m = /^creator_(.+)$/i.exec(payload);
    const creator_id = m ? m[1] : null;

    // In Gruppe: binden, wenn Payload vorhanden
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      if (!creator_id) {
        await bot.sendMessage(msg.chat.id, "❓ Kein Creator‑Payload. Nutze den „Gruppe verbinden“-Button in den Einstellungen.");
        return;
      }
      await supabase.from("creator_config").update({ group_chat_id: String(msg.chat.id) }).eq("creator_id", creator_id);
      await bot.sendMessage(msg.chat.id, "✅ Gruppe verbunden! Bitte Admin‑Rechte geben.");
      return;
    }

    // DM: Flow starten
    if (!creator_id) {
      await bot.sendMessage(msg.chat.id, "❌ Ungültiger Start‑Link. Bitte den Link aus deinen VIP‑Einstellungen verwenden.");
      return;
    }

    const creator = await getCreatorCfgById(creator_id);
    if (!creator) {
      await bot.sendMessage(msg.chat.id, "❌ Creator‑Konfiguration nicht gefunden.");
      return;
    }

    // User registrieren/aktualisieren (Status: gestartet)
    await supabase.from("vip_users").upsert({
      creator_id,
      telegram_id: String(msg.from.id),
      chat_id: String(msg.chat.id),
      username: msg.from.username || null,
      status: "gestartet",
      letzter_kontakt: nowTS()
    }, { onConflict: "creator_id,telegram_id" });

    // Consent-State initialisieren
    const key = `${creator_id}:${msg.from.id}`;
    consentState.set(key, { age: false, rules: false });

    const price = Number(creator.preis || 0).toFixed(0);
    const days  = Number(creator.vip_days ?? creator.vip_dauer ?? 30);

    // 1) Begrüßung + Buttons für Alterscheck & Regeln
    const text = [
      `👋 Willkommen, ${msg.from.first_name}!`,
      `Preis: ${price} €`,
      `Dauer: ${days} Tage`,
      "",
      "Bevor es losgeht, bitte bestätige:",
      "1) 🔞 Du bist mind. 18 Jahre alt",
      "2) 📜 Du hast die Regeln gelesen & akzeptierst sie"
    ].join("\n");

    const kb = {
      inline_keyboard: [
        [{ text: "🔞 Ich bin 18+", callback_data: `consent_age:${creator_id}` }],
        [{ text: "📜 Regeln anzeigen", callback_data: `show_rules:${creator_id}` }],
        [{ text: "✅ Regeln akzeptieren", callback_data: `consent_rules:${creator_id}` }],
        // Der „Jetzt bezahlen“-Button erscheint erst, wenn beide bestätigt wurden
      ]
    };

    await bot.sendMessage(msg.chat.id, text, { reply_markup: kb });
  });

  // Callback-Handler: Alterscheck / Regeln / Pay
  bot.on("callback_query", async (q) => {
    const chatId = q.message?.chat?.id;
    const userId = String(q.from.id);
    const data = q.data || "";

    // helper: safe getter
    const getState = (creator_id) => {
      const key = `${creator_id}:${userId}`;
      if (!consentState.has(key)) consentState.set(key, { age: false, rules: false });
      return { key, state: consentState.get(key) };
    };

    // Alterscheck bestätigen
    if (data.startsWith("consent_age:")) {
      const creator_id = data.split(":")[1];
      const { key, state } = getState(creator_id);
      state.age = true;
      consentState.set(key, state);
      await bot.answerCallbackQuery(q.id, { text: "Altersbestätigung gespeichert." });
      await maybeOfferPay(creator_id, chatId, userId);
      return;
    }

    // Regeln anzeigen
    if (data.startsWith("show_rules:")) {
      const creator_id = data.split(":")[1];
      const creator = await getCreatorCfgById(creator_id);
      const rules = creator?.regeln_text || "Standard‑Regeln: Kein Spam, kein Teilen von privaten Inhalten, respektvoll bleiben.";
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, `📜 Regeln:\n\n${rules}`);
      return;
    }

    // Regeln akzeptieren
    if (data.startsWith("consent_rules:")) {
      const creator_id = data.split(":")[1];
      const { key, state } = getState(creator_id);
      state.rules = true;
      consentState.set(key, state);
      await bot.answerCallbackQuery(q.id, { text: "Regeln akzeptiert." });
      await maybeOfferPay(creator_id, chatId, userId);
      return;
    }

    // Payment starten (nur wenn explizit angezeigt/geklickt)
    if (data === "pay_now") {
      const { data: row } = await supabase.from("vip_users")
        .select("creator_id").eq("telegram_id", userId)
        .order("letzter_kontakt", { ascending: false }).limit(1).maybeSingle();

      if (!row?.creator_id) { await bot.answerCallbackQuery(q.id, { text: "Bitte zuerst /start nutzen." }); return; }

      const creator = await getCreatorCfgById(row.creator_id);
      if (!creator) { await bot.answerCallbackQuery(q.id, { text: "Konfiguration fehlt." }); return; }
      if (!stripe) { await bot.answerCallbackQuery(q.id, { text: "Stripe nicht konfiguriert." }); return; }
      const acct = creator.stripe_account_id;
      if (!acct) {
        await bot.answerCallbackQuery(q.id, { text: "Stripe nicht verbunden. Bitte in den VIP‑Einstellungen verbinden." });
        return;
      }

      try {
        const account = await stripe.accounts.retrieve(acct);
        const caps = account.capabilities || {};
        const transfersActive = caps.transfers === "active";
        const cardActive      = caps.card_payments === "active";
        const payoutsEnabled  = !!account.payouts_enabled;

        const amountCents = Math.max(0, Math.round(Number(creator.preis || 0) * 100));
        const vipDays = Number(creator.vip_days ?? creator.vip_dauer ?? 30);
        const feePct  = creator.application_fee_pct != null ? Number(creator.application_fee_pct) : null;

        const lineItem = {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: amountCents,
            recurring: { interval: "day", interval_count: vipDays },
            product_data: {
              name: `VIP‑Bot Zugang – ${row.creator_id.slice(0,8)}`,
              metadata: { creator_id: row.creator_id }
            }
          }
        };

        console.log("⚙️ creating checkout session for", { acct, userId, chatId, vipDays, amountCents, feePct });

        let session;
        if (transfersActive && payoutsEnabled) {
          // Destination charge über Plattform
          session = await stripe.checkout.sessions.create({
            mode: "subscription",
            success_url: `${BASE_URL}/stripe/success`,
            cancel_url: `${BASE_URL}/stripe/cancel`,
            allow_promotion_codes: true,
            line_items: [lineItem],
            subscription_data: {
              transfer_data: { destination: acct },
              ...(feePct != null ? { application_fee_percent: feePct } : {}),
              metadata: {
                creator_id: row.creator_id, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays)
              }
            },
            metadata: { creator_id: row.creator_id, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
          });
        } else if (cardActive) {
          // Direct charge im Connected Account
          session = await stripe.checkout.sessions.create({
            mode: "subscription",
            success_url: `${BASE_URL}/stripe/success`,
            cancel_url: `${BASE_URL}/stripe/cancel`,
            allow_promotion_codes: true,
            line_items: [lineItem],
            subscription_data: {
              ...(feePct != null ? { application_fee_percent: feePct } : {}),
              metadata: {
                creator_id: row.creator_id, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays)
              }
            },
            metadata: { creator_id: row.creator_id, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
          }, { stripeAccount: acct });
        } else {
          const link = await stripe.accountLinks.create({
            account: acct, type: "account_onboarding",
            refresh_url: `${BASE_URL}/stripe/connect/refresh?creator_id=${encodeURIComponent(row.creator_id)}`,
            return_url:  `${BASE_URL}/stripe/connect/return?creator_id=${encodeURIComponent(row.creator_id)}`
          });
          await bot.answerCallbackQuery(q.id, { text: "Stripe‑Onboarding unvollständig. Bitte abschließen." });
          await bot.sendMessage(chatId, `⚠️ Bitte schließe dein Stripe‑Onboarding ab:\n${link.url}`);
          return;
        }

        console.log("✅ checkout session created", { id: session.id, url: session.url });

        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(chatId, "💳 Bezahlung starten:", {
          reply_markup: { inline_keyboard: [[{ text: "Jetzt bezahlen", url: session.url }]] }
        });
      } catch (e) {
        console.error("Stripe session error:", e.message);
        await bot.answerCallbackQuery(q.id, { text: "Stripe Fehler. Später erneut versuchen." });
      }
    }
  });

  // sobald irgendeine Message → Kontaktzeit aktualisieren
  bot.on("message", async (msg) => {
    if (!msg?.from) return;
    await supabase.from("vip_users").update({ letzter_kontakt: nowTS() }).eq("telegram_id", String(msg.from.id));
  });

  // Helper: zeigt Pay-Button erst, wenn beides bestätigt
  async function maybeOfferPay(creator_id, chatId, userId) {
    const key = `${creator_id}:${userId}`;
    const s = consentState.get(key) || { age: false, rules: false };
    if (s.age && s.rules) {
      await bot.sendMessage(Number(chatId), "Alles klar – du kannst jetzt bezahlen.", {
        reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt bezahlen", callback_data: "pay_now" }]] }
      });
    } else {
      await bot.sendMessage(Number(chatId), `Noch offen: ${s.age ? "" : "🔞 Alterscheck "} ${s.rules ? "" : "📜 Regeln akzeptieren"}`.trim());
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Stripe Connect – Onboarding
// ──────────────────────────────────────────────────────────────────────────────
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
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
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
// Stripe – Webhook
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

  const retrieveSub = async (subId) => {
    if (!subId) return null;
    try {
      if (event.account) return await stripe.subscriptions.retrieve(subId, { stripeAccount: event.account });
      return await stripe.subscriptions.retrieve(subId);
    } catch (e) {
      console.error("retrieveSub error:", e.message);
      return null;
    }
  };

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;

    log("webhook: checkout.session.completed", {
      eventAccount: event.account || null,
      sessionId: s.id,
      subscription: s.subscription || null,
      sessMeta: s.metadata || null
    });

    let creator_id = s.metadata?.creator_id || null;
    let telegram_id = s.metadata?.telegram_id || null;
    let chat_id     = s.metadata?.chat_id || null;
    let vipDaysMeta = s.metadata?.vip_days || null;

    if (!vipDaysMeta && s.subscription) {
      const sub = await retrieveSub(s.subscription);
      if (sub?.metadata) {
        vipDaysMeta = vipDaysMeta || sub.metadata.vip_days;
        creator_id  = creator_id  || sub.metadata.creator_id;
        telegram_id = telegram_id || sub.metadata.telegram_id;
        chat_id     = chat_id     || sub.metadata.chat_id;
      }
    }

    try {
      const cfg = await getCreatorCfgById(creator_id);
      const days = Number(vipDaysMeta ?? cfg?.vip_days ?? cfg?.vip_dauer ?? 30);
      const vip_bis = addDaysISO(days);

      const { data: vipRow } = await supabase.from("vip_users").upsert(
        { creator_id, telegram_id, chat_id, status: "aktiv", vip_bis },
        { onConflict: "creator_id,telegram_id" }
      ).select("telegram_id, chat_id").maybeSingle();

      if (cfg?.welcome_text) await bot.sendMessage(Number(chat_id), cfg.welcome_text);
      if (cfg?.regeln_text)  await bot.sendMessage(Number(chat_id), cfg.regeln_text);

      if (cfg?.group_chat_id) {
        const result = await sendDynamicInvitePerModel({
          creator_id,
          group_chat_id: cfg.group_chat_id,
          chat_id_or_user_id: vipRow?.chat_id || chat_id
        });
        if (!result.ok && cfg?.gruppe_link) {
          await bot.sendMessage(Number(chat_id), `🔗 Fallback‑Zugang: ${cfg.gruppe_link}`);
        } else if (!result.ok) {
          await bot.sendMessage(Number(chat_id), "⚠️ Zugang aktuell nicht möglich. Bitte Support kontaktieren.");
        }
      } else {
        if (cfg?.gruppe_link) {
          await bot.sendMessage(Number(chat_id), `🔗 Dein VIP‑Zugang: ${cfg.gruppe_link}`);
        } else {
          await bot.sendMessage(Number(chat_id), "⚠️ Der Creator hat noch keine Gruppe verbunden.");
        }
      }
    } catch (e) { console.error("Fulfill error:", e.message); }
  }

  if (event.type === "invoice.paid") {
    const inv = event.data.object;
    try {
      const subId = inv.subscription;
      if (!subId) return;
      const subscription = await retrieveSub(subId);
      const md = subscription?.metadata || {};
      const creator_id = md.creator_id;
      const telegram_id = md.telegram_id;
      const chat_id = md.chat_id;
      const vipDays = Number(md.vip_days || 30);
      if (!creator_id || !telegram_id) return;

      const vip_bis = addDaysISO(vipDays);
      await supabase.from("vip_users").upsert(
        { creator_id, telegram_id, chat_id, status: "aktiv", vip_bis },
        { onConflict: "creator_id,telegram_id" }
      );
    } catch (e) {
      console.error("invoice.paid handler error:", e.message);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    try {
      const md = sub?.metadata || {};
      const creator_id = md.creator_id;
      const telegram_id = md.telegram_id;
      if (!creator_id || !telegram_id) return;

      await supabase.from("vip_users").update({ status: "gekündigt" })
        .eq("creator_id", creator_id).eq("telegram_id", telegram_id);
    } catch (e) {
      console.error("subscription.deleted handler error:", e.message);
    }
  }

  res.json({ received: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Daily Cron – Reminder & Kick
// ──────────────────────────────────────────────────────────────────────────────
cron.schedule("0 8 * * *", async () => {
  const today = todayISO();
  const warnDate = addDaysISO(5);

  const { data: warnUsers } = await supabase.from("vip_users")
    .select("telegram_id, chat_id, vip_bis")
    .gte("vip_bis", today).lte("vip_bis", warnDate).eq("status", "aktiv");
  for (const u of warnUsers || []) {
    await bot.sendMessage(Number(u.chat_id || u.telegram_id),
      `⏰ Dein VIP läuft am ${u.vip_bis} ab. Verlängere rechtzeitig mit /start → „Jetzt bezahlen“.`);
  }

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
