// index.js
import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import cron from "node-cron";

/* -------------------------------------------------------------------------- */
/* ENV                                                                        */
/* -------------------------------------------------------------------------- */
const {
  BOT_TOKEN,
  BASE_URL, // z.B. https://luxbasebot.onrender.com
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,        // optional
  STRIPE_SECRET_KEY,        // optional
  STRIPE_WEBHOOK_SECRET,    // optional
  PORT = 3000
} = process.env;

if (!BOT_TOKEN || !BASE_URL) {
  console.error("❌ BOT_TOKEN oder BASE_URL fehlt.");
  process.exit(1);
}
const SB_URL = SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
if (!SB_URL) {
  console.error("❌ SUPABASE_URL fehlt.");
  process.exit(1);
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY fehlt – Server kann nicht in die DB schreiben (RLS)!");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Supabase Clients                                                           */
/* -------------------------------------------------------------------------- */
const supabaseAdmin = createClient(SB_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const supabaseAnon = SUPABASE_ANON_KEY
  ? createClient(SB_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */
const nowTS = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const todayISO = () => new Date().toISOString().slice(0, 10);

function escapeMDV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

const consentState = new Map();

/** Deep-Link Payloads: /start creator_<uuid> | cid_<uuid> | <uuid> | base64(uuid) */
function parseCreatorFromStart(text = "") {
  const m = text?.match?.(/^\/start(?:\s+(.+))?$/i);
  if (!m) return null;
  const payload = (m[1] || "").trim();
  if (!payload) return null;

  if (/^cid_/i.test(payload)) return payload.slice(4);
  if (/^creator_/i.test(payload)) return payload.slice(8);
  if (/^[0-9a-f-]{36}$/i.test(payload)) return payload;

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(decoded)) return decoded;
  } catch {}
  return null;
}

// Welcome
function buildWelcomeMessage(creator, firstName = "") {
  const price = Number(creator?.preis || 0).toFixed(0);
  const days  = Number(creator?.vip_days ?? creator?.vip_dauer ?? 30);

  const baseRaw =
    (creator?.welcome_text && creator.welcome_text.trim().length > 0)
      ? creator.welcome_text.replace(/\$\{?first_name\}?/g, firstName).trim()
      : (
`Herzlich Willkommen im VIP Bereich! hier findest du die exklusiven Inhalte von mir!

Hier bekommst du meinen **privatesten VIP-Zugang** – nur die heißesten Inhalte, direkt von mir zu dir.`
      ).trim();

  const metaRaw   = `\n\n💶 ${price} €  •  ⏳ ${days} Tage exklusiv`;
  const confirmRaw =
`\n\nBevor ich dich reinlasse, brauch ich nur dein Go:
1) 🔞 Du bist wirklich 18+
2) 📜 Du akzeptierst meine Regeln

Danach öffne ich dir meine VIP-Welt… es wird **heiß** 😏`;

  return escapeMDV2(baseRaw + metaRaw + confirmRaw);
}

/* ------------------------------- SB Helpers -------------------------------- */
async function sbAdminUpsert(table, payload, opts) {
  const { data, error } = await supabaseAdmin.from(table).upsert(payload, opts);
  if (error) {
    console.error(`[SB upsert ${table}]`, error.message, { payload, opts });
    throw error;
  }
  return data;
}
async function sbAdminUpdate(table, patch, match) {
  const { data, error } = await supabaseAdmin.from(table).update(patch).match(match);
  if (error) {
    console.error(`[SB update ${table}]`, error.message, { patch, match });
    throw error;
  }
  return data;
}
async function sbSelect(table, select, match, single = false) {
  let q = supabaseAdmin.from(table).select(select);
  if (match) q = q.match(match);
  const { data, error } = single ? await q.maybeSingle() : await q;
  if (error) {
    console.error(`[SB select ${table}]`, error.message, { select, match });
    throw error;
  }
  return data;
}

async function getCreatorCfgById(creator_id) {
  return await sbSelect("creator_config", "*", { creator_id }, true);
}

/* ----------------------- Invite: nur Einmallinks erlauben ------------------- */
async function findValidInvite({ creator_id, group_chat_id, telegram_id, invite_url }) {
  let row = null;
  if (invite_url) {
    row = await sbSelect(
      "invite_links",
      "*",
      { creator_id: String(creator_id), group_chat_id: String(group_chat_id), invite_link: String(invite_url), used: false },
      true
    ).catch(() => null);
  }
  if (!row) {
    row = await sbSelect(
      "invite_links",
      "*",
      { creator_id: String(creator_id), group_chat_id: String(group_chat_id), telegram_id: String(telegram_id), used: false },
      true
    ).catch(() => null);
  }
  if (!row) return null;
  if (row.telegram_id && String(row.telegram_id) !== String(telegram_id)) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}
async function markInviteUsed({ id, used_by }) {
  await sbAdminUpdate("invite_links", { used: true, used_at: nowTS(), used_by: String(used_by) }, { id });
}

/* -------------------------------------------------------------------------- */
/* Express + Telegram                                                         */
/* -------------------------------------------------------------------------- */
const app = express();
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const telegramPath = `/bot${BOT_TOKEN}`;
const telegramWebhook = `${BASE_URL}${telegramPath}`;

/* ------------------------------ Webhook Retry ------------------------------ */
async function setWebhookWithRetry(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const ok = await bot.setWebHook(url);
      if (ok) return true;
    } catch (e) {
      const wait = (e?.response?.body?.parameters?.retry_after ?? 1) * 1000;
      console.warn(`Webhook set failed (try ${i + 1}/${tries}):`, e?.message || e);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return false;
}

/* ------------------------------- Stripe Setup ------------------------------ */
const stripePresent = !!STRIPE_SECRET_KEY;
const stripe = stripePresent ? new Stripe(STRIPE_SECRET_KEY) : null;
console.log("[Stripe] present:", stripePresent, "| WH secret present:", !!STRIPE_WEBHOOK_SECRET);

// Reachability/Debug
app.get("/stripe/webhook", (_req, res) => res.status(405).send("Use POST for Stripe webhooks."));
app.get("/stripe/ping", (_req, res) => {
  res.json({ ok: true, url: "/stripe/webhook", hasStripeKey: !!STRIPE_SECRET_KEY, hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET });
});
function logStripe(msg, extra = {}) {
  const time = new Date().toISOString();
  try { console.log(`[Stripe:${time}] ${msg}`, extra); } catch { console.log(`[Stripe:${time}] ${msg}`); }
}

/* -------------------------- Checkout Link Generator ------------------------ */
/** Liefert eine URL, auf die wir redirecten können (Stripe Checkout oder Payment Link). */
async function getCheckoutUrl({ creator_id, telegram_id }) {
  const cfg = await getCreatorCfgById(creator_id);
  // 1) Payment Link bevorzugen, wenn vorhanden
  if (cfg?.stripe_payment_link && typeof cfg.stripe_payment_link === "string" && cfg.stripe_payment_link.startsWith("http")) {
    // einige Payment-Link-Parameter können als Query mitgegeben werden
    const url = new URL(cfg.stripe_payment_link);
    url.searchParams.set("client_reference_id", String(telegram_id));
    url.searchParams.set("prefilled_email", ""); // optional
    return url.toString();
  }
  // 2) Checkout Session über price_id
  if (stripe && cfg?.stripe_price_id) {
    const mode = cfg?.stripe_mode === "subscription" ? "subscription" : "payment";
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: cfg.stripe_price_id, quantity: 1 }],
      success_url: `${BASE_URL}/pay/success?cid=${creator_id}&tid=${telegram_id}`,
      cancel_url: `${BASE_URL}/pay/cancel?cid=${creator_id}&tid=${telegram_id}`,
      allow_promotion_codes: true,
      metadata: { creator_id: String(creator_id), telegram_user_id: String(telegram_id) },
      client_reference_id: String(telegram_id)
    });
    return session.url;
  }
  // 3) Keine Stripe-Konfig vorhanden
  return null;
}

/* ------------------------------- Stripe Hook ------------------------------- */
/** WICHTIG: RAW Body VOR json() */
app.post("/stripe/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    logStripe("Webhook hit, aber Stripe nicht konfiguriert – noop 200.");
    return res.sendStatus(200);
  }

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    logStripe("Event constructed", { type: event.type, id: event.id });
  } catch (err) {
    console.error("Stripe signature error:", err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Sofort 200 an Stripe zurück
  res.json({ received: true });

  // Business-Handling (nachgelagert)
  try {
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer ? String(invoice.customer) : null;
      logStripe("invoice.payment_succeeded", { customerId });

      if (customerId) {
        const row = await sbSelect("vip_users", "creator_id, telegram_id", { stripe_customer_id: customerId }, true);
        if (row?.creator_id && row?.telegram_id) {
          await extendMembership({ creator_id: row.creator_id, telegram_id: row.telegram_id, days: 30 });
          logStripe("extended by invoice", { creator_id: row.creator_id, telegram_id: row.telegram_id });
        } else {
          logStripe("no vip_users match for customer", { customerId });
        }
      }
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer ? String(session.customer) : null;
      const telegramIdFromMeta = session?.metadata?.telegram_user_id ? String(session.metadata.telegram_user_id) : null;
      const creatorIdFromMeta  = session?.metadata?.creator_id || null;
      logStripe("checkout.session.completed", { customerId, telegramIdFromMeta, creatorIdFromMeta });

      if (telegramIdFromMeta && creatorIdFromMeta) {
        await sbAdminUpsert("vip_users", {
          creator_id: creatorIdFromMeta,
          telegram_id: telegramIdFromMeta,
          stripe_customer_id: customerId
        }, { onConflict: "creator_id,telegram_id" });

        await extendMembership({ creator_id: creatorIdFromMeta, telegram_id: telegramIdFromMeta, days: 30 });
        logStripe("extended by checkout + metadata", { creator_id: creatorIdFromMeta, telegram_id: telegramIdFromMeta });
      } else if (customerId) {
        const row = await sbSelect("vip_users", "creator_id, telegram_id", { stripe_customer_id: customerId }, true);
        if (row?.creator_id && row?.telegram_id) {
          await extendMembership({ creator_id: row.creator_id, telegram_id: row.telegram_id, days: 30 });
          logStripe("extended by checkout + customerId lookup", { creator_id: row.creator_id, telegram_id: row.telegram_id });
        } else {
          logStripe("checkout: no match via customerId either", { customerId });
        }
      }
    }
  } catch (e) {
    console.error("Stripe handler error (post-200):", e);
  }
});

// Optional: local debug ohne Signaturprüfung
app.post("/stripe/debug", bodyParser.json(), async (req, res) => {
  logStripe("DEBUG endpoint hit", { hasBody: !!req.body, keys: Object.keys(req.body || {}) });
  res.json({ ok: true });
});

/* -------------------------- Payment Redirect Routes ------------------------ */
// erzeugt/ermittelt eine Checkout-URL und leitet hin
app.get("/pay/:creator_id/:telegram_id", async (req, res) => {
  try {
    const { creator_id, telegram_id } = req.params;
    const url = await getCheckoutUrl({ creator_id, telegram_id });
    if (!url) {
      return res.status(500).send("Kein Stripe-Setup gefunden (stripe_price_id oder stripe_payment_link fehlt).");
    }
    res.redirect(url);
  } catch (e) {
    console.error("/pay redirect error:", e);
    res.status(500).send("Fehler beim Erstellen des Bezahlvorgangs.");
  }
});
app.get("/pay/success", (_req, res) => res.send("✅ Zahlung erfolgreich. Du wirst in Kürze freigeschaltet."));
app.get("/pay/cancel", (_req, res) => res.send("❌ Zahlung abgebrochen. Du kannst es jederzeit erneut versuchen."));

/* ------------------------ JSON parser & Telegram hook ---------------------- */
app.use(bodyParser.json());

app.post(telegramPath, (req, res) => {
  console.log("Webhook update:", JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/* ---------------------------- Health + Connect API ------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, base_url: BASE_URL, supabase_url_present: !!SB_URL }));

// 👉 Dashboard-Button „Bot verbinden“
app.get("/api/bot/connect", async (_req, res) => {
  try {
    const ok = await setWebhookWithRetry(telegramWebhook, 5);
    res.json({ ok, webhook: telegramWebhook });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* -------------------------------------------------------------------------- */
/* VIP Helpers                                                                */
/* -------------------------------------------------------------------------- */
const isActive = (row) => {
  if (!row?.vip_bis) return false;
  const until = new Date(row.vip_bis);
  return until.getTime() > Date.now();
};

// DM zuerst, Fallback: in die Gruppe (wenn übergeben)
async function notifyDMorGroup({ group_chat_id, userId, text, parse_mode = "MarkdownV2" }) {
  try {
    await bot.sendMessage(Number(userId), text, { parse_mode });
    return;
  } catch {
    if (group_chat_id) {
      await bot.sendMessage(
        Number(group_chat_id),
        `🔔 <a href="tg://user?id=${userId}">Hinweis</a>:\n${text}`,
        { parse_mode: "HTML" }
      );
    }
  }
}

async function markWarning({ creator_id, telegram_id, type }) {
  await sbAdminUpdate("vip_users", { letzte_erinnerung: type, warned_at: nowTS() }, { creator_id, telegram_id });
}

async function setMembership({ creator_id, telegram_id, untilISO, active, paid }) {
  const patch = {};
  if (untilISO) patch.vip_bis = untilISO;
  if (active !== undefined) patch.status = active ? "active" : "inactive";
  if (paid !== undefined) patch.zahlung_ok = !!paid;
  await sbAdminUpdate("vip_users", patch, { creator_id, telegram_id });
}

async function extendMembership({ creator_id, telegram_id, days = 30 }) {
  const row = await sbSelect("vip_users", "vip_bis", { creator_id, telegram_id }, true);

  const base = row?.vip_bis && new Date(row.vip_bis) > new Date()
    ? new Date(row.vip_bis)
    : new Date();

  const newUntil = new Date(base.getTime() + days * 864e5);
  await setMembership({ creator_id, telegram_id, untilISO: newUntil.toISOString(), active: true, paid: true });

  await notifyDMorGroup({
    group_chat_id: null,
    userId: telegram_id,
    text: escapeMDV2(`✅ Danke! Deine VIP-Mitgliedschaft wurde bis ${newUntil.toLocaleDateString()} verlängert (+${days} Tage).`)
  });

  return newUntil;
}

async function kickFromGroup({ group_chat_id, telegram_id }) {
  if (!group_chat_id) return false;
  try {
    await bot.banChatMember(Number(group_chat_id), Number(telegram_id));
    await bot.unbanChatMember(Number(group_chat_id), Number(telegram_id));
    return true;
  } catch (e) {
    console.error("kickFromGroup error:", e.message);
    return false;
  }
}

async function handleExpiry({ creator_id, telegram_id, group_chat_id }) {
  const row = await sbSelect("vip_users", "vip_bis, zahlung_ok, status", { creator_id, telegram_id }, true);
  if (!row) return;
  if (isActive(row)) return;

  await setMembership({ creator_id, telegram_id, active: false, paid: false });

  const kicked = await kickFromGroup({ group_chat_id, telegram_id });
  await notifyDMorGroup({
    group_chat_id,
    userId: telegram_id,
    text: escapeMDV2(
      `❌ Deine VIP-Mitgliedschaft ist abgelaufen${kicked ? " und du wurdest aus der VIP-Gruppe entfernt" : ""}.\n` +
      `👉 Nach Zahlung bekommst du automatisch +30 Tage.`
    )
  });
}

/* -------------------------------------------------------------------------- */
/* Creator-Lookup für Callback-Buttons                                        */
/* -------------------------------------------------------------------------- */
async function findCreatorIdForUser({ userId, chatId }) {
  // 1) exakte Kombi, falls Spalte existiert
  try {
    const row = await sbSelect("vip_users", "creator_id", { telegram_id: String(userId), chat_id: String(chatId) }, true);
    if (row?.creator_id) return row.creator_id;
  } catch {}
  // 2) Fallback: jüngster Eintrag nur via telegram_id
  try {
    const { data, error } = await supabaseAdmin
      .from("vip_users")
      .select("creator_id, created_at")
      .eq("telegram_id", String(userId))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data?.creator_id || null;
  } catch (e) {
    console.error("findCreatorIdForUser fallback error:", e.message);
    return null;
  }
}

/* ----------------------------- Pay-Button Helper --------------------------- */
async function sendPayButton({ chatId, creator_id, telegram_id }) {
  const url = `${BASE_URL}/pay/${creator_id}/${telegram_id}`;
  const kb = { inline_keyboard: [[{ text: "💳 Jetzt zahlen", url }]] };
  await bot.sendMessage(chatId, "Perfekt! 🎉 Sobald deine Zahlung eingegangen ist, geht es los.", { reply_markup: kb });
}

/* -------------------------------------------------------------------------- */
/* Telegram Bootstrap                                                          */
/* -------------------------------------------------------------------------- */
async function bootstrapTelegram() {
  await setWebhookWithRetry(telegramWebhook, 5);

  // /start – nutzt Deep-Link payload
  bot.onText(/^\/start\b/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const username = msg.from.username || null;

    let creator_id = parseCreatorFromStart(msg.text);

    if (!creator_id && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      const cfg = await sbSelect("creator_config", "creator_id", { group_chat_id: String(chatId) }, true);
      creator_id = cfg?.creator_id || null;
    }

    if (!creator_id) {
      await bot.sendMessage(chatId, "Ich konnte deinen Creator nicht erkennen. Bitte nutze den offiziellen Start-Link.");
      return;
    }

    await sbAdminUpsert(
      "vip_users",
      { creator_id, telegram_id: userId, username, letzter_kontakt: nowTS(), status: "inactive", zahlung_ok: false },
      { onConflict: "creator_id,telegram_id" }
    );

    const creator = await getCreatorCfgById(creator_id);

    if (creator?.voice_enabled && creator?.voice_file_id && msg.chat.type === "private") {
      try {
        await bot.sendVoice(chatId, creator.voice_file_id, {
          caption: creator.voice_caption ? escapeMDV2(creator.voice_caption) : undefined,
          parse_mode: "MarkdownV2"
        });
      } catch (e) {
        console.error("sendVoice /start error:", e.message);
      }
    }

    consentState.set(`${creator_id}:${userId}`, { age: false, rules: false });

    const text = buildWelcomeMessage(creator || {}, msg.from.first_name || "");
    const kb = {
      inline_keyboard: [
        [{ text: "🔞 Ich bin 18+", callback_data: "btn_age" }],
        [{ text: "📜 Regeln anzeigen", callback_data: "btn_rules" }],
        [{ text: "✅ Regeln akzeptieren", callback_data: "btn_accept_rules" }]
      ]
    };
    await bot.sendMessage(chatId, text, { reply_markup: kb, parse_mode: "MarkdownV2" });
  });

  // Callback-Buttons (robust, immer Antwort)
  bot.on("callback_query", async (q) => {
    const data = q.data;
    const chatId = q.message?.chat?.id;
    const userId = String(q.from?.id);

    try {
      const creator_id = await findCreatorIdForUser({ userId, chatId });

      if (!creator_id) {
        await bot.answerCallbackQuery(q.id, { text: "Kein Creator-Kontext gefunden. Bitte /start Link erneut nutzen.", show_alert: true });
        return;
      }

      if (data === "btn_age") {
        await sbAdminUpdate("vip_users", { alter_ok: true, letzter_kontakt: nowTS() }, { creator_id, telegram_id: userId });
        await bot.answerCallbackQuery(q.id, { text: "✅ Alter bestätigt!" });
        // 👉 zusätzlich im Chat bestätigen
        await bot.sendMessage(chatId, "🔞 Alter bestätigt.");
        return;
      }

      if (data === "btn_rules") {
        const creator = await getCreatorCfgById(creator_id);
        const rules = creator?.regeln_text || "Standard-Regeln: Kein Spam, kein Teilen von privaten Inhalten, respektvoll bleiben.";
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(chatId, escapeMDV2(`📜 Regeln:\n\n${rules}`), { parse_mode: "MarkdownV2" });
        return;
      }

      if (data === "btn_accept_rules") {
        await sbAdminUpdate("vip_users", { regeln_ok: true, letzter_kontakt: nowTS() }, { creator_id, telegram_id: userId });
        await bot.answerCallbackQuery(q.id, { text: "✅ Regeln akzeptiert!" });
        // 👉 zusätzlich im Chat bestätigen + Pay-Button senden
        await bot.sendMessage(chatId, "✅ Regeln akzeptiert.");
        await sendPayButton({ chatId, creator_id, telegram_id: userId });
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: "🤔 Unbekannte Aktion." });
    } catch (e) {
      console.error("callback_query error:", e.message);
      try { await bot.answerCallbackQuery(q.id, { text: "⚠️ Fehler. Bitte erneut tippen." }); } catch {}
    }
  });

  // Aktivitäts-Pings
  for (const ev of ["voice", "audio", "video_note"]) {
    bot.on(ev, async (msg) => {
      const uid = msg.from?.id ? String(msg.from.id) : null;
      if (!uid) return;
      try { await sbAdminUpdate("vip_users", { letzter_kontakt: nowTS() }, { telegram_id: uid }); } catch (e) {}
      try {
        const label = ev === "voice" ? "Sprachnachricht" : ev === "audio" ? "Audio" : "Videonote";
        await bot.sendMessage(msg.chat.id, `🎤 ${label} erhalten. Danke!`);
      } catch {}
    });
  }

  // Join-Request (nur gültiger Einmallink → approve, sonst decline)
  bot.on("chat_join_request", async (req) => {
    try {
      const groupId = String(req.chat.id);
      const telegram_id = String(req.from.id);
      const cfg = await sbSelect("creator_config", "creator_id", { group_chat_id: groupId }, true);
      const creator_id = cfg?.creator_id || null;
      if (!creator_id) return;

      const inviteUrl = req?.invite_link?.invite_link || req?.invite_link?.url || null;
      const valid = await findValidInvite({ creator_id, group_chat_id: groupId, telegram_id, invite_url: inviteUrl });

      if (!valid) {
        await bot.declineChatJoinRequest(Number(groupId), Number(telegram_id)).catch(() => {});
        return;
      }

      await sbAdminUpsert(
        "vip_users",
        { creator_id, telegram_id, letzter_kontakt: nowTS(), status: "inactive", zahlung_ok: false },
        { onConflict: "creator_id,telegram_id" }
      );

      await markInviteUsed({ id: valid.id, used_by: telegram_id });
      await bot.approveChatJoinRequest(Number(groupId), Number(telegram_id)).catch(() => {});
      console.log("✅ join_request approved via single-use link:", telegram_id, "->", groupId);
    } catch (e) {
      console.error("chat_join_request error:", e.message);
    }
  });

  // Klassischer Join (nur mit gültigem Einmallink → sonst Kick)
  bot.on("message", async (msg) => {
    if (!msg?.new_chat_members?.length) return;
    const groupId = String(msg.chat.id);
    const cfg = await sbSelect("creator_config", "creator_id", { group_chat_id: groupId }, true);
    const creator_id = cfg?.creator_id || null;
    if (!creator_id) return;

    const inviteUrl = msg?.invite_link?.invite_link || msg?.invite_link?.url || null;

    for (const m of msg.new_chat_members) {
      if (m.is_bot) continue;
      const telegram_id = String(m.id);

      const valid = await findValidInvite({ creator_id, group_chat_id: groupId, telegram_id, invite_url: inviteUrl });
      if (!valid) {
        await kickFromGroup({ group_chat_id: groupId, telegram_id });
        continue;
      }

      await sbAdminUpsert(
        "vip_users",
        { creator_id, telegram_id, letzter_kontakt: nowTS(), status: "inactive", zahlung_ok: false },
        { onConflict: "creator_id,telegram_id" }
      );

      await markInviteUsed({ id: valid.id, used_by: telegram_id });

      const u = await sbSelect("vip_users", "vip_bis, zahlung_ok", { creator_id, telegram_id }, true);
      if (!u || !isActive(u)) {
        await bot.sendMessage(Number(groupId), `Hi ${m.first_name || ""}! Zahlung prüfen – danach schalte ich dich frei.`);
      }
    }
  });
}

bootstrapTelegram().catch(console.error);

/* -------------------------------------------------------------------------- */
/* Hourly Checks                                                              */
/* -------------------------------------------------------------------------- */
async function runVipChecks() {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("vip_users")
      .select("creator_id, telegram_id, vip_bis, zahlung_ok, letzte_erinnerung, warned_at, status");
    if (error) throw error;

    const { data: cfgs, error: cfgErr } = await supabaseAdmin
      .from("creator_config")
      .select("creator_id, group_chat_id");
    if (cfgErr) throw cfgErr;

    const cfgMap = new Map((cfgs || []).map(c => [String(c.creator_id), String(c.group_chat_id || "")]));

    const now = new Date();
    const in5dStart = new Date(now.getTime() + 5 * 864e5);
    const in5dEnd   = new Date(now.getTime() + (5 + 1/24) * 864e5);
    const in1dStart = new Date(now.getTime() + 1 * 864e5);
    const in1dEnd   = new Date(now.getTime() + (1 + 1/24) * 864e5);

    for (const u of rows || []) {
      const creator_id = u.creator_id;
      const telegram_id = u.telegram_id;
      const group_chat_id = cfgMap.get(String(creator_id)) || null;

      if (!u.vip_bis) {
        if (u.zahlung_ok === false || u.status === "inactive") {
          await handleExpiry({ creator_id, telegram_id, group_chat_id });
        }
        continue;
      }

      const until = new Date(u.vip_bis);

      if (until > in5dStart && until <= in5dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in5dStart.toISOString().slice(0, 13);
        if (lastType !== "5d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            group_chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⌛️ Heads-up: Deine VIP-Mitgliedschaft läuft in 5 Tagen ab (${until.toLocaleDateString()}).\n` +
              `Sichere dir nahtlos weitere 30 Tage mit einer Zahlung. 💛`
            )
          });
          await markWarning({ creator_id, telegram_id, type: "5d" });
        }
      }

      if (until > in1dStart && until <= in1dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in1dStart.toISOString().slice(0, 13);
        if (lastType !== "1d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            group_chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⏰ Letzte Erinnerung: Deine VIP-Mitgliedschaft endet in 24 Stunden (${until.toLocaleString()}).\n` +
              `Jetzt zahlen und sofort +30 Tage sichern.`
            )
          });
          await markWarning({ creator_id, telegram_id, type: "1d" });
        }
      }

      if (until <= now && u.zahlung_ok !== true) {
        await handleExpiry({ creator_id, telegram_id, group_chat_id });
      }
    }
  } catch (e) {
    console.error("runVipChecks error:", e.message);
  }
}

app.get("/cron/run", async (_req, res) => {
  await runVipChecks();
  res.json({ ok: true });
});

cron.schedule("0 * * * *", () => {
  console.log("⏱️ runVipChecks()");
  runVipChecks();
});

/* -------------------------------------------------------------------------- */
/* Start Server                                                               */
/* -------------------------------------------------------------------------- */
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  const ok = await setWebhookWithRetry(telegramWebhook, 5);
  console.log("Telegram webhook set:", telegramWebhook, ok ? "✅" : "⚠️ (Retry fehlgeschlagen)");
});
