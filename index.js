// index.js
import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// ---- ENV ----
const {
  BOT_TOKEN,
  TELEGRAM_GROUP_ID,               // z.B. -1001234567890
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,           // Stripe → Webhook endpoint secret
  RENDER_EXTERNAL_URL,
  PORT = 3000
} = process.env;

// ---- Tabelle + Spalten (EXAKT wie bei dir) ----
const TABLE = 'vip_users';
const COL = {
  id: 'id',
  telegram_id: 'telegram_id',                // (bei dir vorhanden, aber wir nutzen unten 'telegram_user_id' für Kick/DM)
  telegram_user_id: 'telegram_user_id',      // <- die echte Telegram-ID (TEXT/NUM)
  username: 'username',
  creator_id: 'creator_id',

  alter_ok: 'alter_ok',
  regeln_ok: 'regeln_ok',
  zahlung_ok: 'zahlung_ok',                  // BOOL – "zahlt aktiv/ok"

  vip_bis: 'vip_bis',                        // TIMESTAMP (UTC) – Ende der Mitgliedschaft
  letzter_kontakt: 'letzter_kontakt',
  status: 'status',                          // 'active' | 'inactive' | 'unpaid' etc.

  screenshot_url: 'screenshot_url',
  letzte_erinnerung: 'letzte_erinnerung',    // TEXT – '5d' | '1d' (welche Warnung zuletzt)
  warned_at: 'warned_at',                    // TIMESTAMP – wann zuletzt gewarnt

  alter_verifiziert: 'alter_verifiziert',
  selfie_url: 'selfie_url',

  avs_verified: 'avs_verified',
  avs_verified_at: 'avs_verified_at',
  avs_provider: 'avs_provider',
  avs_reference_id: 'avs_reference_id',
  avs_fee_charged: 'avs_fee_charged',

  stripe_customer_id: 'stripe_customer_id',
  stripe_subscription_id: 'stripe_subscription_id',
  stripe_checkout_session_id: 'stripe_checkout_session_id',

  renewal_mode: 'renewal_mode'               // optional: 'auto' | 'manual'
};

// ---- Init ----
const app = express();
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

// Telegraf/Express
app.use(bodyParser.json());

// ---- Helpers ----
const nowUtc = () => new Date();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const startOfHour = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0));

function toDate(x) { return x ? new Date(x) : null; }

async function fetchByTelegramId(tid) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq(COL.telegram_user_id, String(tid))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function isActive(record) {
  const until = toDate(record?.[COL.vip_bis]);
  if (!until) return false;
  return until.getTime() > nowUtc().getTime();
}

async function notifyUserDMorGroup(telegramId, text, extra = {}) {
  try {
    await bot.telegram.sendMessage(Number(telegramId), text, extra);
    return;
  } catch {
    if (TELEGRAM_GROUP_ID) {
      await bot.telegram.sendMessage(
        TELEGRAM_GROUP_ID,
        `🔔 <a href="tg://user?id=${telegramId}">Hinweis</a>:\n${text}`,
        { parse_mode: 'HTML', ...extra }
      );
    }
  }
}

async function markWarning(telegramId, type /* '5d' | '1d' */) {
  await supabase.from(TABLE).update({
    [COL.letzte_erinnerung]: type,
    [COL.warned_at]: nowUtc().toISOString()
  }).eq(COL.telegram_user_id, String(telegramId));
}

async function setMembership(telegramId, { until, active, paid }) {
  const update = {};
  if (until) update[COL.vip_bis] = new Date(until).toISOString();
  if (active !== undefined) update[COL.status] = active ? 'active' : 'inactive';
  if (paid !== undefined) update[COL.zahlung_ok] = !!paid;

  await supabase.from(TABLE)
    .update(update)
    .eq(COL.telegram_user_id, String(telegramId));
}

async function extendMembership(telegramId, days = 30) {
  const u = await fetchByTelegramId(telegramId);
  const base = (u?.[COL.vip_bis] && toDate(u[COL.vip_bis]) > nowUtc())
    ? toDate(u[COL.vip_bis])
    : nowUtc();
  const newUntil = addDays(base, days);
  await setMembership(telegramId, { until: newUntil, active: true, paid: true });
  await notifyUserDMorGroup(
    telegramId,
    `✅ Danke! Deine VIP‑Mitgliedschaft wurde bis **${newUntil.toLocaleDateString()}** verlängert (+${days} Tage).`,
    { parse_mode: 'Markdown' }
  );
  return newUntil;
}

async function kickFromGroup(telegramId) {
  if (!TELEGRAM_GROUP_ID) return false;
  try {
    await bot.telegram.banChatMember(TELEGRAM_GROUP_ID, Number(telegramId));
    await bot.telegram.unbanChatMember(TELEGRAM_GROUP_ID, Number(telegramId)); // Rejoin später erlaubt
    return true;
  } catch (e) {
    console.error('Kick error', e);
    return false;
  }
}

async function handleExpiry(telegramId) {
  const u = await fetchByTelegramId(telegramId);
  if (!u) return;

  // wenn schon aktiv → nichts tun
  if (isActive(u)) return;

  // als inaktiv markieren & kicken
  await setMembership(telegramId, { active: false, paid: false });
  const kicked = await kickFromGroup(telegramId);

  await notifyUserDMorGroup(
    telegramId,
    `❌ Deine VIP‑Mitgliedschaft ist abgelaufen und wurde beendet${kicked ? ' (du wurdest aus der VIP‑Gruppe entfernt)' : ''}.\n` +
    `👉 Zahle jederzeit wieder – danach bekommst du automatisch **+30 Tage**.`,
  );
}

// ---- Telegram: On Join → sofort prüfen
bot.on('new_chat_members', async (ctx) => {
  try {
    for (const m of ctx.message.new_chat_members) {
      if (m.is_bot) continue;
      const uid = m.id;
      const user = await fetchByTelegramId(uid);

      if (!user || !isActive(user)) {
        await ctx.reply(
          `Hi ${m.first_name ?? ''}! Ich finde keine aktive VIP‑Mitgliedschaft.\n` +
          `Bitte schließe die Zahlung ab. Ohne Zahlung erfolgt eine Entfernung.`
        );
        await handleExpiry(uid);
      } else {
        await ctx.reply(`Willkommen, ${m.first_name ?? ''}! ✅ Deine VIP‑Mitgliedschaft ist aktiv (bis ${toDate(user[COL.vip_bis]).toLocaleDateString()}).`);
      }
    }
  } catch (e) { console.error('new_chat_members error', e); }
});

// ---- Hourly Checks: 5‑Tage‑ und 24h‑Reminder + Kick
async function runHourlyChecks() {
  const now = nowUtc();
  const in5dStart = addDays(now, 5);
  const in5dEnd = addDays(now, 5 + 1/24); // ±1h Fenster
  const in1dStart = addDays(now, 1);
  const in1dEnd = addDays(now, 1 + 1/24);

  const { data, error } = await supabase.from(TABLE).select('*');
  if (error) { console.error('fetch error', error); return; }

  for (const u of data) {
    const tid = u[COL.telegram_user_id];
    if (!tid) continue;
    const until = toDate(u[COL.vip_bis]);

    // Nutzer ohne vip_bis → wenn zahlung_ok false → Kick (failsafe)
    if (!until) {
      if (u[COL.zahlung_ok] === false || u[COL.status] === 'inactive') {
        await handleExpiry(tid);
      }
      continue;
    }

    // 5‑Tage‑Warnung
    if (until > in5dStart && until <= in5dEnd) {
      const lastType = u[COL.letzte_erinnerung];
      const lastAt = toDate(u[COL.warned_at]);
      // Warnung pro "Fenster" nur einmal
      if (lastType !== '5d' || !lastAt || lastAt < startOfHour(in5dStart)) {
        await notifyUserDMorGroup(
          tid,
          `⌛️ Heads‑up: Deine VIP‑Mitgliedschaft läuft in **5 Tagen** ab (${until.toLocaleDateString()}).\n` +
          `Sichere dir nahtlos weitere **30 Tage** mit einer Zahlung. 💛`,
          { parse_mode: 'Markdown' }
        );
        await markWarning(tid, '5d');
      }
    }

    // 24h‑Warnung
    if (until > in1dStart && until <= in1dEnd) {
      const lastType = u[COL.letzte_erinnerung];
      const lastAt = toDate(u[COL.warned_at]);
      if (lastType !== '1d' || !lastAt || lastAt < startOfHour(in1dStart)) {
        await notifyUserDMorGroup(
          tid,
          `⏰ Letzte Erinnerung: Deine VIP‑Mitgliedschaft endet in **24 Stunden** (${until.toLocaleString()}).\n` +
          `Jetzt zahlen und sofort **+30 Tage** sichern.`,
          { parse_mode: 'Markdown' }
        );
        await markWarning(tid, '1d');
      }
    }

    // Abgelaufen → Kick
    if (until <= now) {
      if (!u[COL.zahlung_ok]) {
        await handleExpiry(tid);
      }
    }
  }
}

// stündlich
setInterval(runHourlyChecks, 60 * 60 * 1000);
runHourlyChecks().catch(console.error);

// ---- Stripe Webhook: Zahlung → +30 Tage
app.post('/webhook/stripe', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      // primär: per stripe_customer_id matchen
      const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .eq(COL.stripe_customer_id, String(customerId))
        .maybeSingle();
      if (!error && data) {
        await extendMembership(data[COL.telegram_user_id], 30);
      }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      const telegramIdFromMeta = session?.metadata?.telegram_user_id;

      if (telegramIdFromMeta) {
        await extendMembership(telegramIdFromMeta, 30);
        // optional: stripe_customer_id speichern
        if (customerId) {
          await supabase.from(TABLE)
            .update({ [COL.stripe_customer_id]: String(customerId) })
            .eq(COL.telegram_user_id, String(telegramIdFromMeta));
        }
      } else if (customerId) {
        const { data, error } = await supabase
          .from(TABLE)
          .select('*')
          .eq(COL.stripe_customer_id, String(customerId))
          .maybeSingle();
        if (!error && data) {
          await extendMembership(data[COL.telegram_user_id], 30);
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Stripe handler error', e);
    res.status(500).json({ ok: false });
  }
});

// ---- Telegram Webhook ----
app.post(`/webhook/telegram/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// Health + optional Cron Endpoint (für Render Cron Jobs)
app.get('/', (_, res) => res.send('OK'));
app.get('/cron/run', async (_, res) => {
  await runHourlyChecks();
  res.json({ ok: true });
});

// Start + Webhook setzen
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  if (RENDER_EXTERNAL_URL) {
    try {
      await bot.telegram.setWebhook(`${RENDER_EXTERNAL_URL}/webhook/telegram/${BOT_TOKEN}`);
      console.log('Telegram webhook set');
    } catch (e) { console.error('Webhook set error', e); }
  }
});
