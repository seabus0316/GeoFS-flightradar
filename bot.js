// bot.js — GeoFS Radar Discord Bot
// 指令：/flights /stats /whois /link /reminder
// 跟 server.js 共用同一個 MongoDB
require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActivityType } = require('discord.js');
const mongoose = require('mongoose');

// ============ 環境變數 ============
const BOT_TOKEN          = process.env.DISCORD_BOT_TOKEN    || '';
const CLIENT_ID          = process.env.DISCORD_CLIENT_ID    || '';
const MONGODB_URI        = process.env.MONGODB_URI          || 'mongodb://localhost:27017/geofs_flightradar';
const RADAR_URL          = process.env.RADAR_URL            || 'https://geofs-flightradar.duckdns.org';
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID || ''; // 固定提醒頻道

if (!BOT_TOKEN)  { console.error('❌ DISCORD_BOT_TOKEN not set'); process.exit(1); }
if (!CLIENT_ID)  { console.error('❌ DISCORD_CLIENT_ID not set');  process.exit(1); }
if (!REMINDER_CHANNEL_ID) console.warn('⚠️  REMINDER_CHANNEL_ID not set — reminders will be sent as DM fallback');

// ============ MongoDB Schemas（與 server.js 共用同一個 DB）============
mongoose.connect(MONGODB_URI).then(() => console.log('✅ Bot: MongoDB connected'));

const User = mongoose.model('User', new mongoose.Schema({
  discordId:       String,
  username:        String,
  displayName:     String,
  photos:          [String],
  geofsUserId:     String,
  isSuperAdmin:    Boolean,
  managedAirlines: [String],
}, { versionKey: false, strict: false }));

// ── 用戶是否開啟倒數第二航點提醒
const ReminderPreference = mongoose.model('ReminderPreference', new mongoose.Schema({
  discordId: { type: String, unique: true, index: true },
  enabled:   { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false }));

// ── 待發送通知（由 server.js 寫入，bot 輪詢發送）
const PendingNotification = mongoose.model('PendingNotification', new mongoose.Schema({
  discordId:           String,
  callsign:            String,
  arrival:             String,
  penultimateWaypoint: String,
  sent:                { type: Boolean, default: false, index: true },
  createdAt:           { type: Date, default: Date.now },
}, { versionKey: false }));

const FlightSession = mongoose.model('FlightSession', new mongoose.Schema({
  aircraftId:  String,
  discordId:   String,
  geofsUserId: String,
  callsign:    String,
  type:        String,
  departure:   String,
  arrival:     String,
  startTime:   Number,
  endTime:     Number,
  duration:    Number,
  maxAlt:      Number,
  maxSpeed:    Number,
  distanceNm:  Number,
  status:      String,
}, { versionKey: false, strict: false }));

// ============ 工具函數 ============
function fmtDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtDate(ts) {
  if (!ts) return '—';
  return `<t:${Math.floor(ts / 1000)}:f>`;
}
function fmtDateShort(ts) {
  if (!ts) return '—';
  return `<t:${Math.floor(ts / 1000)}:d>`;
}

// ============ 定義 Slash Commands ============
const commands = [
  new SlashCommandBuilder()
    .setName('flights')
    .setDescription('Search your flight record')
    .addIntegerOption(o => o.setName('page').setDescription('page (1 for default)').setMinValue(1))
    .addUserOption(o => o.setName('user').setDescription("view other user's status (optional)")),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('See your flight status')
    .addUserOption(o => o.setName('user').setDescription("view other user's status (optional)")),

  new SlashCommandBuilder()
    .setName('whois')
    .setDescription("Search a callsign and see who's flying it")
    .addStringOption(o => o.setName('callsign').setDescription('Callsign, such as EVA001').setRequired(true)),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your GeoFS User ID')
    .addStringOption(o => o.setName('geofs_id').setDescription('Your geofs user ID (numbers)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Manage penultimate waypoint arrival reminder')
    .addSubcommand(sub => sub
      .setName('enable')
      .setDescription('Enable reminder(ping you before landing)'))
    .addSubcommand(sub => sub
      .setName('disable')
      .setDescription('Disable reminder'))
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('View the reminder status(enables/disabled)')),

].map(c => c.toJSON());

// ============ 註冊 Commands ============
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('📡 Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

// ============ Bot Client ============
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const activities = [
  { name: 'GeoFS-Flightradar', type: ActivityType.Watching },
  { name: 'all flights', type: ActivityType.Watching },
  { name: '/stats', type: ActivityType.Listening },
  { name: 'GeoFS pilots', type: ActivityType.Watching },
  { name: 'radar updates', type: ActivityType.Listening },
  { name: 'Never Gonna Give You Up', type: ActivityType.Listening },
  { name: 'Seabus\'s unfunny jokes :(', type: ActivityType.Listening },
  { name: 'Geo-FS', type: ActivityType.Playing },
  { name: '67🫲🧒🫱', type: ActivityType.Playing },
];

function setRandomActivity() {
  if (!client.user) return;
  const activity = activities[Math.floor(Math.random() * activities.length)];
  client.user.setActivity(activity.name, { type: activity.type });
}

client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  setRandomActivity();
  setInterval(setRandomActivity, 60_000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /link ──────────────────────────────────────────────────
  if (commandName === 'link') {
    await interaction.deferReply({ ephemeral: true });
    const geofsId = interaction.options.getString('geofs_id').trim();

    if (!/^\d+$/.test(geofsId)) {
      return interaction.editReply({ content: '❌ GeoFS ID must be numbers' });
    }

    try {
      const taken = await User.findOne({ geofsUserId: geofsId, discordId: { $ne: interaction.user.id } });
      if (taken) {
        return interaction.editReply({ content: `❌ GeoFS ID \`${geofsId}\` was lined by other user` });
      }

      await User.findOneAndUpdate(
        { discordId: interaction.user.id },
        {
          $set: {
            discordId:   interaction.user.id,
            username:    interaction.user.username,
            displayName: interaction.user.displayName || interaction.user.username,
            geofsUserId: geofsId,
            linkedAt:    new Date()
          }
        },
        { upsert: true }
      );

      const embed = new EmbedBuilder()
        .setColor(0x00ff85)
        .setTitle('✅ GeoFS ID Linked')
        .setDescription(`Successfully linked GeoFS ID \`${geofsId}\` to your Discord account.\nYour flights will now be tracked under your profile.`)
        .setFooter({ text: 'GeoFS Radar', iconURL: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp' });

      interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/link error', err);
      interaction.editReply({ content: '❌ Server error, please try again.' });
    }
  }

  // ── /stats ─────────────────────────────────────────────────
  else if (commandName === 'stats') {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;

    try {
      const dbUser = await User.findOne({ discordId: targetUser.id });
      if (!dbUser || !dbUser.geofsUserId) {
        return interaction.editReply({
          content: targetUser.id === interaction.user.id
            ? `❌ You haven't linked your GeoFS ID yet. Use \`/link\` first.`
            : `❌ That user hasn't linked their GeoFS ID.`
        });
      }

      const stats = await FlightSession.aggregate([
        { $match: { discordId: targetUser.id } },
        { $group: {
          _id: null,
          totalFlights:    { $sum: 1 },
          totalDistanceNm: { $sum: '$distanceNm' },
          totalDuration:   { $sum: '$duration' },
          maxAlt:          { $max: '$maxAlt' },
          maxSpeed:        { $max: '$maxSpeed' },
          completed:       { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
        }}
      ]);

      const s = stats[0] || { totalFlights: 0, totalDistanceNm: 0, totalDuration: 0 };
      const totalH = Math.floor((s.totalDuration || 0) / 3600);
      const totalM = Math.floor(((s.totalDuration || 0) % 3600) / 60);

      const embed = new EmbedBuilder()
        .setColor(0x00b4d8)
        .setTitle(`📊 Flight Stats — ${targetUser.displayName || targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: '✈ Total Flights',   value: `${s.totalFlights || 0}`,                         inline: true },
          { name: '✅ Completed',       value: `${s.completed || 0}`,                             inline: true },
          { name: '📏 Total Distance',  value: `${(s.totalDistanceNm || 0).toLocaleString()} nm`, inline: true },
          { name: '⏱ Total Airtime',   value: `${totalH}h ${totalM}m`,                           inline: true },
          { name: '🔝 Record Altitude', value: s.maxAlt   ? `${s.maxAlt.toLocaleString()} ft`   : '—', inline: true },
          { name: '💨 Record Speed',    value: s.maxSpeed ? `${s.maxSpeed} kts`                 : '—', inline: true },
        )
        .setFooter({ text: `GeoFS ID: ${dbUser.geofsUserId} · GeoFS Radar`, iconURL: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp' });

      interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/stats error', err);
      interaction.editReply({ content: '❌ Server error.' });
    }
  }

  // ── /flights ───────────────────────────────────────────────
  else if (commandName === 'flights') {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const page       = (interaction.options.getInteger('page') || 1) - 1;
    const LIMIT      = 5;

    try {
      const dbUser = await User.findOne({ discordId: targetUser.id });
      if (!dbUser || !dbUser.geofsUserId) {
        return interaction.editReply({
          content: targetUser.id === interaction.user.id
            ? `❌ You haven't linked your GeoFS ID yet. Use \`/link\` first.`
            : `❌ That user hasn't linked their GeoFS ID.`
        });
      }

      const [flights, total] = await Promise.all([
        FlightSession.find({ discordId: targetUser.id })
          .sort({ startTime: -1 })
          .skip(page * LIMIT)
          .limit(LIMIT)
          .lean(),
        FlightSession.countDocuments({ discordId: targetUser.id })
      ]);

      if (!flights.length) {
        return interaction.editReply({ content: '📋 No flight records found.' });
      }

      const pages = Math.ceil(total / LIMIT);
      const lines = flights.map((f) => {
        const dep  = f.departure  || 'N/A';
        const arr  = f.arrival    || 'N/A';
        const dur  = fmtDuration(f.duration);
        const dist = f.distanceNm ? `${f.distanceNm} nm` : '—';
        const status = f.status === 'aborted' ? '⚠️' : '✅';
        return `${status} **${f.callsign || 'N/A'}** \`${dep} → ${arr}\`\n↳ ${fmtDateShort(f.startTime)} · ${dur} · ${dist}`;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x00ff85)
        .setTitle(`✈ Flights — ${targetUser.displayName || targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .setDescription(lines)
        .addFields({ name: 'Total', value: `${total} flights`, inline: true })
        .setFooter({ text: `Page ${page + 1}/${pages} · Use /flights page:${page + 2} for next · GeoFS Radar` })
        .setURL(`${RADAR_URL}/history.html`);

      interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/flights error', err);
      interaction.editReply({ content: '❌ Server error.' });
    }
  }

  // ── /whois ─────────────────────────────────────────────────
  else if (commandName === 'whois') {
    await interaction.deferReply();
    const callsign = interaction.options.getString('callsign').trim().toUpperCase();

    try {
      const recent = await FlightSession.findOne({ callsign: new RegExp(`^${callsign}$`, 'i') })
        .sort({ startTime: -1 })
        .lean();

      if (!recent) {
        return interaction.editReply({ content: `🔍 No records found for callsign **${callsign}**.` });
      }

      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`🔍 Whois: ${callsign}`);

      const dbUser = recent.discordId
        ? await User.findOne({ discordId: recent.discordId }).lean()
        : recent.geofsUserId
          ? await User.findOne({ geofsUserId: recent.geofsUserId }).lean()
          : null;

      if (dbUser) {
        const discordUser = await client.users.fetch(dbUser.discordId).catch(() => null);
        embed.setDescription(`**${callsign}** is operated by <@${dbUser.discordId}>`);
        if (discordUser) embed.setThumbnail(discordUser.displayAvatarURL());
        embed.addFields(
          { name: '👤 Discord',   value: `<@${dbUser.discordId}>`, inline: true },
          { name: '🎮 GeoFS ID', value: dbUser.geofsUserId || '—', inline: true },
        );
      } else {
        embed.setDescription(`**${callsign}** — pilot not linked to any Discord account`);
        if (recent.geofsUserId) {
          embed.addFields({ name: '🎮 GeoFS ID', value: recent.geofsUserId, inline: true });
        }
      }

      embed.addFields(
        { name: '✈ Aircraft',    value: recent.type        || '—', inline: true },
        { name: '🛫 Last Route', value: `${recent.departure || 'N/A'} → ${recent.arrival || 'N/A'}`, inline: true },
        { name: '📅 Last Seen',  value: fmtDate(recent.startTime), inline: true },
      );
      embed.setFooter({ text: 'GeoFS Radar', iconURL: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp' });

      interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('/whois error', err);
      interaction.editReply({ content: '❌ Server error.' });
    }
  }

  // ── /reminder ──────────────────────────────────────────────
  else if (commandName === 'reminder') {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'status') {
        const pref = await ReminderPreference.findOne({ discordId: interaction.user.id });
        const on = pref?.enabled ?? false;
        const chStr = REMINDER_CHANNEL_ID ? `<#${REMINDER_CHANNEL_ID}>` : 'DM';
        return interaction.editReply({
          content: on
            ? `🔔 Reminder is **enabled** — you'll be pinged in ${chStr} when approaching your penultimate waypoint.`
            : `🔕 Reminder is **disabled**. Use \`/reminder enable\` to turn it on.`
        });
      }

      if (sub === 'disable') {
        await ReminderPreference.findOneAndUpdate(
          { discordId: interaction.user.id },
          { $set: { enabled: false, updatedAt: new Date() } },
          { upsert: true }
        );
        return interaction.editReply({ content: '🔕 Waypoint reminder **disabled**.' });
      }

      if (sub === 'enable') {
        await ReminderPreference.findOneAndUpdate(
          { discordId: interaction.user.id },
          { $set: { enabled: true, updatedAt: new Date() } },
          { upsert: true }
        );
        const chStr = REMINDER_CHANNEL_ID ? `<#${REMINDER_CHANNEL_ID}>` : 'your DMs';
        const embed = new EmbedBuilder()
          .setColor(0x00ff85)
          .setTitle('🔔 Waypoint Reminder Enabled')
          .setDescription(`You'll be pinged in ${chStr} when your flight is approaching the **penultimate waypoint** (within ~30 nm).`)
          .addFields({ name: 'ℹ️ Note', value: 'Make sure your GeoFS ID is linked with `/link`, and your flight plan has at least 2 waypoints.' })
          .setFooter({ text: 'GeoFS Radar', iconURL: 'https://i.ibb.co/fzm8m0LS/geofs-flightradar.webp' });
        return interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('/reminder error', err);
      interaction.editReply({ content: '❌ Server error.' });
    }
  }
});

// ============ 輪詢 PendingNotification ============
async function processPendingNotifications() {
  try {
    const pending = await PendingNotification.find({ sent: false }).lean();
    for (const notif of pending) {
      try {
        const wpLabel  = notif.penultimateWaypoint || 'penultimate waypoint';
        const arrLabel = notif.arrival || 'destination';
        const text = `🛬 **${notif.callsign}** — Arriving the last waypoint **${wpLabel}**, arrival airport is **${arrLabel}**, please prepare for landing`;

        let sent = false;

        // 優先發送到固定頻道
        if (REMINDER_CHANNEL_ID) {
          try {
            const ch = await client.channels.fetch(REMINDER_CHANNEL_ID);
            await ch.send({ content: `<@${notif.discordId}> ${text}` });
            sent = true;
          } catch (e) {
            console.warn(`[Reminder] Failed to send to channel ${REMINDER_CHANNEL_ID}:`, e.message);
          }
        }

        // Fallback：DM
        if (!sent) {
          try {
            const user = await client.users.fetch(notif.discordId);
            await user.send({ content: text });
            sent = true;
          } catch (e) {
            console.warn(`[Reminder] Failed to DM ${notif.discordId}:`, e.message);
          }
        }

        if (sent) {
          await PendingNotification.updateOne({ _id: notif._id }, { $set: { sent: true } });
          console.log(`[Reminder] ✅ Sent to ${notif.discordId} for ${notif.callsign}`);
        }
      } catch (e) {
        console.error('[Reminder] Error processing notification:', e);
      }
    }
  } catch (e) {
    console.error('[Reminder] Poll error:', e);
  }
}

// ============ 啟動 ============
registerCommands().then(() => {
  client.login(BOT_TOKEN).then(() => {
    setInterval(processPendingNotifications, 15_000);
    console.log('⏱ Reminder polling started (every 15s)');
  });
});
