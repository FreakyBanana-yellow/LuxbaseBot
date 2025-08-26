// index.js
import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import cron from "node-cron";

/* ────────────────────────────────────────────────────────────────────────────
   ENV
   ──────────────────────────────────────────────────────────────────────────── */
const {
  BOT_TOKEN,
  BASE_URL, // z.B. https://dein-service.onrender.com
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PORT = 3000
} = process.env;

if (!BOT_TOKEN || !BASE_URL) {
  console.error("❌ BOT_TOKEN oder BASE_URL fehlt.");
  process.exit(1);
}

const SB_URL = SUPABASE_URL;
if (!SB_URL) {
  console.error("❌ SUPABASE_URL fehlt.");
  process.exit(1);
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY fehlt – Server kann nicht in die DB schreiben (RLS)!");
  process.exit(1);
}

console.log("ENV CHECK:", {
  has_SUPABASE_URL: !!SB_URL,
  has_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE_KEY,
  has_BOT_TOKEN: !!BOT_TOKEN,
  has_BASE_URL: !!BASE_URL
});

/* ────────────────────────────────────────────────────────────────────────────
   Supabase: Nur Admin-Client (Service Role)
   ──────────────────────────────────────────────────────────────────────────── */
const supabaseAdmin = createClient(SB_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/* ────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */
const nowTS = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

// Telegram MarkdownV2 escapen
function escapeMDV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// In-Memory Consent-State (optional)
const consentState = new Map();
const modelWizard = new Map();
function getMW(userId) {
  const k = String(userId);
  if (!modelWizard.has(k)) modelWizard.set(k, {});
  return modelWizard.get(k);
}

// Deep-Link Payload: /start cid_<uuid>
function parseCreatorFromStart(text = "") {
  const m = text.match(/^\/start\s+([^\s]+)$/i);
  if (!m) return null;
  const payload = m[1];
  const mCid = payload.match(/^cid_(.+)$/i);
  return mCid ? mCid[1] : null;
}

// Flirty Welcome
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

  const metaRaw = `\n\n💶 ${price} €  •  ⏳ ${days} Tage exklusiv`;
  const confirmRaw =
`\n\nBevor ich dich reinlasse, brauch ich nur dein Go:
1) 🔞 Du bist wirklich 18+
2) 📜 Du akzeptierst meine Regeln

Danach öffne ich dir meine VIP-Welt… es wird **heiß** 😏`;

  return escapeMDV2(baseRaw + metaRaw + confirmRaw);
}

// DB Helpers (Admin, mit Error-Logs)
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

/* ────────────────────────────────────────────────────────────────────────────
   Invite-Checks: Nur Einmallink-Beitritte erlauben
   ──────────────────────────────────────────────────────────────────────────── */
async function findValidInvite({ creator_id, group_chat_id, telegram_id, invite_url }) {
  // 1) exakte URL prüfen
  let row = null;
  if (invite_url) {
    row = await sbSelect(
      "invite_links",
      "*",
      {
        creator_id: String(creator_id),
        group_chat_id: String(group_chat_id),
        invite_link: String(invite_url),
        used: false
      },
      true
    ).catch(() => null);
  }
  // 2) Fallback: usergebundener Link
  if (!row) {
    row = await sbSelect(
      "invite_links",
      "*",
      {
        creator_id: String(creator_id),
        group_chat_id: String(group_chat_id),
        telegram_id: String(telegram_id),
        used: false
      },
      true
    ).catch(() => null);
  }
  if (!row) return null;

  if (row.telegram_id && String(row.telegram_id) !== String(telegram_id)) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  return row;
}

async function markInviteUsed({ id, used_by }) {
  await sbAdminUpdate(
    "invite_links",
    { used: true, used_at: nowTS(), used_by: String(used_by) },
    { id }
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Express + Webhook Setup
   ──────────────────────────────────────────────────────────────────────────── */
const app = express();
const bot = new TelegramBot(BOT_TOKEN);

// Telegram Webhook
const telegramPath = `/bot${BOT_TOKEN}`;
const telegramWebhook = `${BASE_URL}${telegramPath}`;

// Stripe
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Stripe RAW body (Signaturprüfung), vor json()
app.post("/stripe/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);

  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer ? String(invoice.customer) : null;

      if (customerId) {
        const row = await sbSelect("vip_users", "creator_id, telegram_id, chat_id", { stripe_customer_id: customerId }, true);
        if (row?.creator_id && row?.telegram_id) {
          await extendMembership({ creator_id: row.creator_id, telegram_id: row.telegram_id, days: 30 });
        }
      }
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer ? String(session.customer) : null;
      const telegramIdFromMeta = session?.metadata?.telegram_user_id ? String(session.metadata.telegram_user_id) : null;
      const creatorIdFromMeta  = session?.metadata?.creator_id || null;

      if (telegramIdFromMeta && creatorIdFromMeta) {
        await sbAdminUpsert("vip_users", {
          creator_id: creatorIdFromMeta,
          telegram_id: telegramIdFromMeta,
          stripe_customer_id: customerId
        }, { onConflict: "creator_id,telegram_id" });

        await extendMembership({
          creator_id: creatorIdFromMeta,
          telegram_id: telegramIdFromMeta,
          days: 30
        });
      } else if (customerId) {
        const row = await sbSelect("vip_users", "creator_id, telegram_id", { stripe_customer_id: customerId }, true);
        if (row?.creator_id && row?.telegram_id) {
          await extendMembership({ creator_id: row.creator_id, telegram_id: row.telegram_id, days: 30 });
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error("Stripe handler error", e);
    res.status(500).json({ ok: false });
  }
});

// JSON-Parser für alle anderen Routen (Stripe liegt davor!)
app.use(bodyParser.json());

// Telegram Webhook Endpoint (Logs)
app.post(telegramPath, (req, res) => {
  console.log("Webhook update:", JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, base_url: BASE_URL, supabase_url_present: !!SB_URL }));

/* ────────────────────────────────────────────────────────────────────────────
   VIP-Status & Reminder Helpers
   ──────────────────────────────────────────────────────────────────────────── */
const isActive = (row) => {
  if (!row?.vip_bis) return false;
  const until = new Date(row.vip_bis);
  return until.getTime() > Date.now();
};

async function notifyDMorGroup({ chatId, userId, text, parse_mode = "MarkdownV2" }) {
  try {
    await bot.sendMessage(Number(userId), text, { parse_mode });
    return;
  } catch {
    if (chatId) {
      await bot.sendMessage(
        Number(chatId),
        `🔔 <a href="tg://user?id=${userId}">Hinweis</a>:\n${text}`,
        { parse_mode: "HTML" }
      );
    }
  }
}

async function markWarning({ creator_id, telegram_id, type }) {
  await sbAdminUpdate("vip_users", {
    letzte_erinnerung: type,
    warned_at: nowTS()
  }, { creator_id, telegram_id });
}

async function setMembership({ creator_id, telegram_id, untilISO, active, paid }) {
  const patch = {};
  if (untilISO) patch.vip_bis = untilISO;
  if (active !== undefined) patch.status = active ? "active" : "inactive";
  if (paid !== undefined) patch.zahlung_ok = !!paid;

  await sbAdminUpdate("vip_users", patch, { creator_id, telegram_id });
}

// +X Tage (ab jetzt oder ab bestehendem vip_bis – späteres Datum gewinnt)
async function extendMembership({ creator_id, telegram_id, days = 30 }) {
  const row = await sbSelect("vip_users", "vip_bis, chat_id", { creator_id, telegram_id }, true);

  const base = row?.vip_bis && new Date(row.vip_bis) > new Date()
    ? new Date(row.vip_bis)
    : new Date();

  const newUntil = new Date(base.getTime() + days * 864e5);
  await setMembership({
    creator_id, telegram_id,
    untilISO: newUntil.toISOString(),
    active: true, paid: true
  });

  await notifyDMorGroup({
    chatId: row?.chat_id,
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
  const row = await sbSelect("vip_users", "vip_bis, zahlung_ok, status, chat_id", { creator_id, telegram_id }, true);
  if (!row) return;
  if (isActive(row)) return;

  await setMembership({ creator_id, telegram_id, active: false, paid: false });

  const kicked = await kickFromGroup({ group_chat_id, telegram_id });
  await notifyDMorGroup({
    chatId: row?.chat_id,
    userId: telegram_id,
    text: escapeMDV2(
      `❌ Deine VIP-Mitgliedschaft ist abgelaufen${kicked ? " und du wurdest aus der VIP-Gruppe entfernt" : ""}.\n` +
      `👉 Nach Zahlung bekommst du automatisch +30 Tage.`
    )
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   Telegram – Bootstrap
   ──────────────────────────────────────────────────────────────────────────── */
async function bootstrapTelegram() {
  await bot.setWebHook(telegramWebhook);

  // /start – nutzt Deep-Link payload: /start cid_<creator_uuid>
  bot.onText(/^\/start\b/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from.id);
    const username = msg.from.username || null;

    // 1) versuche Payload
    let creator_id = parseCreatorFromStart(msg.text);

    // 2) Gruppen-Fallback über group_chat_id → creator_config
    if (!creator_id && (msg.chat.type === "group" || msg.chat.type === "supergroup")) {
      const cfg = await sbSelect("creator_config", "creator_id", { group_chat_id: String(chatId) }, true);
      creator_id = cfg?.creator_id || null;
    }

    // 3) Ohne Creator kein Upsert → bitte offiziellen Link nutzen
    if (!creator_id) {
      await bot.sendMessage(chatId, "Ich konnte deinen Creator nicht erkennen. Bitte nutze den offiziellen Start-Link.");
      return;
    }

    await sbAdminUpsert("vip_users", {
      creator_id,
      telegram_id: userId,
      username,
      chat_id: String(chatId),
      letzter_kontakt: nowTS(),
      status: "inactive",
      zahlung_ok: false
    }, { onConflict: "creator_id,telegram_id" });

    const creator = await getCreatorCfgById(creator_id);

    // Optional: Voice
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

    // Consent State reset
    consentState.set(`${creator_id}:${userId}`, { age: false, rules: false });

    // Welcome + Buttons
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

  // Callback-Buttons
  bot.on("callback_query", async (q) => {
    try {
      const data = q.data;
      const chatId = q.message?.chat?.id;
      const userId = String(q.from?.id);

      const me = await sbSelect("vip_users", "creator_id", {
        telegram_id: userId,
        chat_id: String(chatId)
      }, true);

      const creator_id = me?.creator_id || null;
      if (!creator_id) {
        await bot.answerCallbackQuery(q.id, { text: "Kein Creator-Kontext gefunden.", show_alert: true });
        return;
      }

      if (data === "btn_age") {
        await sbAdminUpdate("vip_users", { alter_ok: true }, { creator_id, telegram_id: userId });
        await bot.answerCallbackQuery(q.id, { text: "✅ Alter bestätigt!" });
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
        await sbAdminUpdate("vip_users", { regeln_ok: true }, { creator_id, telegram_id: userId });
        await bot.answerCallbackQuery(q.id, { text: "✅ Regeln akzeptiert!" });
        await bot.sendMessage(chatId, "Perfekt! 🎉 Sobald deine Zahlung eingegangen ist, geht es los.");
        return;
      }
    } catch (e) {
      console.error("callback_query error:", e.message);
    }
  });

  // Aktivitäts-Updates bei Voice/Audio/Video-Note
  for (const ev of ["voice", "audio", "video_note"]) {
    bot.on(ev, async (msg) => {
      const uid = msg.from?.id ? String(msg.from.id) : null;
      if (!uid) return;
      try {
        await sbAdminUpdate("vip_users", { letzter_kontakt: nowTS() }, { telegram_id: uid });
      } catch (e) {
        console.error(`${ev} update error:`, e.message);
      }
      try {
        const label = ev === "voice" ? "Sprachnachricht"
                   : ev === "audio" ? "Audio"
                   : "Videonote";
        await bot.sendMessage(msg.chat.id, `🎤 ${label} erhalten. Danke!`);
      } catch {}
    });
  }

  // 🔒 NEU: Beitrittsanfragen (Gruppen mit „Join Request“) → nur mit gültigem Einmallink
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

      await sbAdminUpsert("vip_users", {
        creator_id,
        telegram_id,
        chat_id: groupId,
        letzter_kontakt: nowTS(),
        status: "inactive",
        zahlung_ok: false
      }, { onConflict: "creator_id,telegram_id" });

      await markInviteUsed({ id: valid.id, used_by: telegram_id });
      await bot.approveChatJoinRequest(Number(groupId), Number(telegram_id)).catch(() => {});
      console.log("✅ join_request approved via single-use link:", telegram_id, "->", groupId);
    } catch (e) {
      console.error("chat_join_request error:", e.message);
    }
  });

  // 🔒 Direkter Join (klassisch) → nur mit gültigem Einmallink, sonst Kick
  bot.on("message", async (msg) => {
    if (!msg?.new_chat_members?.length) return;

    const groupId = String(msg.chat.id);
    const cfg = await sbSelect("creator_config", "creator_id", { group_chat_id: groupId }, true);
    const creator_id = cfg?.creator_id || null;
    if (!creator_id) return;

    // Telegram liefert bei Join via Link u.U. message.invite_link (ChatInviteLink)
    const inviteUrl = msg?.invite_link?.invite_link || msg?.invite_link?.url || null;

    for (const m of msg.new_chat_members) {
      if (m.is_bot) continue;
      const telegram_id = String(m.id);

      const valid = await findValidInvite({ creator_id, group_chat_id: groupId, telegram_id, invite_url: inviteUrl });

      if (!valid) {
        await kickFromGroup({ group_chat_id: groupId, telegram_id });
        continue;
      }

      await sbAdminUpsert("vip_users", {
        creator_id,
        telegram_id,
        chat_id: groupId,
        letzter_kontakt: nowTS(),
        status: "inactive",
        zahlung_ok: false
      }, { onConflict: "creator_id,telegram_id" });

      await markInviteUsed({ id: valid.id, used_by: telegram_id });

      const u = await sbSelect("vip_users", "vip_bis, zahlung_ok", { creator_id, telegram_id }, true);
      if (!u || !isActive(u)) {
        await bot.sendMessage(Number(groupId),
          `Hi ${m.first_name || ""}! Zahlung prüfen – danach schalte ich dich frei.`
        );
      }
    }
  });
}

bootstrapTelegram().catch(console.error);

/* ────────────────────────────────────────────────────────────────────────────
   Hourly Checks: 5 Tage / 24h Reminder + Kick
   ──────────────────────────────────────────────────────────────────────────── */
async function runVipChecks() {
  try {
    // 1) Alle vip_users holen (ohne Join → keine Typkonflikte)
    const { data: rows, error } = await supabaseAdmin
      .from("vip_users")
      .select("creator_id, telegram_id, vip_bis, zahlung_ok, letzte_erinnerung, warned_at, chat_id, status");
    if (error) throw error;

    // 2) creator_config separat holen und in Map legen
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

      // 5-Tage-Reminder
      if (until > in5dStart && until <= in5dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in5dStart.toISOString().slice(0, 13);
        if (lastType !== "5d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            chatId: u.chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⌛️ Heads-up: Deine VIP-Mitgliedschaft läuft in 5 Tagen ab (${until.toLocaleDateString()}).\n` +
              `Sichere dir nahtlos weitere 30 Tage mit einer Zahlung. 💛`
            )
          });
          await markWarning({ creator_id, telegram_id, type: "5d" });
        }
      }

      // 24h-Reminder
      if (until > in1dStart && until <= in1dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in1dStart.toISOString().slice(0, 13);
        if (lastType !== "1d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            chatId: u.chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⏰ Letzte Erinnerung: Deine VIP-Mitgliedschaft endet in 24 Stunden (${until.toLocaleString()}).\n` +
              `Jetzt zahlen und sofort +30 Tage sichern.`
            )
          });
          await markWarning({ creator_id, telegram_id, type: "1d" });
        }
      }

      // Abgelaufen → Kick
      if (until <= now && u.zahlung_ok !== true) {
        await handleExpiry({ creator_id, telegram_id, group_chat_id });
      }
    }
  } catch (e) {
    console.error("runVipChecks error:", e.message);
  }
}

// HTTP-Endpoint zum manuellen Auslösen
app.get("/cron/run", async (_req, res) => {
  await runVipChecks();
  res.json({ ok: true });
});

// Stündlicher Cron
cron.schedule("0 * * * *", () => {
  console.log("⏱️ runVipChecks()");
  runVipChecks();
});

/* ────────────────────────────────────────────────────────────────────────────
   Start Server
   ──────────────────────────────────────────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  try {
    await bot.setWebHook(telegramWebhook);
    console.log("Telegram webhook set:", telegramWebhook);
  } catch (e) {
    console.error("Webhook set error", e);
  }
});
