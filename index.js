// index.js – Luxbot @ Render (Telegram + Stripe Connect + Supabase + Voice-Intro + Flirty Welcome + Robust VIP Persistenz + Join-Guard + Instant Checkout)
import express from "express";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";
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
const STRIPE_ACCOUNT_COUNTRY = process.env.STRIPE_ACCOUNT_COUNTRY || ""; // optional
// Admin-ID für stille Alerts
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID ? String(process.env.ADMIN_TELEGRAM_ID) : null;

if (!BOT_TOKEN || !BASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ ENV fehlt. Setze: BOT_TOKEN, BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ──────────────────────────────────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────────────────────────────────
const nowTS = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

// Escape für Telegram MarkdownV2 (damit welcome_text sicher gerendert wird)
function escapeMDV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Consent-Tracker (In-Memory) für Alterscheck & Regeln vor Zahlung
const consentState = new Map();

// Mini-"Session" NUR für Creator-Wizard (Voice)
const modelWizard = new Map(); // key = telegram_id, value = { expectVoice:bool, expectCaption:bool }
function getMW(userId) {
  const k = String(userId);
  if (!modelWizard.has(k)) modelWizard.set(k, { expectVoice: false, expectCaption: false });
  return modelWizard.get(k);
}

// 🔥 Flirty Welcome aus welcome_text (+ ${first_name}) + Preis/Dauer + Confirm-Block (alles MDV2-escaped)
function buildWelcomeMessage(creator, firstName = "") {
  const { display: priceDisplay } = parsePrice(creator.preis);
  const days  = Number(creator.vip_days ?? creator.vip_dauer ?? 30);

  const baseRaw =
    (creator.welcome_text && creator.welcome_text.trim().length > 0)
      ? creator.welcome_text.replace(/\$\{?first_name\}?/g, firstName).trim()
      : (
`👋 Hey ${firstName}… schön, dass du zu mir gefunden hast 😘

Hier bekommst du meinen **privatesten VIP-Zugang** – nur die heißesten Inhalte, die du sonst nirgends siehst 🔥`
        .trim()
      );

  const metaRaw = `\n\n💶 ${priceDisplay}  •  ⏳ ${days} Tage exklusiv`;
  const confirmRaw =
`\n\nBevor ich dich reinlasse, brauch ich nur dein Go:
1) 🔞 Du bist wirklich 18+
2) 📜 Du akzeptierst meine Regeln

Danach öffne ich dir meine VIP-Welt… es wird **heiß** 😏`;

  return escapeMDV2(baseRaw) + escapeMDV2(metaRaw) + escapeMDV2(confirmRaw);
}

// CreatorConfig per creator_id (inkl. Voice-Felder)
async function getCreatorCfgById(creator_id) {
  if (!creator_id) return null;
  const { data, error } = await supabase
    .from("creator_config")
    .select(`
      creator_id,
      preis,
      vip_days,
      vip_dauer,
      gruppe_link,
      group_chat_id,
      stripe_price_id,
      stripe_account_id,
      application_fee_pct,
      welcome_text,
      regeln_text,
      voice_enabled,
      voice_file_id,
      voice_caption
    `)
    .eq("creator_id", creator_id)
    .maybeSingle();
  if (error) {
    console.error("DB getCreatorCfgById error:", error.message);
    return null;
  }
  return data || null;
}

// Creator anhand Telegram-ID (Owner/Model) finden
async function getCreatorByTelegramId(telegramId) {
  const { data, error } = await supabase
    .from("creator_config")
    .select("creator_id, telegram_id, voice_enabled, voice_file_id, voice_caption")
    .eq("telegram_id", String(telegramId))
    .maybeSingle();
  if (error) {
    console.error("getCreatorByTelegramId error:", error.message);
    return null;
  }
  return data || null;
}

// Voice file_id speichern/aktivieren
async function saveCreatorVoice(telegramId, fileId) {
  const { error } = await supabase
    .from("creator_config")
    .update({
      voice_file_id: fileId,
      voice_enabled: true,
      voice_updated_at: new Date().toISOString()
    })
    .eq("telegram_id", String(telegramId));
  if (error) console.error("saveCreatorVoice error:", error.message);
  return !error;
}

// Caption speichern/ändern
async function saveCreatorVoiceCaption(telegramId, caption) {
  const { error } = await supabase
    .from("creator_config")
    .update({
      voice_caption: caption,
      voice_updated_at: new Date().toISOString()
    })
    .eq("telegram_id", String(telegramId));
  if (error) console.error("saveCreatorVoiceCaption error:", error.message);
  return !error;
}
// Preis-Parsing: akzeptiert "12,99", "12.99", "1.234,56", "€ 12,50", etc.
function parsePrice(preisLike) {
  if (preisLike == null) return { value: 0, cents: 0, display: "0 €" };
  let raw = String(preisLike).trim();

  // alles außer Ziffern, Komma, Punkt, Minus entfernen (Währungen/Spaces raus)
  raw = raw.replace(/[^\d,.\-]/g, "");

  // beide Trenner vorhanden → letzten als Dezimaltrenner behandeln
  const hasComma = raw.includes(",");
  const hasDot   = raw.includes(".");
  if (hasComma && hasDot) {
    const lastComma = raw.lastIndexOf(",");
       const lastDot   = raw.lastIndexOf(".");
    const decimalSep = lastComma > lastDot ? "," : ".";
    // alle Gruppentrenner entfernen (der "andere" Trenner)
    const groupSep = decimalSep === "," ? "." : ",";
    raw = raw.split(groupSep).join("");
    if (decimalSep === ",") raw = raw.replace(",", ".");
  } else if (hasComma) {
    // nur Komma → europäisches Dezimal
    raw = raw.replace(",", ".");
  } else {
    // nur Punkt oder nur Ziffern → schon okay
  }

  const value = Number.parseFloat(raw);
  const safe  = Number.isFinite(value) ? value : 0;
  const cents = Math.max(0, Math.round(safe * 100));

  // hübsche EUR-Anzeige (de-DE)
  const display = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2
  }).format(safe);

  return { value: safe, cents, display };
}
// ──────────────────────────────────────────────────────────────────────────────
// Robuste VIP-Persistenz (Retries, Dead-Letter, Admin-Alert)
// ──────────────────────────────────────────────────────────────────────────────
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function logVipUserError(payload = {}, err = {}) {
  try {
    await supabase.from("vip_users_errors").insert({
      payload_json: JSON.stringify(payload),
      error_msg: err?.message || String(err),
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("vip_users_errors insert failed:", e?.message || e);
  }
}

async function notifyAdmin(text) {
  try {
    if (ADMIN_TELEGRAM_ID) {
      await bot.sendMessage(Number(ADMIN_TELEGRAM_ID), `⚠️ VIP-Persistenz: ${text}`);
    }
  } catch (e) {
    console.error("notifyAdmin failed:", e?.message || e);
  }
}

/** Sicherer VIP-Upsert mit Retries & Dead-Letter */
async function ensureVipUserRow({
  creator_id,
  telegram_id,
  chat_id = null,
  status = null,            // "gestartet" | "aktiv" | "abgelaufen" | "gekündigt"
  vip_bis = null,           // "YYYY-MM-DD"
  username = null,
  letztes_event = null,     // optional
  extra = {}                // optional: wird (falls vorhanden) in extras_json gespeichert
}) {
  if (!creator_id || !telegram_id) {
    throw new Error("ensureVipUserRow: creator_id und telegram_id sind erforderlich");
  }

  const payload = {
    creator_id,
    telegram_id: String(telegram_id),
    ...(chat_id ? { chat_id: String(chat_id) } : {}),
    ...(status ? { status } : {}),
    ...(vip_bis ? { vip_bis } : {}),
    ...(username ? { username } : {}),
    ...(letztes_event ? { letztes_event } : {}),
    letzter_kontakt: nowTS()
  };

  if (extra && Object.keys(extra).length) payload.extras_json = extra;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, error } = await supabase
        .from("vip_users")
        .upsert(payload, { onConflict: "creator_id,telegram_id" })
        .select("creator_id, telegram_id, chat_id, status, vip_bis")
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Upsert returned no data");
      return { ok: true, data, attempt };
    } catch (e) {
      lastErr = e;
      console.error(`ensureVipUserRow attempt ${attempt} failed:`, e?.message || e);
      if (attempt < 3) { await wait(300 * attempt); continue; }
      await logVipUserError({ scope: "ensureVipUserRow", payload }, e);
      const msg = `DB-Schreiben fehlgeschlagen (3x)
creator=${creator_id}
tg=${telegram_id}
err=${(e?.message || String(e)).slice(0, 300)}`;
      await notifyAdmin(msg);
      return { ok: false, error: lastErr };
    }
  }
}

async function setVipStatus({ creator_id, telegram_id, chat_id = null, status, vip_bis = null, username = null, letztes_event = null, extra = {} }) {
  return ensureVipUserRow({ creator_id, telegram_id, chat_id, status, vip_bis, username, letztes_event, extra });
}

// ──────────────────────────────────────────────────────────────────────────────
// Join-Guard Hilfsfunktionen (Gruppenschutz)
// ──────────────────────────────────────────────────────────────────────────────

// Cache: group_chat_id -> creator_id
const groupCreatorCache = new Map();

async function getCreatorByGroupId(chatId) {
  const key = String(chatId);
  if (groupCreatorCache.has(key)) return groupCreatorCache.get(key);
  const { data, error } = await supabase
    .from("creator_config")
    .select("creator_id")
    .eq("group_chat_id", key)
    .maybeSingle();
  const cid = error ? null : data?.creator_id || null;
  if (cid) groupCreatorCache.set(key, cid);
  return cid;
}

// Prüft, ob Nutzer aktiver VIP ist (Status aktiv & nicht abgelaufen)
async function isActiveVip(creator_id, telegram_id) {
  if (!creator_id || !telegram_id) return false;
  const { data, error } = await supabase
    .from("vip_users")
    .select("status, vip_bis")
    .eq("creator_id", creator_id)
    .eq("telegram_id", String(telegram_id))
    .maybeSingle();
  if (error || !data) return false;
  const active = data.status === "aktiv";
  const notExpired = (data.vip_bis || todayISO()) >= todayISO();
  return active && notExpired;
}

// ──────────────────────────────────────────────────────────────────────────────
// Dynamische Einladungen (Join-Request ohne member_limit)
// ──────────────────────────────────────────────────────────────────────────────
async function sendDynamicInvitePerModel({ creator_id, group_chat_id, chat_id_or_user_id }) {
  if (!group_chat_id) {
    console.error("sendDynamicInvite: group_chat_id fehlt");
    return { ok: false, reason: "NO_GROUP" };
  }
  try {
    const expire = Math.floor(Date.now() / 1000) + (15 * 60); // 15 Min gültig
    const payload = {
      chat_id: group_chat_id,
      expire_date: expire,
      member_limit: 1,          // 👈 sorgt dafür, dass nur 1 Person den Link nutzen kann
      creates_join_request: false
    };

    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    if (!(resp?.ok && resp?.result?.invite_link)) {
      console.error("createChatInviteLink failed:", resp);
      return { ok: false, reason: "TG_API", raw: resp };
    }

    const invite_link = resp.result.invite_link;
    const expires_at = new Date(expire * 1000).toISOString();

    // Logging ins invite_links-Table
    try {
      await supabase.from("invite_links").insert({
        creator_id,
        telegram_id: String(chat_id_or_user_id),
        chat_id: String(chat_id_or_user_id),
        group_chat_id: String(group_chat_id),
        invite_link,
        expires_at,
        member_limit: 1,
        used: false
      });
    } catch {/* ignoriere */}

    await bot.sendMessage(
      Number(chat_id_or_user_id),
      `🎟️ Dein VIP-Zugang (einmalig, 15 Min gültig): ${invite_link}`
    );

    return { ok: true, invite_link, expires_at };
  } catch (e) {
    console.error("sendDynamicInvite error:", e.message);
    return { ok: false, reason: "EXCEPTION" };
  }
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
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// Express-Handler
app.post(telegramPath, (req, res) => {
  try { bot.processUpdate(req.body); } catch (err) { console.error("processUpdate error:", err); }
  res.sendStatus(200);
});
// Holt das Profilbild aus creator_config und sendet es in den Chat (falls vorhanden)
async function sendCreatorProfileIfAny(creator_id, chat_id) {
  try {
    const { data, error } = await supabase
      .from("creator_config")
      .select("profile_image_url, creator_name")
      .eq("creator_id", creator_id)
      .maybeSingle();

    if (error) {
      console.error("sendCreatorProfileIfAny fetch error:", error.message);
      return false;
    }
    const url = data?.profile_image_url;
    if (!url) return false;

    const caption = data?.creator_name ? `⭐ ${data.creator_name}` : undefined;
    await bot.sendPhoto(Number(chat_id), url, caption ? { caption } : undefined);
    return true;
  } catch (e) {
    console.error("sendCreatorProfileIfAny error:", e?.message || e);
    return false;
  }
}

async function bootstrapTelegram() {
  try {
    // alten Webhook entfernen, dann neu setzen
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "" })
    });
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: telegramWebhook })
    }).then(r => r.json());
  } catch (err) {
    console.error("❌ bootstrapTelegram error:", err.message);
  }

  // Auto-Bind beim Hinzufügen in Gruppe
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
      if (!adminIds.length) return;

      const { data: matches, error } = await supabase
        .from("creator_config")
        .select("creator_id, telegram_id")
        .in("telegram_id", adminIds);

      if (error || !matches || matches.length !== 1) return;

      await supabase.from("creator_config")
        .update({ group_chat_id: String(chat.id) })
        .eq("creator_id", matches[0].creator_id);

      await bot.sendMessage(chat.id, "✅ Gruppe verknüpft. Bitte gib mir Admin-Rechte für Einladungen & Kicks.");
    } catch (e) {
      console.error("my_chat_member auto-bind error:", e?.message || e);
    }
  });

  // CREATOR WIZARD: /setup_voice  (im DM)
  bot.onText(/^\/setup_voice\b/, async (msg) => {
    if (msg.chat.type !== "private") return;
    const me = await getCreatorByTelegramId(msg.from.id);
    if (!me) {
      await bot.sendMessage(msg.chat.id, "Dieser Bereich ist nur für verifizierte Creator freigeschaltet.");
      return;
    }
    const st = getMW(msg.from.id);
    st.expectVoice = true;
    st.expectCaption = false;

    await bot.sendMessage(
      msg.chat.id,
      "🎙️ Willst du jetzt eine Begrüßungs-Sprachnachricht aufnehmen?\n• Bitte nutze den **runden Voice-Button**.\n• Länge: **5–20 Sekunden**.",
      {
        reply_markup: {
          keyboard: [[{ text: "Aufnehmen" }], [{ text: "Abbrechen" }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );
  });

  // Wizard-Text / Caption
  bot.on("text", async (msg) => {
    const st = getMW(msg.from.id);

    if (st.expectCaption && msg.chat.type === "private") {
      const me = await getCreatorByTelegramId(msg.from.id);
      if (!me) return;
      const caption = (msg.text || "").trim().slice(0, 200);
      const ok = await saveCreatorVoiceCaption(msg.from.id, caption);
      st.expectCaption = false;
      await bot.sendMessage(msg.chat.id, ok ? "Caption gespeichert ✅" : "Konnte die Caption nicht speichern 😕. Versuch’s nochmal.");
      return;
    }

    if (msg.chat.type === "private") {
      if (msg.text === "Aufnehmen") {
        const me = await getCreatorByTelegramId(msg.from.id);
        if (!me) return;
        st.expectVoice = true;
        await bot.sendMessage(msg.chat.id, "Okay, bitte sende mir jetzt deine **Sprachnachricht** (runder Button).");
        return;
      }
      if (msg.text === "Abbrechen") {
        st.expectVoice = false;
        st.expectCaption = false;
        await bot.sendMessage(msg.chat.id, "Alles klar. Du kannst jederzeit /setup_voice senden.", { reply_markup: { remove_keyboard: true } });
        return;
      }
    }
  });

  // Voice empfangen (nur Creator im DM)
  bot.on("voice", async (msg) => {
    if (msg.chat.type !== "private") return;
    const me = await getCreatorByTelegramId(msg.from.id);
    if (!me) return;
    const st = getMW(msg.from.id);
    if (!st.expectVoice) return;

    const fileId = msg.voice?.file_id;
    if (!fileId) {
      await bot.sendMessage(msg.chat.id, "Konnte die Sprachnachricht nicht lesen. Bitte nochmal senden.");
      return;
    }

    const ok = await saveCreatorVoice(msg.from.id, fileId);
    st.expectVoice = false;

    if (!ok) {
      await bot.sendMessage(msg.chat.id, "Speichern fehlgeschlagen 😕 – bitte nochmal probieren.");
      return;
    }

    await bot.sendMessage(msg.chat.id, "Nice! ✅ Deine Voicenachricht ist gespeichert.", { reply_markup: { remove_keyboard: true } });
    await bot.sendMessage(msg.chat.id, "Möchtest du sie testweise abspielen oder eine Caption hinzufügen?", {
      reply_markup: { inline_keyboard: [[{ text: "▶️ Test abspielen", callback_data: "voice_test" }],[{ text: "📝 Caption hinzufügen", callback_data: "voice_caption" }]] }
    });
  });

  // /start (DM & Gruppe) – robust: creator_<id>, <id>, link_creator_<id>
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const raw = (match?.[1] || "").trim();

    // Käufer: /start creator_<uuid>  ODER nur <uuid>
    let creator_id = null;
    const m1 = /^creator_([A-Za-z0-9-]+)$/i.exec(raw);
    const m2 = /^([A-Za-z0-9-]{20,})$/i.exec(raw); // nackte UUID erlauben
    if (m1) creator_id = m1[1];
    else if (m2) creator_id = m2[1];

    // Admin: /start link_creator_<uuid>
    const adminLink = /^link_creator_([A-Za-z0-9-]+)$/i.exec(raw);

    // In Gruppe: Payload bevorzugt, sonst Auto-Bind
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      try {
        if (creator_id) {
          await supabase.from("creator_config").update({ group_chat_id: String(msg.chat.id) }).eq("creator_id", creator_id);
          await bot.sendMessage(msg.chat.id, "✅ Gruppe verbunden! Bitte Admin-Rechte geben.");
          return;
        }

        const adminsResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatAdministrators`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: msg.chat.id })
        }).then(r => r.json());

        const adminIds = (adminsResp?.result || []).map(a => String(a?.user?.id)).filter(Boolean);

        const { data: matches, error } = await supabase
          .from("creator_config").select("creator_id, telegram_id").in("telegram_id", adminIds);

        if (error) { await bot.sendMessage(msg.chat.id, "⚠️ DB-Fehler beim Verknüpfen. Bitte später erneut versuchen."); return; }
        if (!matches || matches.length === 0) {
          await bot.sendMessage(msg.chat.id, "ℹ️ Kein verknüpfbarer Creator gefunden.\nÖffne im **Privatchat** „Telegram verbinden“ in Luxbase und füge mich dann hier als Admin hinzu.");
          return;
        }
        if (matches.length > 1) {
          await bot.sendMessage(msg.chat.id, "⚠️ Mehrere Creator-Admins erkannt. Bitte nur den gewünschten Creator-Admin in dieser Gruppe belassen.");
          return;
        }

        await supabase.from("creator_config").update({ group_chat_id: String(msg.chat.id) }).eq("creator_id", matches[0].creator_id);
        await bot.sendMessage(msg.chat.id, "✅ Gruppe automatisch verknüpft. Gib mir bitte Admin-Rechte (Einladen & Kicken).");
      } catch (e) {
        console.error("group /start autobind error:", e?.message || e);
        await bot.sendMessage(msg.chat.id, "⚠️ Konnte die Gruppe nicht verknüpfen. Bitte später erneut versuchen.");
      }
      return;
    }

    // ADMIN-Flow (DM): Owner ↔ Creator koppeln
    if (adminLink && msg.chat.type === "private") {
      const cId = adminLink[1];
      await supabase.from("creator_config").update({
        telegram_id: String(msg.from.id),
        admin_telegram_username: msg.from.username || null
      }).eq("creator_id", cId);

      await bot.sendMessage(
        msg.chat.id,
        "✅ Dein Telegram wurde mit deinem Luxbase-Account verknüpft.\n" +
        "Füge mich jetzt als Admin in deiner VIP-Gruppe hinzu – ich verknüpfe sie automatisch.\n\n" +
        "Tipp: Du kannst jetzt /setup_voice senden und eine Begrüßungs-Sprachnachricht aufnehmen. 🎙️"
      );
      return;
    }

    // Käufer-Flow (DM)
    if (!creator_id) {
      await bot.sendMessage(msg.chat.id, "❌ Ungültiger Start-Link.\nÖffne den Link direkt aus den VIP-Einstellungen (er enthält eine Kennung).");
      return;
    }

    const creator = await getCreatorCfgById(creator_id);
    if (!creator) { await bot.sendMessage(msg.chat.id, "❌ Creator-Konfiguration nicht gefunden."); return; }

    // Voice-Intro (falls vorhanden) direkt vorspielen
    if (creator?.voice_enabled && creator?.voice_file_id && msg.chat.type === "private") {
      try {
        await bot.sendVoice(msg.chat.id, creator.voice_file_id, {
          caption: creator.voice_caption ? escapeMDV2(creator.voice_caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } catch (e) { console.error("sendVoice /start error:", e.message); }
    }

    // Käufer robust registrieren/aktualisieren
    await setVipStatus({
      creator_id,
      telegram_id: String(msg.from.id),
      chat_id: String(msg.chat.id),
      status: "gestartet",
      username: msg.from.username || null,
      letztes_event: "start_clicked",
      extra: { source: "telegram_start", chat_type: msg.chat.type }
    });

    // Consent-State initialisieren
    const key = `${creator_id}:${msg.from.id}`;
    consentState.set(key, { age: false, rules: false });

    // Flirty Welcome (MDV2-escaped)
    const text = buildWelcomeMessage(creator, msg.from.first_name || "");
   
    const kb = {
      inline_keyboard: [
        [{ text: "🔞 Ich bin 18+", callback_data: `consent_age:${creator_id}` }],
        [{ text: "📜 Regeln anzeigen", callback_data: `show_rules:${creator_id}` }],
        [{ text: "✅ Regeln akzeptieren", callback_data: `consent_rules:${creator_id}` }],
      ]
    };
    await bot.sendMessage(msg.chat.id, text, { reply_markup: kb, parse_mode: "MarkdownV2" });
  });

  // ── Instant-Checkout Helper ─────────────────────────────────────────────────
  async function startCheckout(creatorForPay, chatId, userId) {
    try {
      if (!stripe) {
        await bot.sendMessage(chatId, "⚠️ Stripe nicht konfiguriert.");
        return;
      }

      const creator = await getCreatorCfgById(creatorForPay);
      if (!creator) {
        await bot.sendMessage(chatId, "⚠️ Konfiguration fehlt.");
        return;
      }

      const acct = creator.stripe_account_id;
      if (!acct) {
        await bot.sendMessage(chatId, "⚠️ Stripe ist für diesen Creator noch nicht verbunden.");
        return;
      }

      const account = await stripe.accounts.retrieve(acct);
      const caps = account.capabilities || {};
      const transfersActive = caps.transfers === "active";
      const cardActive      = caps.card_payments === "active";
      const payoutsEnabled  = !!account.payouts_enabled;

      const { cents: amountCents } = parsePrice(creator.preis);
      const vipDays = Number(creator.vip_days ?? creator.vip_dauer ?? 30);
      const feePct  = creator.application_fee_pct != null ? Number(creator.application_fee_pct) : null;

      const lineItem = {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          recurring: { interval: "day", interval_count: vipDays },
          product_data: {
            name: `VIP-Bot Zugang – ${String(creatorForPay).slice(0,8)}`,
            metadata: { creator_id: creatorForPay }
          }
        }
      };

      let session;
      if (transfersActive && payoutsEnabled) {
        session = await stripe.checkout.sessions.create({
          mode: "subscription",
          success_url: `${BASE_URL}/stripe/success`,
          cancel_url:  `${BASE_URL}/stripe/cancel`,
          allow_promotion_codes: true,
          line_items: [lineItem],
          subscription_data: {
            transfer_data: { destination: acct },
            ...(feePct != null ? { application_fee_percent: feePct } : {}),
            metadata: { creator_id: creatorForPay, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
          },
          metadata: { creator_id: creatorForPay, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
        });
      } else if (cardActive) {
        session = await stripe.checkout.sessions.create({
          mode: "subscription",
          success_url: `${BASE_URL}/stripe/success`,
          cancel_url:  `${BASE_URL}/stripe/cancel`,
          allow_promotion_codes: true,
          line_items: [lineItem],
          subscription_data: {
            ...(feePct != null ? { application_fee_percent: feePct } : {}),
            metadata: { creator_id: creatorForPay, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
          },
          metadata: { creator_id: creatorForPay, telegram_id: userId, chat_id: String(chatId), vip_days: String(vipDays) }
        }, { stripeAccount: acct });
      } else {
        const link = await stripe.accountLinks.create({
          account: acct, type: "account_onboarding",
          refresh_url: `${BASE_URL}/stripe/connect/refresh?creator_id=${encodeURIComponent(creatorForPay)}`,
          return_url:  `${BASE_URL}/stripe/connect/return?creator_id=${encodeURIComponent(creatorForPay)}`
        });
        await bot.sendMessage(chatId, `⚠️ Bitte Stripe-Onboarding abschließen:\n${link.url}`);
        return;
      }

      // Genau EIN Payment-Post
      await bot.sendMessage(Number(chatId), "🧾 Öffne den Zahlungsdialog:", {
        reply_markup: { inline_keyboard: [[{ text: "💳 Jetzt bezahlen", url: session.url }]] }
      });
    } catch (e) {
      console.error("startCheckout error:", e?.message || e);
      await bot.sendMessage(Number(chatId), "⚠️ Es gab ein Problem beim Starten der Zahlung. Bitte später erneut versuchen.");
    }
  }

  // Callback-Handler (inkl. Voice-Test/Caption & Instant-Checkout)
  bot.on("callback_query", async (q) => {
    const chatId = q.message?.chat?.id;
    const userId = String(q.from.id);
    const data = q.data || "";

    // Voice-Callbacks
    if (data === "voice_test") {
      const me = await getCreatorByTelegramId(userId);
      if (!me) { await bot.answerCallbackQuery(q.id); return; }
      if (!me.voice_file_id) {
        await bot.answerCallbackQuery(q.id, { text: "Keine Voicenachricht gespeichert.", show_alert: true });
        return;
      }
      await bot.sendVoice(chatId, me.voice_file_id, {
        caption: me.voice_caption ? escapeMDV2(me.voice_caption) : undefined,
        parse_mode: "MarkdownV2"
      });
      await bot.answerCallbackQuery(q.id, { text: "Abgespielt!" });
      return;
    }

    if (data === "voice_caption") {
      const me = await getCreatorByTelegramId(userId);
      if (!me) { await bot.answerCallbackQuery(q.id); return; }
      const st = getMW(userId);
      st.expectCaption = true;
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, "Schick mir jetzt deine Caption (max. 200 Zeichen).");
      return;
    }

    // Consent State Helper
    const getState = (creator_id) => {
      const key = `${creator_id}:${userId}`;
      if (!consentState.has(key)) consentState.set(key, { age: false, rules: false });
      return { key, state: consentState.get(key) };
    };

    if (data.startsWith("consent_age:")) {
      const creator_id = data.split(":")[1];
      const { key, state } = getState(creator_id);
      state.age = true; consentState.set(key, state);
      await bot.answerCallbackQuery(q.id, { text: "Altersbestätigung gespeichert." });

      if (state.age && state.rules) {
        await startCheckout(creator_id, chatId, userId);
      } else {
        await bot.sendMessage(chatId, "Noch offen: 📜 Regeln akzeptieren");
      }
      return;
    }

    if (data.startsWith("show_rules:")) {
      const creator_id = data.split(":")[1];
      const creator = await getCreatorCfgById(creator_id);
      const rules = creator?.regeln_text || "Standard-Regeln: Kein Spam, kein Teilen von privaten Inhalten, respektvoll bleiben.";
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, escapeMDV2(`📜 Regeln:\n\n${rules}`), { parse_mode: "MarkdownV2" });
      return;
    }

    if (data.startsWith("consent_rules:")) {
      const creator_id = data.split(":")[1];
      const { key, state } = getState(creator_id);
      state.rules = true; consentState.set(key, state);
      await bot.answerCallbackQuery(q.id, { text: "Regeln akzeptiert." });

      if (state.age && state.rules) {
        await startCheckout(creator_id, chatId, userId);
      } else {
        await bot.sendMessage(chatId, "Noch offen: 🔞 Alterscheck");
      }
      return;
    }

    // Pay-Now Fallback (falls Buttons anderswo noch existieren)
    if (data.startsWith("pay_now")) {
      const parts = data.split(":");
      let creatorForPay = parts[1];

      if (!creatorForPay) {
        const { data: row } = await supabase.from("vip_users")
          .select("creator_id").eq("telegram_id", userId)
          .order("letzter_kontakt", { ascending: false }).limit(1).maybeSingle();
        creatorForPay = row?.creator_id;
      }

      if (!creatorForPay) { await bot.answerCallbackQuery(q.id, { text: "Bitte zuerst /start über den VIP-Link nutzen." }); return; }

      await bot.answerCallbackQuery(q.id, { text: "Öffne den Zahlungsdialog…" });
      await startCheckout(creatorForPay, chatId, userId);
      return;
    }
  });

  // JOIN-REQUEST GUARD: Nur aktive VIPs approven, sonst decline + DM
  bot.on("chat_join_request", async (upd) => {
    try {
      const chatId = upd.chat?.id;
      const userId = upd.from?.id;
      if (!chatId || !userId) return;

      const creator_id = await getCreatorByGroupId(chatId);
      if (!creator_id) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/declineChatJoinRequest`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, user_id: userId })
        });
        return;
      }

      const ok = await isActiveVip(creator_id, String(userId));
      const endpoint = ok ? "approveChatJoinRequest" : "declineChatJoinRequest";

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: userId })
      });

      if (!ok) {
        try {
          await bot.sendMessage(userId, "🚪 Zugang nur für aktive VIPs.\nStarte hier: /start über deinen VIP-Link.");
        } catch {}
      }
    } catch (e) {
      console.error("chat_join_request handler error:", e?.message || e);
    }
  });

  // MESSAGE-HOOK: letzter Kontakt + HARTE TÜR bei direkten Beitritten (Alt-Links)
  bot.on("message", async (msg) => {
    if (msg?.from) {
      try {
        await supabase.from("vip_users").update({ letzter_kontakt: nowTS() }).eq("telegram_id", String(msg.from.id));
      } catch (e) {
        console.error("letzter_kontakt update error:", e?.message || e);
        await logVipUserError({ scope: "last_contact_update", telegram_id: String(msg.from.id) }, e);
      }
    }

    const newMembers = msg?.new_chat_members;
    const chatId = msg?.chat?.id;
    if (!chatId || !Array.isArray(newMembers) || newMembers.length === 0) return;

    const creator_id = await getCreatorByGroupId(chatId);
    if (!creator_id) return;

    // Willkommenssystem-Meldung löschen (sauberer Chat)
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id })
      });
    } catch {}

    for (const m of newMembers) {
      const userId = m?.id;
      if (!userId || m?.is_bot) continue;
      const ok = await isActiveVip(creator_id, String(userId));
      if (ok) continue;

      // Sofortiger Kick (ban → unban) + DM
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, user_id: userId })
        });
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, user_id: userId, only_if_banned: true })
        });
        try {
          await bot.sendMessage(userId, "❌ Diese Gruppe ist nur für aktive VIPs.\nHol dir Zugang mit /start über den VIP-Link.");
        } catch {}
      } catch (e) {
        console.error("Guard kick error:", e?.message || e);
      }
    }
  });
}

// maybeOfferPay bleibt als Wrapper erhalten (optional)
async function maybeOfferPay(creator_id, chatId, userId) {
  const key = `${creator_id}:${userId}`;
  const s = consentState.get(key) || { age: false, rules: false };
  if (s.age && s.rules) {
    // Wird automatisch von startCheckout übernommen
    const botChatId = Number(chatId);
    await bot.sendMessage(botChatId, "⏳ Öffne den Bezahl-Dialog…");
    await startCheckout(creator_id, chatId, userId);
  } else {
    const missing = [
      s.age ? null : "🔞 Alterscheck",
      s.rules ? null : "📜 Regeln akzeptieren"
    ].filter(Boolean).join(" & ");
    await bot.sendMessage(Number(chatId), `Noch offen: ${missing}`.trim());
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

      const { error: upErr } = await supabase.from("creator_config").update({ stripe_account_id: accountId }).eq("creator_id", creator_id);
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

app.get("/stripe/connect/refresh", (_, res) => res.send("🔄 Onboarding abgebrochen – bitte erneut auf „Stripe verbinden“ klicken."));
app.get("/stripe/connect/return",  (_, res) => res.send("✅ Onboarding abgeschlossen (oder fortgesetzt). Du kannst dieses Fenster schließen."));

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
      // ⬅️ Vorherigen VIP-Status abfragen, um zu erkennen ob es eine Verlängerung ist
      const { data: prevVip } = await supabase
        .from("vip_users")
        .select("status, vip_bis")
        .eq("creator_id", creator_id)
        .eq("telegram_id", String(telegram_id))
        .maybeSingle();

      const wasActive =
        !!prevVip &&
        prevVip.status === "aktiv" &&
        (prevVip.vip_bis || "") >= todayISO();

      const cfg   = await getCreatorCfgById(creator_id);
      const days  = Number(vipDaysMeta ?? cfg?.vip_days ?? cfg?.vip_dauer ?? 30);
      const vip_bis = addDaysISO(days);

      // Persistenz
      const resVip = await setVipStatus({
        creator_id,
        telegram_id,
        chat_id,
        status: "aktiv",
        vip_bis,
        letztes_event: "checkout.session.completed",
        extra: { stripe_session_id: s.id, stripe_account: event.account || null }
      });

      const targetChat = Number(chat_id || telegram_id);

      if (wasActive) {
        // ✅ Erneuerung: nur Danke/Bestätigung, KEIN neuer Link
        await bot.sendMessage(
          targetChat,
          `✅ Danke, deine VIP-Zeit wurde verlängert!\nNeues Ablaufdatum: ${vip_bis}`
        );
      } else {
        // 🆕 Erstkauf: Welcome + Invite (wie zuvor)
        if (cfg?.welcome_text) {
          await bot.sendMessage(targetChat, escapeMDV2(cfg.welcome_text), { parse_mode: "MarkdownV2" });
        }

        if (cfg?.group_chat_id) {
          const result = await sendDynamicInvitePerModel({
            creator_id,
            group_chat_id: cfg.group_chat_id,
            chat_id_or_user_id: resVip?.data?.chat_id || chat_id
          });
          if (!result.ok && cfg?.gruppe_link) {
            await bot.sendMessage(targetChat, `🔗 Fallback-Zugang: ${cfg.gruppe_link}`);
          } else if (!result.ok) {
            await bot.sendMessage(targetChat, "⚠️ Zugang aktuell nicht möglich. Bitte Support kontaktieren.");
          }
        } else {
          if (cfg?.gruppe_link) {
            await bot.sendMessage(targetChat, `🔗 Dein VIP-Zugang: ${cfg.gruppe_link}`);
          } else {
            await bot.sendMessage(targetChat, "⚠️ Der Creator hat noch keine Gruppe verbunden.");
          }
        }
      }
    } catch (e) {
      console.error("Fulfill error:", e.message);
    }
  }

  if (event.type === "invoice.paid") {
    const inv = event.data.object;
    try {
      const subId = inv.subscription;
      if (!subId) return;

      const subscription = await retrieveSub(subId);
      const md = subscription?.metadata || {};
      const creator_id  = md.creator_id;
      const telegram_id = md.telegram_id;
      const chat_id     = md.chat_id;
      const vipDays     = Number(md.vip_days || 30);
      if (!creator_id || !telegram_id) return;

      const vip_bis = addDaysISO(vipDays);

      await setVipStatus({
        creator_id,
        telegram_id,
        chat_id,
        status: "aktiv",
        vip_bis,
        letztes_event: "invoice.paid",
        extra: { invoice_id: inv.id, sub_id: subId }
      });

      // ✅ Immer kurze Danke/Bestätigungs-Message bei (Folge-)Rechnungen
      await bot.sendMessage(
        Number(chat_id || telegram_id),
        `✅ Danke, deine VIP-Zeit wurde verlängert!\nNeues Ablaufdatum: ${vip_bis}`
      );
    } catch (e) {
      console.error("invoice.paid handler error:", e.message);
    }
  }

  res.sendStatus(200);   // Antwort senden
});                      // Route schließen

// ──────────────────────────────────────────────────────────────────────────────
// Renewal-Checkout-Link erzeugen (Stripe)
// ──────────────────────────────────────────────────────────────────────────────
async function createRenewalCheckout({ creator_id, telegram_id, chat_id }) {
  if (!stripe) return null;

  const creator = await getCreatorCfgById(creator_id);
  if (!creator || !creator.preis) return null;

  const acct = creator.stripe_account_id;
  if (!acct) return null;

  try {
    const account = await stripe.accounts.retrieve(acct);
    const caps = account.capabilities || {};
    const transfersActive = caps.transfers === "active";
    const cardActive      = caps.card_payments === "active";
    const payoutsEnabled  = !!account.payouts_enabled;

    const { cents: amountCents } = parsePrice(creator.preis);
    const vipDays     = Number(creator.vip_days ?? creator.vip_dauer ?? 30);
    const feePct      = creator.application_fee_pct != null ? Number(creator.application_fee_pct) : null;

    const lineItem = {
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: amountCents,
        recurring: { interval: "day", interval_count: vipDays },
        product_data: { name: `VIP-Bot Zugang – ${String(creator_id).slice(0,8)}`, metadata: { creator_id } }
      }
    };

    let session;
    if (transfersActive && payoutsEnabled) {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        success_url: `${BASE_URL}/stripe/success`,
        cancel_url:  `${BASE_URL}/stripe/cancel`,
        allow_promotion_codes: true,
        line_items: [lineItem],
        subscription_data: {
          transfer_data: { destination: acct },
          ...(feePct != null ? { application_fee_percent: feePct } : {}),
          metadata: { creator_id, telegram_id, chat_id: String(chat_id), vip_days: String(vipDays) }
        },
        metadata: { creator_id, telegram_id, chat_id: String(chat_id), vip_days: String(vipDays) }
      });
    } else if (cardActive) {
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        success_url: `${BASE_URL}/stripe/success`,
        cancel_url:  `${BASE_URL}/stripe/cancel`,
        allow_promotion_codes: true,
        line_items: [lineItem],
        subscription_data: {
          ...(feePct != null ? { application_fee_percent: feePct } : {}),
          metadata: { creator_id, telegram_id, chat_id: String(chat_id), vip_days: String(vipDays) }
        },
        metadata: { creator_id, telegram_id, chat_id: String(chat_id), vip_days: String(vipDays) }
      }, { stripeAccount: acct });
    } else {
      return null;
    }
    return session?.url || null;
  } catch (e) {
    console.error("createRenewalCheckout error:", e?.message || e);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Daily Check – Reminder (mit Verlängerungslink) & Kick
// ──────────────────────────────────────────────────────────────────────────────
async function runExpirySweep() {
  const today = todayISO();
  const warnDate = addDaysISO(5);

  // 1) Nutzer laden, die in 5 Tagen ablaufen
  const { data: warnUsers, error: warnErr } = await supabase
    .from("vip_users")
    .select("creator_id, telegram_id, chat_id, vip_bis")
    .gte("vip_bis", today)
    .lte("vip_bis", warnDate)
    .eq("status", "aktiv");

  if (warnErr) {
    console.error("warnUsers query error:", warnErr.message);
  }

  // 2) Creator-Namen für diese Nutzer laden
  const warnCreatorIds = [...new Set((warnUsers || []).map(u => u.creator_id))];
  const { data: warnCfgs } = warnCreatorIds.length
    ? await supabase
        .from("creator_config")
        .select("creator_id, creator_name")
        .in("creator_id", warnCreatorIds)
    : { data: [] };
  const warnNameMap = new Map((warnCfgs || []).map(c => [c.creator_id, c.creator_name]));

  // 3) Reminder mit Verlängerungslink
  for (const u of warnUsers || []) {
    try {
      const url = await createRenewalCheckout({
        creator_id: u.creator_id,
        telegram_id: String(u.telegram_id),
        chat_id: String(u.chat_id || u.telegram_id)
      });
      const modelName = warnNameMap.get(u.creator_id) || "dein Creator";
      const text = `⏰ Dein VIP für *${modelName}* läuft am ${u.vip_bis} ab.\nVerlängere rechtzeitig, um drin zu bleiben.`;

      if (url) {
        await bot.sendMessage(Number(u.chat_id || u.telegram_id), text, {
          reply_markup: { inline_keyboard: [[{ text: "🔁 VIP jetzt verlängern", url }]] },
          parse_mode: "Markdown"
        });
      } else {
        await bot.sendMessage(
          Number(u.chat_id || u.telegram_id),
          `${text}\n\nTipp: Nutze /start und klicke „Jetzt bezahlen“.`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (e) {
      console.error("warn send error:", e?.message || e);
    }
  }

  // 4) Abgelaufene → kicken
  const { data: expired, error: expErr } = await supabase
    .from("vip_users")
    .select("creator_id, telegram_id, chat_id, vip_bis")
    .lt("vip_bis", today)
    .eq("status", "aktiv");

  if (expErr) {
    console.error("expired query error:", expErr.message);
    return;
  }

  if (expired?.length) {
    // Creator-Config einmal holen (inkl. group_chat_id + creator_name)
    const expiredCreatorIds = [...new Set(expired.map(u => u.creator_id))];
    const { data: cfgs } = await supabase
      .from("creator_config")
      .select("creator_id, group_chat_id, creator_name")
      .in("creator_id", expiredCreatorIds);

    const groupMap = new Map((cfgs || []).map(c => [c.creator_id, c.group_chat_id]));
    const nameMap  = new Map((cfgs || []).map(c => [c.creator_id, c.creator_name]));

    for (const u of expired) {
      const group = groupMap.get(u.creator_id);
      if (!group) continue;
      const modelName = nameMap.get(u.creator_id) || "dein Creator";

      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: group, user_id: Number(u.telegram_id) })
        });
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: group, user_id: Number(u.telegram_id), only_if_banned: true })
        });

        await supabase.from("vip_users")
          .update({ status: "abgelaufen" })
          .eq("creator_id", u.creator_id)
          .eq("telegram_id", u.telegram_id);

        await bot.sendMessage(
          Number(u.chat_id || u.telegram_id),
          `❌ Dein VIP für *${modelName}* ist abgelaufen. Du wurdest aus der Gruppe entfernt.\nMit /start → „Jetzt bezahlen“ kannst du jederzeit verlängern.`,
          { parse_mode: "Markdown" }
        );
      } catch (e) {
        console.error("kick flow error:", e?.message || e);
      }
    }
  }
}

// Cron sichtbar machen + validieren + sofort laufen lassen
const CRON_EXPR = (process.env.CRON_EXPR && process.env.CRON_EXPR.trim()) || "0 8 * * *";
console.log("[CRON] expr =", JSON.stringify(CRON_EXPR), "valid =", cron.validate(CRON_EXPR));

const task = cron.schedule(
  CRON_EXPR,
  async () => {
    try {
      await runExpirySweep();
      console.log("⏲️ expiry sweep done @", new Date().toISOString());
    } catch (e) {
      console.error("expiry sweep error:", e?.message || e);
    }
  },
  { timezone: "Europe/Berlin", scheduled: true }
);

console.log("[CRON] status after schedule =", task.getStatus?.() || "scheduled");

// Optional: einmal direkt beim Boot ausführen (hilft beim Testen)
(async () => {
  try {
    console.log("[CRON] boot-run start");
    await runExpirySweep();
    console.log("[CRON] boot-run done");
  } catch (e) {
    console.error("[CRON] boot-run error:", e?.message || e);
  }
})();

// ──────────────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("Luxbot up"));
app.get("/stripe/success", (_, res) => res.send("✅ Zahlung erfolgreich. Der Bot sendet dir gleich den Zugang in Telegram."));
app.get("/stripe/cancel",  (_, res) => res.send("❌ Zahlung abgebrochen."));

// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 on :${PORT}  webhook: ${telegramWebhook}`);
  await bootstrapTelegram();
});
