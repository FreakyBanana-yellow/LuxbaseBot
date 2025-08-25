// index.js
import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf } from 'telegraf';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// ---- ENV ----
const {
  BOT_TOKEN,
  TELEGRAM_GROUP_ID,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  RENDER_EXTERNAL_URL,
  PORT = 3000
} = process.env;

// ---- Tabelle + Spalten ----
const TABLE = 'vip_users';
const COL = {
  id: 'id',
  telegram_id: 'telegram_id',
  telegram_user_id: 'telegram_user_id',
  username: 'username',
  creator_id: 'creator_id',
  alter_ok: 'alter_ok',
  regeln_ok: 'regeln_ok',
  zahlung_ok: 'zahlung_ok',
  vip_bis: 'vip_bis',
  letzter_kontakt: 'letzter_kontakt',
  status: 'status',
  screenshot_url: 'screenshot_url',
  letzte_erinnerung: 'letzte_erinnerung',
  warned_at: 'warned_at',
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
  renewal_mode: 'renewal_mode'
};

// ---- Init ----
const app = express();
const bot = new Telegraf(BOT_TOKEN);

// Supabase (bevorzugt Service Role)
const SB_URL = SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const SB_KEY = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) {
  console.error('❌ Missing Supabase ENV. Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/ANON_KEY.');
  process.exit(1);
}
const supabase = createClient(SB_URL, SB_KEY);

// Stripe
const stripe = new Stripe(STRIPE_SECRET_KEY);

// ===== Stripe Webhook (RAW Body – muss vor JSON Parser kommen!) =====
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
      const { data } = await supabase.from(TABLE).select('*')
        .eq(COL.stripe_customer_id, String(customerId)).maybeSingle();
      if (data) await extendMembership(data[COL.telegram_user_id], 30);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerId = session.customer;
      const telegramIdFromMeta = session?.metadata?.telegram_user_id;

      if (telegramIdFromMeta) {
        await extendMembership(telegramIdFromMeta, 30);
        if (customerId) {
          await supabase.from(TABLE)
            .update({ [COL.stripe_customer_id]: String(customerId) })
            .eq(COL.telegram_user_id, String(telegramIdFromMeta));
        }
      } else if (customerId) {
        const { data } = await supabase.from(TABLE).select('*')
          .eq(COL.stripe_customer_id, String(customerId)).maybeSingle();
        if (data) await extendMembership(data[COL.telegram_user_id], 30);
      }
    }

    // Optional: invoice.payment_failed, customer.subscription.* hier ergänzen

    res.json({ received: true });
  } catch (e) {
    console.error('Stripe handler error', e);
    res.status(500).json({ ok: false });
  }
});

// ===== Ab hier JSON-Parser für alle anderen Routen =====
app.use(bodyParser.json());

// ===== Helpers =====
const nowUtc = () => new Date();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const startOfHour = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0));
const toDate = (x) => (x ? new Date(x) : null);

async function upsertUserContact(uid, uname) {
  try {
    await supabase.from(TABLE).upsert(
      {
        [COL.telegram_user_id]: String(uid),
        [COL.username]: uname || null,
        [COL.letzter_kontakt]: new Date().toISOString()
      },
      { onConflict: COL.telegram_user_id }
    );
  } catch (e) {
    console.error('upsertUserContact error', e);
  }
}

async function fetchByTelegramId(tid) {
  const { data, error } = await supabase.from(TABLE).select('*')
    .eq(COL.telegram_user_id, String(tid)).maybeSingle();
  if (error) throw error;
  return data || null;
}

function isActive(record) {
  const until = toDate(record?.[COL.vip_bis]);
  return !!(until && until.getTime() > nowUtc().getTime());
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

async function markWarning(telegramId, type) {
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
  await supabase.from(TABLE).update(update).eq(COL.telegram_user_id, String(telegramId));
}

async function extendMembership(telegramId, days = 30) {
  const u = await fetchByTelegramId(telegramId);
  const base = (u?.[COL.vip_bis] && toDate(u[COL.vip_bis]) > nowUtc()) ? toDate(u[COL.vip_bis]) : nowUtc();
  const newUntil = addDays(base, days);
  await setMembership(telegramId, { until: newUntil, active: true, paid: true });
  await notifyUserDMorGroup(telegramId, `✅ Danke! Deine VIP‑Mitgliedschaft wurde bis **${newUntil.toLocaleDateString()}** verlängert (+${days} Tage).`, { parse_mode: 'Markdown' });
  return newUntil;
}

async function kickFromGroup(telegramId) {
  if (!TELEGRAM_GROUP_ID) return false;
  try {
    await bot.telegram.banChatMember(TELEGRAM_GROUP_ID, Number(telegramId));
    await bot.telegram.unbanChatMember(TELEGRAM_GROUP_ID, Number(telegramId)); // Rejoin erlauben
    return true;
  } catch (e) {
    console.error('Kick error', e);
    return false;
  }
}

async function handleExpiry(telegramId) {
  const u = await fetchByTelegramId(telegramId);
  if (!u) return;
  if (isActive(u)) return;
  await setMembership(telegramId, { active: false, paid: false });
  const kicked = await kickFromGroup(telegramId);
  await notifyUserDMorGroup(
    telegramId,
    `❌ Deine VIP‑Mitgliedschaft ist abgelaufen und wurde beendet${kicked ? ' (du wurdest aus der VIP‑Gruppe entfernt)' : ''}.\n` +
    `👉 Zahle jederzeit wieder – danach bekommst du automatisch **+30 Tage**.`
  );
}

// ======= Voice/Audio/Video‑Note Support =======
// Helper: Telegram File URL ermitteln
async function getTelegramFileUrl(fileId) {
  const file = await bot.telegram.getFile(fileId);
  const path = file.file_path;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`;
}

// Optional: in Supabase Storage hochladen (Bucket 'voice-messages') – auskommentiert:
// async function uploadToBucket(url, filename) {
//   const res = await fetch(url);
//   const buf = Buffer.from(await res.arrayBuffer());
//   const { data, error } = await supabase.storage.from('voice-messages').upload(filename, buf, {
//     contentType: 'audio/ogg', upsert: true
//   });
//   if (error) throw error;
//   const { data: pub } = supabase.storage.from('voice-messages').getPublicUrl(filename);
//   return pub.publicUrl;
// }

// Voice (Sprachnachricht)
bot.on('voice', async (ctx) => {
  try {
    const uid = ctx.from?.id;
    const v = ctx.message.voice;
    if (!uid || !v) return;
    await upsertUserContact(uid, ctx.from?.username);

    const fileUrl = await getTelegramFileUrl(v.file_id);
    const secs = v.duration;

    // Optional Upload in Bucket:
    // const publicUrl = await uploadToBucket(fileUrl, `voice_${uid}_${Date.now()}.ogg`);

    // In DB als letzter Kontakt notieren (oder eigene Log-Tabelle/Storage nutzen)
    await supabase.from(TABLE).update({ [COL.letzter_kontakt]: new Date().toISOString() })
      .eq(COL.telegram_user_id, String(uid));

    await ctx.reply(`🎤 Sprachnachricht erhalten (${secs}s). Danke!`);
  } catch (e) {
    console.error('voice handler error', e);
    await ctx.reply('Uff, da hat was mit der Sprachnachricht gehakt.');
  }
});

// Audio (gesendete Audiodatei)
bot.on('audio', async (ctx) => {
  try {
    const uid = ctx.from?.id;
    const a = ctx.message.audio;
    if (!uid || !a) return;
    await upsertUserContact(uid, ctx.from?.username);
    const fileUrl = await getTelegramFileUrl(a.file_id);
    await supabase.from(TABLE).update({ [COL.letzter_kontakt]: new Date().toISOString() })
      .eq(COL.telegram_user_id, String(uid));
    await ctx.reply(`🎧 Audio erhalten: ${a.title || 'Datei'} (${Math.round(a.duration)}s).`);
  } catch (e) { console.error('audio handler error', e); }
});

// Video‑Note (runde Videos)
bot.on('video_note', async (ctx) => {
  try {
    const uid = ctx.from?.id;
    const vn = ctx.message.video_note;
    if (!uid || !vn) return;
    await upsertUserContact(uid, ctx.from?.username);
    const fileUrl = await getTelegramFileUrl(vn.file_id);
    await supabase.from(TABLE).update({ [COL.letzter_kontakt]: new Date().toISOString() })
      .eq(COL.telegram_user_id, String(uid));
    await ctx.reply(`🎥 Videonote erhalten (${Math.round(vn.duration)}s).`);
  } catch (e) { console.error('video_note handler error', e); }
});

// ======= Bot Middleware: Updates loggen + letzter_kontakt pflegen =======
bot.use(async (ctx, next) => {
  try {
    const uid = ctx.from?.id;
    const uname = ctx.from?.username;
    if (uid) await upsertUserContact(uid, uname);
    if (ctx.update) console.log('Update:', JSON.stringify(ctx.update)); // Debug
  } catch (e) { console.error('middleware error', e); }
  return next();
});

// ======= Commands & Quick Tests =======
bot.start(async (ctx) => {
  await ctx.reply(
    'Hey! 👋 Ich bin dein VIP‑Bot.\n' +
    '• Ich erinnere dich 5 Tage & 24h vor Ablauf.\n' +
    '• Stripe‑Zahlung verlängert automatisch um +30 Tage.\n' +
    '• Ohne Zahlung muss ich dich aus der VIP‑Gruppe entfernen.\n' +
    '• Du kannst mir Sprachnachrichten schicken – ich speichere sie fürs Protokoll.'
  );
});
bot.help(async (ctx) => {
  await ctx.reply('Befehle:\n/start – Info & Registrierung\n/help – Hilfe\nSchick mir „ping“ für einen Schnelltest.');
});
bot.hears(/^(ping|Ping|PING)$/, (ctx) => ctx.reply('pong'));

// ======= On Join → prüfen =======
bot.on('new_chat_members', async (ctx) => {
  try {
    for (const m of ctx.message.new_chat_members) {
      if (m.is_bot) continue;
      const uid = m.id;
      const user = await fetchByTelegramId(uid);
      if (!user || !isActive(user)) {
        await ctx.reply(`Hi ${m.first_name ?? ''}! Ich finde keine aktive VIP‑Mitgliedschaft.\nBitte schließe die Zahlung ab. Ohne Zahlung erfolgt eine Entfernung.`);
        await handleExpiry(uid);
      } else {
        await ctx.reply(`Willkommen, ${m.first_name ?? ''}! ✅ Aktiv bis ${toDate(user[COL.vip_bis]).toLocaleDateString()}.`);
      }
    }
  } catch (e) { console.error('new_chat_members error', e); }
});

// ======= Hourly Checks: 5d / 24h / Kick =======
async function runHourlyChecks() {
  const now = nowUtc();
  const in5dStart = addDays(now, 5);
  const in5dEnd = addDays(now, 5 + 1/24);
  const in1dStart = addDays(now, 1);
  const in1dEnd = addDays(now, 1 + 1/24);

  const { data, error } = await supabase.from(TABLE).select('*');
  if (error) { console.error('fetch error', error); return; }

  for (const u of data) {
    const tid = u[COL.telegram_user_id];
    if (!tid) continue;
    const until = toDate(u[COL.vip_bis]);

    if (!until) { if (u[COL.zahlung_ok] === false || u[COL.status] === 'inactive') await handleExpiry(tid); continue; }

    if (until > in5dStart && until <= in5dEnd) {
      const lastType = u[COL.letzte_erinnerung]; const lastAt = toDate(u[COL.warned_at]);
      if (lastType !== '5d' || !lastAt || lastAt < startOfHour(in5dStart)) {
        await notifyUserDMorGroup(tid, `⌛️ Heads‑up: Deine VIP‑Mitgliedschaft läuft in **5 Tagen** ab (${until.toLocaleDateString()}).\nSichere dir nahtlos weitere **30 Tage** mit einer Zahlung. 💛`, { parse_mode: 'Markdown' });
        await markWarning(tid, '5d');
      }
    }

    if (until > in1dStart && until <= in1dEnd) {
      const lastType = u[COL.letzte_erinnerung]; const lastAt = toDate(u[COL.warned_at]);
      if (lastType !== '1d' || !lastAt || lastAt < startOfHour(in1dStart)) {
        await notifyUserDMorGroup(tid, `⏰ Letzte Erinnerung: Deine VIP‑Mitgliedschaft endet in **24 Stunden** (${until.toLocaleString()}).\nJetzt zahlen und sofort **+30 Tage** sichern.`, { parse_mode: 'Markdown' });
        await markWarning(tid, '1d');
      }
    }

    if (until <= now) {
      if (!u[COL.zahlung_ok]) await handleExpiry(tid);
    }
  }
}
setInterval(runHourlyChecks, 60 * 60 * 1000);
runHourlyChecks().catch(console.error);

// ======= Telegram Webhook =======
app.post(`/webhook/telegram/${BOT_TOKEN}`, (req, res) => {
  console.log('Webhook update:', JSON.stringify(req.body)); // Debug
  bot.handleUpdate(req.body, res);
});

// ======= Health & Cron =======
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    supabase_url_present: !!SB_URL,
    using_service_role: !!SUPABASE_SERVICE_ROLE_KEY
  });
});
app.get('/cron/run', async (_req, res) => {
  await runHourlyChecks();
  res.json({ ok: true });
});

// ======= Start + Webhook setzen =======
app.listen(PORT, async () => {
  console.log(`Server on :${PORT}`);
  if (RENDER_EXTERNAL_URL) {
    try {
      await bot.telegram.setWebhook(`${RENDER_EXTERNAL_URL}/webhook/telegram/${BOT_TOKEN}`);
      console.log('Telegram webhook set');
    } catch (e) { console.error('Webhook set error', e); }
  }
});
