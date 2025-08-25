// index.js
import express from "express";
import bodyParser from "body-parser";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import cron from "node-cron";

// ──────────────────────────────────────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────────────────────────────────────
const {
  BOT_TOKEN,
  BASE_URL, // z.B. https://dein-service.onrender.com
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PORT = 3000
} = process.env;

if (!BOT_TOKEN || !BASE_URL) {
  console.error("❌ BOT_TOKEN oder BASE_URL fehlt.");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Supabase
// ──────────────────────────────────────────────────────────────────────────────
const SB_URL = SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const SB_KEY =
  SUPABASE_SERVICE_ROLE_KEY ||
  SUPABASE_ANON_KEY ||
  process.env.PUBLIC_SUPABASE_ANON_KEY;

if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE_URL oder SUPABASE_*_KEY fehlt.");
  process.exit(1);
}

const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const nowTS = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDaysISO = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

// Telegram MarkdownV2 escapen (robust)
function escapeMDV2(s = "") {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// In‑Memory Consent‑State (pro Creator x User)
const consentState = new Map();

// Mini‑Wizard‑Map (falls du später Voice-Konfiguration o.ä. brauchst)
const modelWizard = new Map();
function getMW(userId) {
  const k = String(userId);
  if (!modelWizard.has(k)) modelWizard.set(k, {});
  return modelWizard.get(k);
}

// 🔥 Flirty Welcome (MDV2‑escaped)
function buildWelcomeMessage(creator, firstName = "") {
  const price = Number(creator.preis || 0).toFixed(0);
  const days  = Number(creator.vip_days ?? creator.vip_dauer ?? 30);

  const baseRaw =
    (creator.welcome_text && creator.welcome_text.trim().length > 0)
      ? creator.welcome_text.replace(/\$\{?first_name\}?/g, firstName).trim()
      : (
`Herzlich Willkommen im VIP Bereich! hier findest du die exklusiven Inhalte von mir!

Hier bekommst du meinen **privatesten VIP‑Zugang** – nur die heißesten Inhalte, direkt von mir zu dir.`
      ).trim();

  const metaRaw =
    `\n\n💶 ${price} €  •  ⏳ ${days} Tage exklusiv`;

  const confirmRaw =
`\n\nBevor ich dich reinlasse, brauch ich nur dein Go:
1) 🔞 Du bist wirklich 18+
2) 📜 Du akzeptierst meine Regeln

Danach öffne ich dir meine VIP‑Welt… es wird **heiß** 😏`;

  const text = escapeMDV2(baseRaw) + escapeMDV2(metaRaw) + escapeMDV2(confirmRaw);
  return text;
}

// Creator Config laden
async function getCreatorCfgById(creator_id) {
  const { data, error } = await supabase
    .from("creator_config")
    .select("*")
    .eq("creator_id", creator_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Express + Webhook‑Setup */
// ──────────────────────────────────────────────────────────────────────────────
const app = express();
const bot = new TelegramBot(BOT_TOKEN);

// Webhook Pfad
const telegramPath = `/bot${BOT_TOKEN}`;
const telegramWebhook = `${BASE_URL}${telegramPath}`;

// Stripe (RAW Body – wichtig für Signaturprüfung!)
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
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
    // Beispiele: invoice.payment_succeeded & checkout.session.completed
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      // Kunden auf vip_users mappen
      const { data: row } = await supabase
        .from("vip_users")
        .select("creator_id, telegram_id, chat_id")
        .eq("stripe_customer_id", String(customerId))
        .maybeSingle();

      if (row?.creator_id && row?.telegram_id) {
        await extendMembership({ creator_id: row.creator_id, telegram_id: row.telegram_id, days: 30 });
      }
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.customer;
      const telegramIdFromMeta = session?.metadata?.telegram_user_id;
      const creatorIdFromMeta  = session?.metadata?.creator_id;

      if (telegramIdFromMeta && creatorIdFromMeta) {
        await supabase.from("vip_users").upsert({
          creator_id: creatorIdFromMeta,
          telegram_id: String(telegramIdFromMeta),
          stripe_customer_id: customerId ? String(customerId) : null
        }, { onConflict: "creator_id,telegram_id" });

        await extendMembership({
          creator_id: creatorIdFromMeta,
          telegram_id: String(telegramIdFromMeta),
          days: 30
        });
      } else if (customerId) {
        const { data: row } = await supabase
          .from("vip_users")
          .select("creator_id, telegram_id")
          .eq("stripe_customer_id", String(customerId))
          .maybeSingle();

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

// JSON‑Parser für alle anderen Routen (Stripe liegt davor!)
app.use(bodyParser.json());

// Telegram Webhook‑Endpoint (Logs inklusive)
app.post(telegramPath, (req, res) => {
  console.log("Webhook update:", JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health & Cron HTTP
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, base_url: BASE_URL, supabase_url_present: !!SB_URL }));

// ──────────────────────────────────────────────────────────────────────────────
// VIP‑Status & Reminder Helpers (NEU)
// ──────────────────────────────────────────────────────────────────────────────
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
  await supabase.from("vip_users").update({
    letzte_erinnerung: type,
    warned_at: nowTS()
  })
  .eq("creator_id", creator_id)
  .eq("telegram_id", telegram_id);
}

async function setMembership({ creator_id, telegram_id, untilISO, active, paid }) {
  const patch = {};
  if (untilISO) patch.vip_bis = untilISO;
  if (active !== undefined) patch.status = active ? "active" : "inactive";
  if (paid !== undefined) patch.zahlung_ok = !!paid;

  await supabase.from("vip_users").update(patch)
    .eq("creator_id", creator_id)
    .eq("telegram_id", telegram_id);
}

// +30 Tage (ab jetzt oder ab bestehendem vip_bis – späteres Datum gewinnt)
async function extendMembership({ creator_id, telegram_id, days = 30 }) {
  const { data: row } = await supabase
    .from("vip_users")
    .select("vip_bis, chat_id")
    .eq("creator_id", creator_id)
    .eq("telegram_id", telegram_id)
    .maybeSingle();

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
    text: escapeMDV2(`✅ Danke! Deine VIP‑Mitgliedschaft wurde bis ${newUntil.toLocaleDateString()} verlängert (+${days} Tage).`)
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
  const { data: row } = await supabase
    .from("vip_users")
    .select("vip_bis, zahlung_ok, status, chat_id")
    .eq("creator_id", creator_id)
    .eq("telegram_id", telegram_id)
    .maybeSingle();

  if (!row) return;
  if (isActive(row)) return;

  await setMembership({ creator_id, telegram_id, active: false, paid: false });

  const kicked = await kickFromGroup({ group_chat_id, telegram_id });
  await notifyDMorGroup({
    chatId: row?.chat_id,
    userId: telegram_id,
    text: escapeMDV2(
      `❌ Deine VIP‑Mitgliedschaft ist abgelaufen${kicked ? " und du wurdest aus der VIP‑Gruppe entfernt" : ""}.\n` +
      `👉 Nach Zahlung bekommst du automatisch +30 Tage.`
    )
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Telegram – Bootstrap (alter Flow + Buttons + Voice + neue Prüflogik)
// ──────────────────────────────────────────────────────────────────────────────
async function bootstrapTelegram() {
  // Webhook setzen
  await bot.setWebHook(telegramWebhook);

  // /start – Voice + Welcome + Buttons
  bot.onText(/^\/start\b/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || null;

    // Creator über Admins der Gruppe ermitteln oder Mapping (hier Beispiel: via creator_config.telegram_id = Admin)
    const { data: admins } = await bot.getChatAdministrators(chatId).catch(() => ({ data: [] }));
    const adminIds = (admins || []).map(a => String(a?.user?.id)).filter(Boolean);

    // Fallback: Wenn im privaten Chat /start, Creator über Mapping vip_users.findOne(chat_id) oder über eigene Logik
    const { data: matches } = await supabase
      .from("creator_config")
      .select("creator_id, telegram_id")
      .in("telegram_id", adminIds.length ? adminIds : [-1]);

    const creator_id = matches?.[0]?.creator_id || null;

    // User anlegen/aktualisieren
    await supabase.from("vip_users").upsert({
      creator_id,
      telegram_id: String(userId),
      username,
      chat_id: String(chatId),
      letzter_kontakt: nowTS()
    }, { onConflict: "creator_id,telegram_id" });

    // Voice senden (falls im Creator konfiguriert)
    const creator = creator_id ? await getCreatorCfgById(creator_id) : null;

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

    // Consent State resetten
    const key = `${creator_id}:${userId}`;
    consentState.set(key, { age: false, rules: false });

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

  // Callback‑Buttons
  bot.on("callback_query", async (q) => {
    try {
      const data = q.data;
      const chatId = q.message?.chat?.id;
      const userId = q.from?.id;

      // Creator ermitteln (über gespeicherten vip_users Datensatz)
      const { data: me } = await supabase
        .from("vip_users")
        .select("creator_id")
        .eq("telegram_id", String(userId))
        .eq("chat_id", String(chatId))
        .maybeSingle();

      const creator_id = me?.creator_id || null;
      if (!creator_id) {
        await bot.answerCallbackQuery(q.id, { text: "Kein Creator‑Kontext gefunden.", show_alert: true });
        return;
      }

      if (data === "btn_age") {
        await supabase.from("vip_users").update({ alter_ok: true })
          .eq("creator_id", creator_id).eq("telegram_id", String(userId));
        await bot.answerCallbackQuery(q.id, { text: "✅ Alter bestätigt!" });
        return;
      }

      if (data === "btn_rules") {
        const creator = await getCreatorCfgById(creator_id);
        const rules = creator?.regeln_text || "Standard‑Regeln: Kein Spam, kein Teilen von privaten Inhalten, respektvoll bleiben.";
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(chatId, escapeMDV2(`📜 Regeln:\n\n${rules}`), { parse_mode: "MarkdownV2" });
        return;
      }

      if (data === "btn_accept_rules") {
        await supabase.from("vip_users").update({ regeln_ok: true })
          .eq("creator_id", creator_id).eq("telegram_id", String(userId));
        await bot.answerCallbackQuery(q.id, { text: "✅ Regeln akzeptiert!" });
        await bot.sendMessage(chatId, "Perfekt! 🎉 Sobald deine Zahlung eingegangen ist, geht es los.");
        return;
      }
    } catch (e) {
      console.error("callback_query error:", e.message);
    }
  });

  // Sprachnachricht / Audio / Video‑Note Protokollieren
  bot.on("voice", async (msg) => {
    const uid = msg.from?.id;
    if (!uid) return;
    await supabase.from("vip_users").update({ letzter_kontakt: nowTS() })
      .eq("telegram_id", String(uid));
    await bot.sendMessage(msg.chat.id, `🎤 Sprachnachricht erhalten (${msg.voice?.duration ?? 0}s). Danke!`);
  });
  bot.on("audio", async (msg) => {
    const uid = msg.from?.id;
    if (!uid) return;
    await supabase.from("vip_users").update({ letzter_kontakt: nowTS() })
      .eq("telegram_id", String(uid));
    await bot.sendMessage(msg.chat.id, `🎧 Audio erhalten: ${msg.audio?.title || "Datei"} (${Math.round(msg.audio?.duration || 0)}s).`);
  });
  bot.on("video_note", async (msg) => {
    const uid = msg.from?.id;
    if (!uid) return;
    await supabase.from("vip_users").update({ letzter_kontakt: nowTS() })
      .eq("telegram_id", String(uid));
    await bot.sendMessage(msg.chat.id, `🎥 Videonote erhalten (${Math.round(msg.video_note?.duration || 0)}s).`);
  });

  // Sofort‑Enforcement bei Gruppenbeitritt
  bot.on("message", async (msg) => {
    if (!msg?.new_chat_members?.length) return;

    const groupId = msg.chat.id;
    for (const m of msg.new_chat_members) {
      if (m.is_bot) continue;

      // Creator zur Gruppe finden
      const { data: cfg } = await supabase
        .from("creator_config")
        .select("creator_id")
        .eq("group_chat_id", String(groupId))
        .maybeSingle();

      const creator_id = cfg?.creator_id || null;
      if (!creator_id) continue;

      const { data: row } = await supabase
        .from("vip_users")
        .select("vip_bis, zahlung_ok")
        .eq("creator_id", creator_id)
        .eq("telegram_id", String(m.id))
        .maybeSingle();

      if (!row || !isActive(row)) {
        await bot.sendMessage(groupId,
          `Hi ${m.first_name || ""}! Ich finde keine aktive VIP‑Mitgliedschaft.\n` +
          `Bitte schließe die Zahlung ab – sonst muss ich dich entfernen.`
        );
        await handleExpiry({ creator_id, telegram_id: String(m.id), group_chat_id: String(groupId) });
      }
    }
  });
}

bootstrapTelegram().catch(console.error);

// ──────────────────────────────────────────────────────────────────────────────
// Hourly Checks: 5 Tage / 24h Reminder + Kick (NEU)
// ──────────────────────────────────────────────────────────────────────────────
async function runVipChecks() {
  try {
    const { data: rows, error } = await supabase
      .from("vip_users")
      .select(`
        creator_id,
        telegram_id,
        vip_bis,
        zahlung_ok,
        letzte_erinnerung,
        warned_at,
        chat_id,
        creator_config:creator_id ( group_chat_id )
      `);
    if (error) throw error;

    const now = new Date();
    const in5dStart = new Date(now.getTime() + 5 * 864e5);
    const in5dEnd   = new Date(now.getTime() + (5 + 1/24) * 864e5);
    const in1dStart = new Date(now.getTime() + 1 * 864e5);
    const in1dEnd   = new Date(now.getTime() + (1 + 1/24) * 864e5);

    for (const u of rows || []) {
      const { creator_id, telegram_id } = u;
      const group_chat_id = u?.creator_config?.group_chat_id || null;

      // kein vip_bis → wenn unbezahlt/inaktiv, vorsorglich expiry behandeln
      if (!u.vip_bis) {
        if (u.zahlung_ok === false || u.status === "inactive") {
          await handleExpiry({ creator_id, telegram_id, group_chat_id });
        }
        continue;
      }

      const until = new Date(u.vip_bis);

      // 5‑Tage‑Reminder
      if (until > in5dStart && until <= in5dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in5dStart.toISOString().slice(0, 13);

        if (lastType !== "5d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            chatId: u.chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⌛️ Heads‑up: Deine VIP‑Mitgliedschaft läuft in 5 Tagen ab (${until.toLocaleDateString()}).\n` +
              `Sichere dir nahtlos weitere 30 Tage mit einer Zahlung. 💛`
            )
          });
          await markWarning({ creator_id, telegram_id, type: "5d" });
        }
      }

      // 24h‑Reminder
      if (until > in1dStart && until <= in1dEnd) {
        const lastType = u.letzte_erinnerung;
        const lastAt = u.warned_at ? new Date(u.warned_at) : null;
        const windowKey = in1dStart.toISOString().slice(0, 13);

        if (lastType !== "1d" || !lastAt || lastAt.toISOString().slice(0, 13) !== windowKey) {
          await notifyDMorGroup({
            chatId: u.chat_id,
            userId: telegram_id,
            text: escapeMDV2(
              `⏰ Letzte Erinnerung: Deine VIP‑Mitgliedschaft endet in 24 Stunden (${until.toLocaleString()}).\n` +
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

// HTTP‑Endpoint zum manuellen Auslösen
app.get("/cron/run", async (_req, res) => {
  await runVipChecks();
  res.json({ ok: true });
});

// Stündlicher Cron
cron.schedule("0 * * * *", () => {
  console.log("⏱️ runVipChecks()");
  runVipChecks();
});

// ──────────────────────────────────────────────────────────────────────────────
// Start Server
// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  try {
    await bot.setWebHook(telegramWebhook);
    console.log("Telegram webhook set:", telegramWebhook);
  } catch (e) {
    console.error("Webhook set error", e);
  }
});
