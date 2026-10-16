'use strict';
const axios = require('axios');
const http = require('http');

// ───────── Конфиг (config.json рядом со скриптом) ─────────
// { "token": "...", "chatId": "1174739981",
//   "firebaseUrl": "https://....firebasedatabase.app/.json" }
const cfg = {
    token: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
    firebaseUrl: process.env.FIREBASE_URL,
};
if (!cfg.token || !cfg.chatId || !cfg.firebaseUrl) {
    console.error('❌ Не заданы BOT_TOKEN, CHAT_ID или FIREBASE_URL');
    process.exit(1);
}
const TOKEN = cfg.token;
const CHAT_ID = String(cfg.chatId);
const FIREBASE_URL = cfg.firebaseUrl;

const idToNick = {
    "666258": "Grisha_Zverovskiy",
    "4028950": "Lelik_Supreme",
    "685355": "Semyon_Lazarov",
    "4360313": "Kenzo_Kolodov",
    "4095031": "Katana_Hersoness",
    "1831642": "Blake_Capone",
    "4324899": "Nikita_Lanoru",
    "2124472": "Zloy_Litvinenko",
    "1417977": "Edrian_Backer",
    "889513": "Nikita_Guobrozul",
};

const DATE_KEYS = ['date', 'timestamp', 'createdAt', 'created', 'time', 'ts', 'dateCreated', 'created_at'];
const ID_KEYS = ['userId', 'user_id', 'uid', 'authorId', 'id'];
const NAME_KEYS = ['username', 'nickname', 'nick', 'name', 'author'];

// ───────── Утилиты ─────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}
function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

function pick(obj, keys) {
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return undefined;
}

function parseDate(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) {
        let n = Number(v);
        if (n < 1e12) n *= 1000;
        const d = new Date(n);
        return isNaN(d) ? null : d;
    }
    const s = String(v).trim();
    let m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2}))?/);
    if (m) {
        const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
        return isNaN(d) ? null : d;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(s);
    return isNaN(d) ? null : d;
}

function collectRecords(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    const dv = Array.isArray(node) ? undefined : pick(node, DATE_KEYS);
    if (dv !== undefined && typeof dv !== 'object') {
        out.push(node);
        return out;
    }
    Object.values(node).forEach(child => collectRecords(child, out));
    return out;
}

// ───────── Периоды ─────────
// Возвращает { from, to, title } — границы включительно (начало суток)
function presetPeriod(key) {
    const today = startOfDay(new Date());
    if (key === 'today') return { from: today, to: today, title: 'за сегодня' };
    if (key === 'yesterday') {
        const y = addDays(today, -1);
        return { from: y, to: y, title: `за вчера (${fmt(y)})` };
    }
    const n = parseInt(key, 10);
    if (n > 0) return { from: addDays(today, -(n - 1)), to: today, title: `за последние ${n} дн.` };
    return null;
}

function makeDate(d, m, y) {
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

// Понимает: "15.10", "15.10.2026", "15.10.26", "01.10.2026-10.10.2026", "01.10 10.10"
function parseUserPeriod(text) {
    const re = /(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?/g;
    const found = [];
    let m;
    while ((m = re.exec(text)) && found.length < 2) {
        let y = m[3] ? +m[3] : new Date().getFullYear();
        if (y < 100) y += 2000;
        const dt = makeDate(+m[1], +m[2], y);
        if (!dt) return null;
        found.push(dt);
    }
    if (!found.length) return null;
    let [from, to] = [found[0], found[1] || found[0]];
    if (from > to) [from, to] = [to, from];
    const title = from.getTime() === to.getTime()
        ? `за ${fmt(from)}`
        : `с ${fmt(from)} по ${fmt(to)}`;
    return { from, to, title };
}

// ───────── Отчёт ─────────
async function generateReport({ from, to, title }) {
    try {
        const { data } = await axios.get(FIREBASE_URL, { timeout: 20000 });
        if (!data) return '⚠️ База данных Firebase пуста.';

        const fromT = from.getTime();
        const toT = to.getTime();
        const stats = {};
        let total = 0;

        for (const item of collectRecords(data)) {
            const date = parseDate(pick(item, DATE_KEYS));
            if (!date) continue;
            const day = startOfDay(date).getTime();
            if (day < fromT || day > toT) continue;

            const userId = String(pick(item, ID_KEYS) ?? 'Unknown_ID');
            const rawNick = pick(item, NAME_KEYS);
            const nick = idToNick[userId] || (rawNick ? String(rawNick) : `Unknown (${userId})`);

            if (!stats[userId]) stats[userId] = { userId, nick, count: 0 };
            stats[userId].count++;
            total++;
        }

        const rows = Object.values(stats).sort((a, b) => b.count - a.count);
        let tg = `📊 <b>Статистика жалоб (${esc(title)})</b>\n\n`;
        if (!rows.length) return tg + 'Жалоб за выбранный период не зафиксировано.';

        rows.forEach((r, i) => {
            tg += `${i + 1}. <b>${esc(r.nick)}</b> (ID: <code>${esc(r.userId)}</code>) — <b>${r.count}</b>\n`;
        });
        tg += `\nВсего: <b>${total}</b> жал. • Людей: <b>${rows.length}</b>`;
        return tg;
    } catch (e) {
        return `❌ Ошибка при обращении к базе: ${esc(e.message)}`;
    }
}

// ───────── Telegram ─────────
const tg = (method, data = {}, timeout = 15000) =>
    axios.post(`https://api.telegram.org/bot${TOKEN}/${method}`, data, { timeout })
        .then(r => r.data);

// Telegram режет сообщения >4096 символов — делим по строкам
async function send(chatId, text, extra = {}) {
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if ((cur + line + '\n').length > 3800) { chunks.push(cur); cur = ''; }
        cur += line + '\n';
    }
    if (cur.trim()) chunks.push(cur);
    for (let i = 0; i < chunks.length; i++) {
        await tg('sendMessage', {
            chat_id: chatId,
            text: chunks[i],
            parse_mode: 'HTML',
            ...(i === chunks.length - 1 ? extra : {})
        });
    }
}

const MENU = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📅 Сегодня', callback_data: 'p:today' }, { text: '⏪ Вчера', callback_data: 'p:yesterday' }],
            [{ text: '7 дней', callback_data: 'p:7' }, { text: '14 дней', callback_data: 'p:14' }, { text: '30 дней', callback_data: 'p:30' }],
            [{ text: '📆 Своя дата / период', callback_data: 'p:custom' }]
        ]
    }
};

const sendMenu = chatId => send(chatId, '⚙️ <b>Выберите период для отчёта по жалобам:</b>', MENU);

const CUSTOM_HINT =
    '📆 Отправьте дату или период:\n\n' +
    '• <code>15.10.2026</code> — один день\n' +
    '• <code>15.10</code> — день текущего года\n' +
    '• <code>01.10.2026-10.10.2026</code> — период';

async function reportAndMenu(chatId, period) {
    await send(chatId, await generateReport(period));
    await sendMenu(chatId);
}

async function handleUpdate(u) {
    // Нажатие на кнопку
    if (u.callback_query) {
        const cq = u.callback_query;
        const chatId = String(cq.message?.chat.id);
        tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
        if (chatId !== CHAT_ID) return;

        const key = (cq.data || '').replace('p:', '');
        if (key === 'custom') return send(chatId, CUSTOM_HINT);

        const period = presetPeriod(key);
        if (period) {
            log('Запрос:', period.title);
            await reportAndMenu(chatId, period);
        }
        return;
    }

    // Текстовое сообщение
    const msg = u.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    if (chatId !== CHAT_ID) return; // чужим не отвечаем

    const text = msg.text.trim();
    if (/^\/(start|menu)/i.test(text)) return sendMenu(chatId);
    if (/^\/date/i.test(text) && !/\d/.test(text)) return send(chatId, CUSTOM_HINT);

    const period = parseUserPeriod(text);
    if (period) {
        log('Запрос:', period.title);
        return reportAndMenu(chatId, period);
    }
    if (/^\/yesterday/i.test(text)) return reportAndMenu(chatId, presetPeriod('yesterday'));
    if (/^\/today/i.test(text)) return reportAndMenu(chatId, presetPeriod('today'));

    await send(chatId, '🤷 Не понял. Нажмите кнопку или отправьте дату вида <code>15.10.2026</code>.', MENU);
}

async function startBot() {
    log('🤖 Бот запущен');
    await tg('setMyCommands', {
        commands: [
            { command: 'menu', description: 'Меню периодов' },
            { command: 'today', description: 'Жалобы за сегодня' },
            { command: 'yesterday', description: 'Жалобы за вчера' },
            { command: 'date', description: 'Выбрать дату или период' }
        ]
    }).catch(() => {});
    await sendMenu(CHAT_ID).catch(e => log('Не удалось отправить меню:', e.message));

    let offset = 0;
    let fails = 0;
    while (true) {
        try {
            const res = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, 40000);
            fails = 0;
            for (const u of res.result) {
                offset = u.update_id + 1;
                // Не блокируем опрос долгим отчётом, ошибки логируем
                handleUpdate(u).catch(e => log('Ошибка обработки:', e.message));
            }
        } catch (e) {
            fails++;
            log(`Ошибка опроса (${fails}):`, e.response?.data?.description || e.message);
            await sleep(Math.min(3000 * fails, 30000)); // растущая пауза до 30 сек
        }
    }
}
// HTTP-сервер нужен только для Render: сервис не засыпает, когда на него приходят пинги
http
    .createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
    })
    .listen(process.env.PORT || 3000, () => {
        log('🌐 HTTP-сервер слушает порт', process.env.PORT || 3000);
    });

startBot();
