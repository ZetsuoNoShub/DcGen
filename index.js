require('dotenv').config();
const { 
    Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, Events, Partials,
    ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEN_TOKEN    = process.env.DISCORD_TOKEN;

const GEN_CHANNEL_ID     = process.env.GEN_CHANNEL_ID;
const STAFF_ROLE_ID      = process.env.STAFF_ROLE_ID;
const SELF_SEND_BYPASS_ID = process.env.SELF_SEND_BYPASS_ID || '';
const GIF_PATH           = path.join(__dirname, 'standard.gif');
const SITE_URL           = process.env.SITE_URL;

const API_URL = 'https://www.netflix.com/graphql';
const API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://www.netflix.com',
    'Referer': 'https://www.netflix.com/',
};

const PAYLOAD_BROWSER = {
    operationName: 'CreateAutoLoginToken',
    variables: { scope: 'WEBVIEW_MOBILE_STREAMING' },
    extensions: {
        persistedQuery: {
            version: 102,
            id: '76e97129-f4b5-41a0-a73c-12e674896849'
        }
    }
};

const REQUIRED_COOKIES = ['NetflixId', 'SecureNetflixId', 'nfvdid'];
const waitingForCode = new Map();

// ── ROLE IDS ──────────────────────────────────────────────────────────────────
const ROLE_IDS = {
    BOOSTER: process.env.ROLE_BOOSTER,
    PREMIUM: process.env.ROLE_PREMIUM,
    GOD:     process.env.ROLE_GOD
};

// ── VOUCH CONFIG ──────────────────────────────────────────────────────────────
const PLS_COOLDOWN_TIME = 60 * 60 * 1000;
const PLS_PAIR_COOLDOWN = 12 * 60 * 60 * 1000;
const PLS_ALLOWED_ROLES = process.env.PLS_ALLOWED_ROLES ? process.env.PLS_ALLOWED_ROLES.split(',') : [];

// Guild emoji config — set these in .env as JSON or extend manually
// Format: { "GUILD_ID": { upvoteName, upvoteId, downvoteName, downvoteId } }
const GUILD_EMOJIS = process.env.GUILD_EMOJIS ? JSON.parse(process.env.GUILD_EMOJIS) : {};

// Optional: friendly server name overrides
// Format: { "GUILD_ID": "Display Name" }
const SERVER_NAMES = process.env.SERVER_NAMES ? JSON.parse(process.env.SERVER_NAMES) : {};

const plsActiveSessions  = new Map();
const tplsActiveSessions = new Map();

// ── TIER CONFIG ───────────────────────────────────────────────────────────────
const TIERS = ['free', 'booster', 'premium', 'god'];
const TIER_LABELS = { free: 'FREE', booster: 'BOOST', premium: 'PREM', god: 'GOD' };
const TIER_EMOJIS = { free: '⚪', booster: '🔵', premium: '🟣', god: '🟡' };

// ── SHARED HELPERS ────────────────────────────────────────────────────────────

function getReputation(vouches) {
    if (vouches >= 200) return '👑 Legend';
    if (vouches >= 100) return '🌟🌟🌟 Elite';
    if (vouches >= 50)  return '⭐⭐⭐ Trusted';
    if (vouches >= 30)  return '⭐⭐ Fair';
    if (vouches >= 1)   return '⭐ New';
    return '❌ None';
}

async function processPlsVouch({ targetUser, reactor, isUpvote, reasonText, record, message, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, guildId }) {
    const { getAllVouches, upsertVouch } = require('./models/vouchModel');
    try {
        const history = record?.vouch_history || [];

        const isDuplicate = history.some(v =>
            v.vouchedBy === reactor.id &&
            (Date.now() - new Date(v.timestamp).getTime()) < PLS_PAIR_COOLDOWN
        );

        const displayReason = reasonText
            ? `${isUpvote ? UPVOTE_DISPLAY : DOWNVOTE_DISPLAY} ${reasonText}`
            : `${isUpvote ? UPVOTE_DISPLAY : DOWNVOTE_DISPLAY} ${isUpvote ? 'Clean Interaction' : 'Negative Interaction'}`;

        const newEntry       = { vouchedBy: reactor.id, reason: displayReason, type: isUpvote ? 'upvote' : 'downvote', timestamp: new Date().toISOString() };
        const updatedHistory = [...history, newEntry].slice(-5);

        let vouchDelta = 0;
        if (!isDuplicate) vouchDelta = isUpvote ? 1 : -1;
        const updatedVouches = Math.max(0, (record?.vouches || 0) + vouchDelta);

        const updatedData = await upsertVouch(targetUser.id, guildId, {
            username: targetUser.username,
            vouches: updatedVouches,
            vouch_history: updatedHistory,
            last_vouch_time: new Date().toISOString()
        });

        const freshAll   = await getAllVouches(targetUser.id);
        const freshTotal = freshAll.reduce((sum, r) => sum + (r.vouches || 0), 0);

        let feedback;
        if (isDuplicate) {
            feedback = `⏳ <@${reactor.id}> Already vouched **${targetUser.username}** recently — 12h cooldown.`;
        } else if (isUpvote) {
            feedback = `${UPVOTE_DISPLAY} <@${reactor.id}> Upvoted **${targetUser.username}**${reasonText ? ` — *"${reasonText}"*` : ''} · Server: **${updatedData.vouches}** · Total: **${freshTotal}**`;
        } else {
            feedback = `${DOWNVOTE_DISPLAY} <@${reactor.id}> Downvoted **${targetUser.username}**${reasonText ? ` — *"${reasonText}"*` : ''} · Server: **${updatedData.vouches}** · Total: **${freshTotal}**`;
        }

        const m = await message.channel.send(feedback);
        setTimeout(() => m.delete().catch(() => {}), 8000);

    } catch (err) {
        console.error('processPlsVouch error:', err);
        const m = await message.channel.send(`<@${reactor.id}> ❌ Database error while processing vouch.`);
        setTimeout(() => m.delete().catch(() => {}), 5000);
    }
}

async function processTplsVouch({ targetUser, reactor, isUpvote, reasonText, record, guildId, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, interaction, hours }) {
    const { getAllVouches, upsertVouch } = require('./models/vouchModel');
    try {
        const history = record?.vouch_history || [];

        const displayReason = reasonText
            ? `${isUpvote ? UPVOTE_DISPLAY : DOWNVOTE_DISPLAY} ${reasonText}`
            : `${isUpvote ? UPVOTE_DISPLAY : DOWNVOTE_DISPLAY} ${isUpvote ? 'Clean Interaction' : 'Negative Interaction'}`;

        const newEntry = {
            vouchedBy: reactor.id,
            reason: displayReason,
            type: isUpvote ? 'upvote' : 'downvote',
            timestamp: new Date().toISOString()
        };

        const updatedHistory = [...history, newEntry].slice(-5);
        const vouchDelta     = isUpvote ? 1 : -1;
        const updatedVouches = Math.max(0, (record?.vouches || 0) + vouchDelta);

        await upsertVouch(targetUser.id, guildId, {
            username: targetUser.username,
            vouches: updatedVouches,
            vouch_history: updatedHistory,
            last_vouch_time: new Date().toISOString()
        });

        const freshAll   = await getAllVouches(targetUser.id);
        const freshTotal = freshAll.reduce((sum, r) => sum + (r.vouches || 0), 0);

        const updatedEmbed = buildTplsEmbed(targetUser, freshTotal, hours, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY);
        await interaction.message.edit({ embeds: [updatedEmbed] }).catch(() => {});

        const feedback = isUpvote
            ? `${UPVOTE_DISPLAY} <@${reactor.id}> vouched **${targetUser.username}**${reasonText ? ` — *"${reasonText}"*` : ''} · Total: **${freshTotal}**`
            : `${DOWNVOTE_DISPLAY} <@${reactor.id}> downvoted **${targetUser.username}**${reasonText ? ` — *"${reasonText}"*` : ''} · Total: **${freshTotal}**`;

        const m = await interaction.channel.send(feedback);
        setTimeout(() => m.delete().catch(() => {}), 8000);

    } catch (err) {
        console.error('processTplsVouch error:', err);
        const m = await interaction.channel.send(`<@${reactor.id}> ❌ Database error while processing vouch.`);
        setTimeout(() => m.delete().catch(() => {}), 5000);
    }
}

function buildTplsEmbed(targetUser, total, hours, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY) {
    return new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`Is **${targetUser.username}** legit?`)
        .setDescription(
            `> Click below to vouch for this user.\n` +
            `> **Total Vouches:** ${total} — ${getReputation(total)}\n\n` +
            `⏱️ Panel active for **${hours}h**`
        )
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: 'CLOUDIVERSE • Click to vouch' })
        .setTimestamp();
}

function buildTplsRow(emojiSet, messageId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`tpls_up_${messageId}`)
            .setLabel('Vouch')
            .setEmoji(emojiSet.upvoteId)
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId(`tpls_down_${messageId}`)
            .setLabel('Downvote')
            .setEmoji(emojiSet.downvoteId)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

// ── END HELPERS ───────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const fetch = globalThis.fetch;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

client.once(Events.ClientReady, (c) => {
    console.log(`\n✅ NETFLIX BOT ONLINE | ${c.user.tag}`);
    console.log('🔗 .link Browser Login ✅');
    console.log('🎁 .gen Generation ✅');
    console.log('👤 .pls Vouching ✅');
    console.log('📌 .tpls Permanent Panel ✅\n');
});

function getFiles() {
    const hasBanner = fs.existsSync(GIF_PATH);
    return hasBanner ? [new AttachmentBuilder(GIF_PATH)] : [];
}

function setGif(embed) {
    if (fs.existsSync(GIF_PATH)) {
        embed.setImage('attachment://standard.gif');
    }
    return embed;
}

function extractCookieDict(text) {
    if (!text || typeof text !== 'string') return { success: false };

    const trimmed = text.trim();
    let cookieDict = {};

    for (const line of trimmed.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const p = t.split('\t');
        if (p.length >= 7) {
            const n = p[5]?.trim();
            const v = p[6]?.trim();
            if (n && v) cookieDict[n] = v;
        }
    }
    if (REQUIRED_COOKIES.some(k => cookieDict[k])) return { success: true, data: cookieDict };

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            cookieDict = {};
            for (const e of parsed) {
                if (e?.name && e?.value) cookieDict[e.name] = String(e.value);
            }
            if (REQUIRED_COOKIES.some(k => cookieDict[k])) return { success: true, data: cookieDict };
        }
    } catch (e) {}

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
            cookieDict = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v === 'string') cookieDict[k] = v;
            }
            if (REQUIRED_COOKIES.some(k => cookieDict[k])) return { success: true, data: cookieDict };
        }
    } catch (e) {}

    cookieDict = {};
    const pairs = trimmed.split(/[;,]/);
    for (const pair of pairs) {
        const t = pair.trim();
        const eq = t.indexOf('=');
        if (eq > 0) {
            const n = t.substring(0, eq).trim();
            const v = t.substring(eq + 1).trim();
            if (n && v) cookieDict[n] = v;
        }
    }
    if (REQUIRED_COOKIES.some(k => cookieDict[k])) return { success: true, data: cookieDict };

    return { success: false };
}

async function validateNetflixTVCode(cookieDict, code) {
    const cookieHeader = Object.entries(cookieDict).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = { ...API_HEADERS, Cookie: cookieHeader };

    const methods = [
        { name: 'Shakti Pair',     url: 'https://www.netflix.com/api/shakti/v1/pair',     body: { code } },
        { name: 'Shakti Activate', url: 'https://www.netflix.com/api/shakti/v1/activate', body: { code } },
        {
            name: 'GraphQL Activate', url: API_URL, isGraphQL: true,
            body: {
                query: `mutation ActivateCode($code: String!) { activateCode(code: $code) { success } }`,
                operationName: 'ActivateCode',
                variables: { code }
            }
        }
    ];

    for (const method of methods) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(method.url, { method: 'POST', headers, body: JSON.stringify(method.body), signal: controller.signal });
            clearTimeout(timeout);
            console.log(`[Netflix] ${method.name}: ${res.status}`);
            if ([200, 201, 204].includes(res.status)) {
                try {
                    const data = await res.json();
                    if (data?.errors?.length > 0) { console.log(`[Netflix] ${method.name} error: ${data.errors[0]?.message?.substring(0, 80)}`); continue; }
                    if (data?.success || data?.data?.activateCode?.success) { return { success: true, method: method.name }; }
                } catch (e) { continue; }
            }
        } catch (err) {
            clearTimeout(timeout);
            console.log(`[Netflix] ${method.name} error: ${err.message.substring(0, 40)}`);
        }
    }

    return { success: false, error: 'Code validation failed' };
}

async function generateBrowserToken(cookieDict) {
    const cookieHeader = Object.entries(cookieDict).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = { ...API_HEADERS, Cookie: cookieHeader };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(PAYLOAD_BROWSER), signal: controller.signal });
        clearTimeout(timeout);
        if (res.status === 200) {
            const data = await res.json();
            const token = data?.data?.createAutoLoginToken?.token || data?.data?.createAutoLoginToken;
            if (token) return { success: true, token };
        }
        return { success: false, error: 'Failed to generate token' };
    } catch (err) {
        clearTimeout(timeout);
        return { success: false, error: err.message };
    }
}

// ── BUTTON INTERACTION HANDLER ────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('tpls_')) return;

    const { getVouch } = require('./models/vouchModel');

    const session = tplsActiveSessions.get(interaction.message.id);
    if (!session) {
        return interaction.reply({ content: '❌ This vouch panel is no longer active.', ephemeral: true });
    }

    if (Date.now() > session.expiresAt) {
        tplsActiveSessions.delete(interaction.message.id);
        await interaction.message.edit({ components: [buildTplsRow(session.emojiSet, interaction.message.id, true)] }).catch(() => {});
        return interaction.reply({ content: '❌ This vouch panel has expired.', ephemeral: true });
    }

    const { targetUser, guildId, emojiSet, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, hours } = session;
    const reactor  = interaction.user;
    const isUpvote = interaction.customId === `tpls_up_${interaction.message.id}`;

    if (reactor.id === targetUser.id) {
        return interaction.reply({ content: '❌ You cannot vouch yourself.', ephemeral: true });
    }

    const record  = await getVouch(targetUser.id, guildId);
    const history = record?.vouch_history || [];

    const isDuplicate = history.some(v =>
        v.vouchedBy === reactor.id &&
        (Date.now() - new Date(v.timestamp).getTime()) < PLS_PAIR_COOLDOWN
    );

    if (isDuplicate) {
        return interaction.reply({
            content: `⏳ You already vouched **${targetUser.username}** recently. Please wait 12 hours.`,
            ephemeral: true
        });
    }

    await interaction.reply({
        content: `💬 **${isUpvote ? '✅ Upvote' : '❌ Downvote'}** — Type your reason for **${targetUser.username}** below, or type \`skip\`. You have 30 seconds.`,
        ephemeral: true
    });

    const reasonFilter    = m => m.author.id === reactor.id && m.channelId === interaction.channelId;
    const reasonCollector = interaction.channel.createMessageCollector({ filter: reasonFilter, max: 1, time: 30_000 });

    reasonCollector.on('collect', async reasonMsg => {
        const reasonText = reasonMsg.content.toLowerCase() === 'skip' ? null : reasonMsg.content;
        reasonMsg.delete().catch(() => {});
        await processTplsVouch({ targetUser, reactor, isUpvote, reasonText, record, guildId, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, interaction, hours });
    });

    reasonCollector.on('end', async (collected) => {
        if (collected.size === 0) {
            const freshRecord = await getVouch(targetUser.id, guildId);
            await processTplsVouch({ targetUser, reactor, isUpvote, reasonText: null, record: freshRecord, guildId, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, interaction, hours });
        }
    });
});

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
    try {
        if (message.author.bot) return;

        // ── DM HANDLER ──────────────────────────────────────────────────────
        if (message.channel.isDMBased()) {
            const userId = message.author.id;
            const tvCode = message.content.trim().toUpperCase();
            
            if (waitingForCode.has(userId)) {
                const waiting = waitingForCode.get(userId);

                if (Date.now() > waiting.expiresAt) {
                    waitingForCode.delete(userId);
                    return message.reply('❌ **Request expired** (5 minutes passed)\n\nAsk staff for a new code.');
                }

                if (!/^[A-Z0-9]{6,8}$/.test(tvCode)) {
                    return message.reply(
                        `❌ **Invalid code format**\n\nCode must be 6-8 alphanumeric characters\nYou sent: \`${tvCode}\` (${tvCode.length} chars)`
                    );
                }

                const { data: codeData } = await supabase.from('codes').select('code_text').eq('id', waiting.codeId).single();
                if (!codeData) { waitingForCode.delete(userId); return message.reply('❌ Cookie not found in database.'); }

                const parseResult = extractCookieDict(codeData.code_text);
                if (!parseResult.success) { waitingForCode.delete(userId); return message.reply('❌ Invalid cookie format.'); }

                console.log(`[Netflix] Validating code ${tvCode} with Netflix...`);
                const validationResult = await validateNetflixTVCode(parseResult.data, tvCode);

                if (!validationResult.success) {
                    waitingForCode.delete(userId);
                    return message.reply(
                        `❌ **Code Validation Failed**\n\nThe code \`${tvCode}\` was rejected by Netflix.\n\n` +
                        `Possible reasons:\n• Code is invalid or expired\n• Code doesn't match TV screen\n• Account cookies are invalid\n\nAsk staff for a new code and try again.`
                    );
                }

                waitingForCode.delete(userId);
                await supabase.from('codes').update({ is_used: true }).eq('id', waiting.codeId);

                const embed = new EmbedBuilder()
                    .setTitle(`✅ Netflix TV Login Complete!`)
                    .setDescription(`Your TV device is now **logged in**!\n\nCode: \`${tvCode}\`\nMethod: ${validationResult.method}\n\n🎬 You can now start watching Netflix!`)
                    .setColor('#00e5a0')
                    .setFooter({ text: 'Netflix TV Activation' })
                    .setTimestamp();

                setGif(embed);
                return message.reply({ embeds: [embed], files: getFiles() });

            } else {
                return message.reply(`ℹ️ **No active request**\n\nAsk staff: \`.tv netflix @username\``);
            }
        }

        if (!message.guild) return;

        const lowerMsg = message.content.toLowerCase().trim();
        if (!lowerMsg.startsWith('.')) return;

        const args    = message.content.slice(1).trim().split(/ +/);
        const cmdName = args[0]?.toLowerCase();
        if (!cmdName) return;

        // ── .tpls - PERMANENT VOUCH PANEL ───────────────────────────────────
        if (cmdName === 'tpls') {
            const { getVouch, getAllVouches } = require('./models/vouchModel');

            const hasRole = message.member?.roles.cache.some(r => PLS_ALLOWED_ROLES.includes(r.id));
            if (!hasRole) return message.reply('❌ You do not have permission to use this command.');

            const emojiSet = GUILD_EMOJIS[message.guildId];
            if (!emojiSet) return message.reply('❌ This server is not configured for vouching.');

            let targetUser = message.mentions.users.first();
            if (!targetUser) {
                const idArg = args.find(a => /^\d{17,19}$/.test(a));
                if (idArg) targetUser = await message.client.users.fetch(idArg).catch(() => null);
            }
            if (!targetUser) return message.reply('❌ Please mention a user or provide their ID.\nUsage: `.tpls @user 24`');

            const hoursArg = args.find(a => /^\d+$/.test(a) && a.length < 10);
            const hours    = hoursArg ? Math.max(1, Math.min(parseInt(hoursArg), 720)) : 24;
            const expiresAt = Date.now() + hours * 60 * 60 * 1000;

            const UPVOTE_DISPLAY   = `<:${emojiSet.upvoteName}:${emojiSet.upvoteId}>`;
            const DOWNVOTE_DISPLAY = `<:${emojiSet.downvoteName}:${emojiSet.downvoteId}>`;

            const allRecords     = await getAllVouches(targetUser.id);
            const totalAcrossAll = allRecords.reduce((sum, r) => sum + (r.vouches || 0), 0);

            const embed = buildTplsEmbed(targetUser, totalAcrossAll, hours, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY);

            const sentMsg = await message.channel.send({
                embeds: [embed],
                components: [buildTplsRow(emojiSet, 'placeholder', false)]
            });

            await sentMsg.edit({
                components: [buildTplsRow(emojiSet, sentMsg.id, false)]
            });

            tplsActiveSessions.set(sentMsg.id, {
                targetUser,
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: sentMsg.id,
                emojiSet,
                UPVOTE_DISPLAY,
                DOWNVOTE_DISPLAY,
                expiresAt,
                hours
            });

            setTimeout(async () => {
                tplsActiveSessions.delete(sentMsg.id);
                await sentMsg.edit({ components: [buildTplsRow(emojiSet, sentMsg.id, true)] }).catch(() => {});
            }, hours * 60 * 60 * 1000);

            message.delete().catch(() => {});
            return;
        }

        // ── .pls - VOUCH PROFILE CARD ────────────────────────────────────────
        if (cmdName === 'pls') {
            const { getVouch, getAllVouches, upsertVouch } = require('./models/vouchModel');

            const hasRole = message.member?.roles.cache.some(r => PLS_ALLOWED_ROLES.includes(r.id));
            if (!hasRole) return message.reply('❌ You do not have permission to use this command.');

            const emojiSet = GUILD_EMOJIS[message.guildId];
            if (!emojiSet) return message.reply('❌ This server is not configured for vouching.');

            const UPVOTE_DISPLAY   = `<:${emojiSet.upvoteName}:${emojiSet.upvoteId}>`;
            const DOWNVOTE_DISPLAY = `<:${emojiSet.downvoteName}:${emojiSet.downvoteId}>`;

            let targetUser = message.mentions.users.first();
            if (!targetUser && args[1]) targetUser = await message.client.users.fetch(args[1]).catch(() => null);
            if (!targetUser) targetUser = message.author;

            const member = await message.guild.members.fetch(targetUser.id).catch(() => null);

            const allRecords        = await getAllVouches(targetUser.id);
            const totalAcrossAll    = allRecords.reduce((sum, r) => sum + (r.vouches || 0), 0);
            const thisServerRecord  = allRecords.find(r => r.guild_id === message.guildId);
            const thisServerVouches = thisServerRecord?.vouches || 0;
            const otherRecords      = allRecords.filter(r => r.guild_id !== message.guildId);

            let otherServersValue = '> None';
            if (otherRecords.length > 0) {
                otherServersValue = otherRecords.map(r => {
                    const name = SERVER_NAMES[r.guild_id] || `Server ${r.guild_id}`;
                    return `> **${name}:** \`${r.vouches || 0}\``;
                }).join('\n');
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`${targetUser.username}'s Profile`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
                .addFields(
                    {
                        name: '👤 Info',
                        value: [
                            `> **ID:** \`${targetUser.id}\``,
                            `> **Created:** <t:${Math.floor(targetUser.createdTimestamp / 1000)}:R>`,
                            member ? `> **Joined:** <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : `> **Joined:** Unknown`,
                        ].join('\n'),
                        inline: false
                    },
                    {
                        name: '🌐 Total Vouches',
                        value: `> **${totalAcrossAll}** — ${getReputation(totalAcrossAll)}`,
                        inline: false
                    },
                    {
                        name: `🏠 ${message.guild.name}`,
                        value: `> **${thisServerVouches}** vouch${thisServerVouches !== 1 ? 'es' : ''}`,
                        inline: true
                    },
                    {
                        name: '🌍 Other Servers',
                        value: otherServersValue,
                        inline: true
                    }
                );

            const history = thisServerRecord?.vouch_history || [];
            if (history.length > 0) {
                const historyText = history.slice(-3).reverse()
                    .map((v, i) => `\`${i + 1}.\` ${v.reason || `${UPVOTE_DISPLAY} Clean Interaction`}`)
                    .join('\n');
                embed.addFields({ name: '📝 Recent Activity', value: historyText, inline: false });
            }

            embed.setFooter({ text: 'CLOUDIVERSE' }).setTimestamp();

            const sentMsg = await message.reply({ embeds: [embed] });

            await sentMsg.react(emojiSet.upvoteId).catch(() => {});
            await sentMsg.react(emojiSet.downvoteId).catch(() => {});

            plsActiveSessions.set(sentMsg.id, {
                targetUser,
                guildId: message.guildId,
                channelId: message.channelId,
                emojiSet,
                UPVOTE_DISPLAY,
                DOWNVOTE_DISPLAY,
                reactedUsers: new Set()
            });

            const filter    = (reaction, user) =>
                [emojiSet.upvoteName, emojiSet.downvoteName].includes(reaction.emoji.name) && !user.bot;
            const collector = sentMsg.createReactionCollector({ filter, time: 10 * 60 * 1000 });

            collector.on('collect', async (reaction, reactor) => {
                const session = plsActiveSessions.get(sentMsg.id);
                if (!session) return;

                const { targetUser, reactedUsers, emojiSet, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY } = session;

                if (reactor.id === targetUser.id) {
                    reaction.users.remove(reactor.id).catch(() => {});
                    const m = await message.channel.send(`<@${reactor.id}> ❌ You cannot vouch yourself.`);
                    setTimeout(() => m.delete().catch(() => {}), 4000);
                    return;
                }

                if (reactedUsers.has(reactor.id)) {
                    reaction.users.remove(reactor.id).catch(() => {});
                    return;
                }

                const record = await getVouch(targetUser.id, message.guildId);
                if (record?.last_vouch_time) {
                    const timePassed = Date.now() - new Date(record.last_vouch_time).getTime();
                    if (timePassed < PLS_COOLDOWN_TIME) {
                        const remaining = Math.ceil((PLS_COOLDOWN_TIME - timePassed) / 60000);
                        reaction.users.remove(reactor.id).catch(() => {});
                        const m = await message.channel.send(
                            `<@${reactor.id}> ⏳ Wait **${remaining}m** before vouching **${targetUser.username}** again.`
                        );
                        setTimeout(() => m.delete().catch(() => {}), 5000);
                        return;
                    }
                }

                reactedUsers.add(reactor.id);
                const isUpvote = reaction.emoji.name === emojiSet.upvoteName;

                const prompt = await message.channel.send(
                    `<@${reactor.id}> 💬 **${isUpvote ? '✅ Upvote' : '❌ Downvote'}** for **${targetUser.username}** — type your reason below (or \`skip\`). You have 30 seconds.`
                );

                const reasonFilter    = m => m.author.id === reactor.id;
                const reasonCollector = message.channel.createMessageCollector({ filter: reasonFilter, max: 1, time: 30_000 });

                reasonCollector.on('collect', async reasonMsg => {
                    const reasonText = reasonMsg.content.toLowerCase() === 'skip' ? null : reasonMsg.content;
                    reasonMsg.delete().catch(() => {});
                    prompt.delete().catch(() => {});
                    await processPlsVouch({ targetUser, reactor, isUpvote, reasonText, record, message, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, guildId: message.guildId });
                });

                reasonCollector.on('end', async (collected) => {
                    if (collected.size === 0) {
                        prompt.delete().catch(() => {});
                        const freshRecord = await getVouch(targetUser.id, message.guildId);
                        await processPlsVouch({ targetUser, reactor, isUpvote, reasonText: null, record: freshRecord, message, UPVOTE_DISPLAY, DOWNVOTE_DISPLAY, guildId: message.guildId });
                    }
                });
            });

            collector.on('end', () => {
                plsActiveSessions.delete(sentMsg.id);
                sentMsg.reactions.cache.get(emojiSet.upvoteId)?.users.remove(message.client.user.id).catch(() => {});
                sentMsg.reactions.cache.get(emojiSet.downvoteId)?.users.remove(message.client.user.id).catch(() => {});
            });

            return;
        }

        // ── .link ────────────────────────────────────────────────────────────
        if (cmdName === 'link') {
            if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return message.reply('❌ No permission.');

            const serviceName = args[1]?.toLowerCase();
            const targetUser  = message.mentions.users.first();

            if (!serviceName) return message.reply('❌ Usage: `.link <service> @user`');
            if (!targetUser)  return message.reply('❌ Mention a user.');
            if (targetUser.bot) return message.reply('❌ Cannot send to bot.');

            if (targetUser.id === message.author.id && message.author.id !== SELF_SEND_BYPASS_ID) {
                return message.reply('❌ You cannot send to yourself.');
            }

            const { data: service } = await supabase.from('services').select('*').ilike('name', serviceName).eq('tier', 'send').single();
            if (!service) return message.reply(`❌ Service \`${serviceName}\` not found.`);

            const { data: allCodes } = await supabase.from('codes').select('*').eq('service_id', service.id).eq('is_used', false);
            if (!allCodes || allCodes.length === 0) return message.reply('❌ No codes available.');

            const statusMsg = await message.reply(`⏳ Trying codes... (0/${allCodes.length})`);
            let sent = false;

            for (let i = 0; i < allCodes.length; i++) {
                const code = allCodes[i];
                await statusMsg.edit(`⏳ Trying codes... (${i + 1}/${allCodes.length})`);
                await supabase.from('codes').update({ is_used: true }).eq('id', code.id);

                const parseResult = extractCookieDict(code.code_text);
                if (!parseResult.success) continue;

                const missing = REQUIRED_COOKIES.filter(k => !parseResult.data[k]);
                if (missing.length > 0) continue;

                const tokenResult = await generateBrowserToken(parseResult.data);
                if (!tokenResult.success) continue;

                const browserLink = `https://www.netflix.com/youraccount?nftoken=${tokenResult.token}`;
                const embed = new EmbedBuilder()
                    .setTitle(`✅ Netflix Browser Login`)
                    .setDescription(`**[🎬 CLICK HERE TO LOGIN](${browserLink})**\n\nJust click the link to login instantly!\nNo password needed.`)
                    .setColor('#00e5a0')
                    .setTimestamp();

                setGif(embed);

                try {
                    await targetUser.send({ embeds: [embed], files: getFiles() });
                } catch (e) {
                    await statusMsg.edit(`❌ Could not DM **${targetUser.username}** — they may have DMs disabled.`);
                    return;
                }

                const confirmEmbed = new EmbedBuilder()
                    .setTitle('✅ Link Sent')
                    .setDescription(`Browser login sent to ${targetUser}\n*(used code ${i + 1} of ${allCodes.length})*`)
                    .setColor('#10b981')
                    .setTimestamp();

                await statusMsg.edit({ content: '', embeds: [confirmEmbed] });
                sent = true;
                break;
            }

            if (!sent) {
                const failEmbed = new EmbedBuilder()
                    .setTitle('❌ All Codes Exhausted')
                    .setDescription(`Tried all **${allCodes.length}** available code${allCodes.length !== 1 ? 's' : ''} — none produced a valid Netflix token.\n\nStock needs to be replenished.`)
                    .setColor('#ef4444')
                    .setTimestamp();
                await statusMsg.edit({ content: '', embeds: [failEmbed] });
            }

            return;
        }

        // ── .tv ──────────────────────────────────────────────────────────────
        if (cmdName === 'tv') {
            if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return message.reply('❌ No permission.');

            const serviceName = args[1]?.toLowerCase();
            const targetUser  = message.mentions.users.first();

            if (!serviceName) return message.reply('❌ Usage: `.tv <service> @user`');
            if (!targetUser)  return message.reply('❌ Mention a user.');
            if (targetUser.bot) return message.reply('❌ Cannot send to bot.');

            if (targetUser.id === message.author.id && message.author.id !== SELF_SEND_BYPASS_ID) {
                return message.reply('❌ You cannot send to yourself.');
            }

            const { data: service } = await supabase.from('services').select('*').ilike('name', serviceName).eq('tier', 'send').single();
            if (!service) return message.reply(`❌ Service \`${serviceName}\` not found.`);

            const { data: code } = await supabase.from('codes').select('*').eq('service_id', service.id).eq('is_used', false).limit(1).single();
            if (!code) return message.reply('❌ No codes available.');

            const statusMsg = await message.reply('⏳ Testing cookie...');

            try {
                const parseResult = extractCookieDict(code.code_text);
                if (!parseResult.success) {
                    await statusMsg.edit(`❌ Cookie invalid format`);
                    await supabase.from('codes').update({ is_used: true }).eq('id', code.id);
                    return;
                }

                const missing = REQUIRED_COOKIES.filter(k => !parseResult.data[k]);
                if (missing.length > 0) {
                    await statusMsg.edit(`❌ Missing: ${missing.join(', ')}`);
                    await supabase.from('codes').update({ is_used: true }).eq('id', code.id);
                    return;
                }

                waitingForCode.set(targetUser.id, { codeId: code.id, expiresAt: Date.now() + (5 * 60 * 1000) });

                const embed = new EmbedBuilder()
                    .setTitle(`📺 Netflix TV Login`)
                    .setDescription(`On your TV, you see a Netflix code.\n\nSend that code here:\n\nExample: \`ABC123\`\n\n⏱️ Expires in 5 minutes`)
                    .setColor('#E50914')
                    .setFooter({ text: 'Reply with the code from your TV' })
                    .setTimestamp();

                setGif(embed);
                await targetUser.send({ embeds: [embed], files: getFiles() });

                const confirmEmbed = new EmbedBuilder()
                    .setTitle('✅ Sent to ' + targetUser.username)
                    .setDescription(`Waiting for code...`)
                    .setColor('#FFA500')
                    .setTimestamp();

                await statusMsg.edit({ content: '', embeds: [confirmEmbed] });

            } catch (e) {
                console.error('Error:', e.message);
                await statusMsg.edit(`❌ Error`);
                await supabase.from('codes').update({ is_used: true }).eq('id', code.id);
            }

            return;
        }

        // ── .staff / .help ───────────────────────────────────────────────────
        if (cmdName === 'staff' || cmdName === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setTitle('🎬 Netflix Commands')
                .setColor('#E50914')
                .addFields(
                    { name: '🔗 .link <service> @user',  value: 'Send instant browser login link ✅', inline: false },
                    { name: '📺 .tv <service> @user',    value: 'Send TV code activation',            inline: false },
                    { name: '📦 .stock',                  value: 'View available codes',               inline: false },
                    { name: '📤 .send <service> @user',  value: 'Send credentials file',              inline: false },
                    { name: '👤 .pls @user',              value: 'View vouch profile card',            inline: false },
                    { name: '📌 .tpls @user [hours]',    value: 'Create permanent vouch panel',        inline: false }
                )
                .setFooter({ text: 'Netflix Bot | Staff Commands' })
                .setTimestamp();

            setGif(helpEmbed);
            return message.reply({ embeds: [helpEmbed], files: getFiles() });
        }

        // ── .stock ───────────────────────────────────────────────────────────
        if (cmdName === 'stock') {
            const { data: services } = await supabase
                .from('services')
                .select('id, name, tier')
                .not('tier', 'in', '("hidden","send")')
                .order('name', { ascending: true });

            if (!services || services.length === 0) {
                const emptyEmbed = new EmbedBuilder()
                    .setTitle('📦 Stock')
                    .setDescription('❌ Out of stock everywhere.')
                    .setTimestamp();
                setGif(emptyEmbed);
                return message.channel.send({ embeds: [emptyEmbed], files: getFiles() });
            }

            const grouped = {};
            for (const s of services) {
                const baseName = s.name
                    .replace(/[-_](free|booster|bst|premium|prem|god)$/i, '')
                    .toUpperCase()
                    .trim();
                if (!grouped[baseName]) grouped[baseName] = {};
                grouped[baseName][s.tier] = s.id;
            }

            const baseNames = Object.keys(grouped).sort();

            const rows = await Promise.all(baseNames.map(async (baseName) => {
                const tierData = grouped[baseName];
                const counts = {};
                await Promise.all(TIERS.map(async (tier) => {
                    const serviceId = tierData[tier];
                    if (!serviceId) { counts[tier] = 0; return; }
                    const { count } = await supabase
                        .from('codes')
                        .select('*', { count: 'exact', head: true })
                        .eq('service_id', serviceId)
                        .eq('is_used', false);
                    counts[tier] = count || 0;
                }));
                return { baseName, counts };
            }));

            const TIER_CONFIG = [
                { tier: 'free',    label: '⚪ Free'    },
                { tier: 'booster', label: '🔵 Booster' },
                { tier: 'premium', label: '🟣 Premium' },
                { tier: 'god',     label: '🟡 God'     },
            ];

            const activeTiers = [];

            for (const { tier, label } of TIER_CONFIG) {
                const tierRows = rows.filter(r => grouped[r.baseName][tier] !== undefined);
                if (tierRows.length === 0) continue;

                const hasStock = tierRows.some(r => (r.counts[tier] || 0) > 0);
                if (!hasStock) continue;

                const description = tierRows
                    .map(r => {
                        const c = r.counts[tier] || 0;
                        if (c === 0) return null;
                        return `> **${r.baseName}** — \`${c}\``;
                    })
                    .filter(Boolean)
                    .join('\n');

                activeTiers.push({ label, description });
            }

            if (activeTiers.length === 0) {
                const emptyEmbed = new EmbedBuilder()
                    .setTitle('📦 Stock')
                    .setDescription('❌ Out of stock everywhere.')
                    .setTimestamp();
                setGif(emptyEmbed);
                return message.channel.send({ embeds: [emptyEmbed], files: getFiles() });
            }

            for (let i = 0; i < activeTiers.length; i++) {
                const { label, description } = activeTiers[i];
                const isLast = i === activeTiers.length - 1;

                const embed = new EmbedBuilder()
                    .setTitle(`${label} Tier`)
                    .setDescription(description)
                    .setTimestamp();

                if (isLast) setGif(embed);

                await message.channel.send({
                    embeds: [embed],
                    files: isLast ? getFiles() : []
                });
            }

            return;
        }

        // ── .send ────────────────────────────────────────────────────────────
        if (cmdName === 'send') {
            if (!message.member.roles.cache.has(STAFF_ROLE_ID)) return;

            const serviceName = args[1]?.toLowerCase();
            const targetUser  = message.mentions.users.first();

            if (!serviceName) return message.reply('❌ Usage: `.send <service> @user`');
            if (!targetUser)  return message.reply('❌ Mention a user');
            if (targetUser.bot) return message.reply('❌ Cannot send to bot');

            if (targetUser.id === message.author.id && message.author.id !== SELF_SEND_BYPASS_ID) {
                return message.reply('❌ You cannot send to yourself.');
            }

            try {
                const { data: s } = await supabase.from('services').select('*').ilike('name', serviceName).eq('tier', 'send').single();
                if (!s) return message.reply('❌ Not found');

                const { data: c } = await supabase.from('codes').select('*').eq('service_id', s.id).eq('is_used', false).limit(1).single();
                if (!c) return message.reply('❌ OOS');

                const attachment = new AttachmentBuilder(Buffer.from(c.code_text), { name: `${s.name.replace(/\s+/g, '_')}.txt` });

                const dmEmbed = new EmbedBuilder()
                    .setTitle(`🎁 ${s.name.toUpperCase()}`)
                    .setDescription('Account ready! 📎 Credentials in file')
                    .setColor('#10b981')
                    .setTimestamp();

                setGif(dmEmbed);
                await targetUser.send({ embeds: [dmEmbed], files: [...getFiles(), attachment] });
                await supabase.from('codes').update({ is_used: true }).eq('id', c.id);

                return message.channel.send({ content: `✅ Sent to ${targetUser}` });

            } catch (e) {
                return message.reply(`❌ Failed`);
            }
        }

        // ── GEN CHANNEL ──────────────────────────────────────────────────────
        if (message.channel.id !== GEN_CHANNEL_ID) return;

        const search = (cmdName === 'gen') ? args[1]?.toLowerCase() : cmdName;
        if (!search) return;

        // ── TIER CHECK ───────────────────────────────────────────────────────
        let userTier = 'free';
        if      (message.member.roles.cache.has(ROLE_IDS.GOD))     userTier = 'god';
        else if (message.member.roles.cache.has(ROLE_IDS.PREMIUM))  userTier = 'premium';
        else if (message.member.roles.cache.has(ROLE_IDS.BOOSTER))  userTier = 'booster';

        const tieredSearch = `${search}-${userTier}`;
        let { data: s } = await supabase.from('services').select('*').ilike('name', tieredSearch).single();

        if (!s) { const { data: plainS } = await supabase.from('services').select('*').ilike('name', search).eq('tier', userTier).single(); s = plainS; }
        if (!s && userTier !== 'free') {
            const { data: freeTieredS } = await supabase.from('services').select('*').ilike('name', `${search}-free`).single();
            s = freeTieredS;
            if (!s) { const { data: freePlainS } = await supabase.from('services').select('*').ilike('name', search).eq('tier', 'free').single(); s = freePlainS; }
        }

        if (!s || s.tier === 'send' || s.tier === 'hidden') return message.reply(`❌ Not available`);

        const { data: c } = await supabase.from('codes').select('*').eq('service_id', s.id).eq('is_used', false).limit(1).single();
        if (!c) return message.reply('❌ OOS!');

        try {
            const token     = randomUUID();
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

            await supabase.from('pending_claims').insert({ token, code_id: c.id, code_text: c.code_text, service_name: s.name, expires_at: expiresAt, claimed: false });
            await supabase.from('codes').update({ is_used: true }).eq('id', c.id);

            const finalLink = `${SITE_URL}/redirect?token=${token}`;
            const linkEmbed = new EmbedBuilder()
                .setTitle('🎁 Ready!')
                .setDescription(`**[✨ CLICK HERE ✨](${finalLink})**\n\n📦 ${s.name.toUpperCase()}`)
                .setColor('#10b981')
                .setTimestamp();

            setGif(linkEmbed);
            await message.author.send({ embeds: [linkEmbed], files: getFiles() });

            const replyEmbed = new EmbedBuilder()
                .setTitle('✅ Generated!')
                .setDescription(`Check DMs`)
                .setColor('#10b981')
                .setTimestamp();

            setGif(replyEmbed);
            message.reply({ embeds: [replyEmbed], files: getFiles() });

        } catch (e) {
            await supabase.from('codes').update({ is_used: false }).eq('id', c.id);
            message.reply('❌ Error');
        }

    } catch (e) {
        console.error('Error:', e);
    }
});

client.login(GEN_TOKEN).catch(err => {
    console.error('❌ Login failed:', err.message);
    process.exit(1);
});

process.on('unhandledRejection', err => console.error('Error:', err));
process.on('uncaughtException', err => {
    console.error('Critical error:', err);
    process.exit(1);
});
