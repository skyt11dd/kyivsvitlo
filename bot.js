import { Telegraf, Markup, session } from 'telegraf';
import dtek from './dtek.js';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.BOT_TOKEN) {
    console.error("BOT_TOKEN is missing in .env");
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory sessions
bot.use(session());

const timeTypes = {
    "yes": "🟢 Світло є",
    "maybe": "🟡 Можливе відключення",
    "no": "🔴 Світла немає",
    "first": "🔴 Немає перші 30 хв",
    "second": "🔴 Немає другі 30 хв",
    "mfirst": "🟡 Можливо немає перші 30 хв",
    "msecond": "🟡 Можливо немає другі 30 хв"
};

bot.start((ctx) => {
    ctx.reply("Привіт! Я бот для моніторингу графіків відключення електроенергії в Києві (ДТЕК).\n\nНапишіть назву вашої вулиці (наприклад, 'хрещатик').");
});

bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    
    const query = ctx.message.text;
    ctx.session = ctx.session || {};
    
    // First, search streets
    await ctx.reply("Шукаю вулицю...");
    try {
        const streets = dtek.searchStreets(query);
        if (streets.length === 0) {
            // Ensure API is loaded
            await dtek.init();
            await dtek.fetchStreets();
            const streetsLoaded = dtek.searchStreets(query);
            if (streetsLoaded.length === 0) {
                return ctx.reply("Вулицю не знайдено. Спробуйте іншу назву.");
            }
            streets.push(...streetsLoaded);
        }

        if (streets.length > 10) {
            streets.length = 10;
        }

        const buttons = streets.map(s => [Markup.button.callback(s, `street:${s.substring(0, 50)}`)]);
        ctx.reply("Оберіть вулицю:", Markup.inlineKeyboard(buttons));
    } catch (e) {
        console.error(e);
        ctx.reply("Сталася помилка при пошуку.");
    }
});

bot.action(/^street:(.+)$/, async (ctx) => {
    const street = ctx.match[1];
    ctx.session = ctx.session || {};
    ctx.session.street = street;
    
    try {
        await ctx.answerCbQuery();
        await ctx.editMessageText(`Завантажую будинки для вулиці: ${street}...`);
        
        const res = await dtek.getHouses(street);
        if (!res || !res.result || !res.data) {
            return ctx.editMessageText("Будинки не знайдено.");
        }
        
        ctx.session.housesData = res.data;
        const houseNumbers = Object.keys(res.data).sort((a,b) => a.localeCompare(b, undefined, {numeric: true}));
        
        if (houseNumbers.length === 0) {
            return ctx.editMessageText("Будинки не знайдено на цій вулиці.");
        }
        
        // Paginate houses (show first 30)
        // For simplicity, we just take first 50
        const page = houseNumbers.slice(0, 50);
        
        const buttons = [];
        let row = [];
        for (const h of page) {
            row.push(Markup.button.callback(h, `house:${h}`));
            if (row.length === 5) {
                buttons.push(row);
                row = [];
            }
        }
        if (row.length > 0) buttons.push(row);
        
        if (houseNumbers.length > 50) {
            ctx.editMessageText(`Оберіть будинок (показано перші 50 з ${houseNumbers.length}):`, Markup.inlineKeyboard(buttons));
        } else {
            ctx.editMessageText("Оберіть будинок:", Markup.inlineKeyboard(buttons));
        }
    } catch (e) {
        console.error(e);
        ctx.editMessageText("Помилка при завантаженні будинків.");
    }
});

bot.action(/^house:(.+)$/, async (ctx) => {
    const house = ctx.match[1];
    const session = ctx.session || {};
    if (!session.housesData || !session.housesData[house]) {
        return ctx.answerCbQuery("Сесія застаріла, знайдіть вулицю знову.", {show_alert: true});
    }
    
    const houseInfo = session.housesData[house];
    const groups = houseInfo.sub_type_reason; // e.g. ["GPV20.1"]
    
    if (!groups || groups.length === 0) {
        return ctx.answerCbQuery("Групу відключень для цього будинку не знайдено.");
    }
    
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Завантажую графік для групи ${groups.join(', ')}...`);
    
    try {
        const updateData = await dtek.checkDisconUpdate();
        if (!updateData || !updateData.fact) {
            return ctx.editMessageText("Не вдалося отримати графік від ДТЕК.");
        }
        
        const todayTs = updateData.fact.today;
        const groupData = updateData.fact.data[todayTs][groups[0]];
        const groupName = updateData.preset?.sch_names?.[groups[0]] || groups[0];
        
        if (!groupData) {
            return ctx.editMessageText(`Графік для групи ${groupName} на сьогодні відсутній.`);
        }
        
        let msg = `⚡ **Графік для:**\n📍 ${session.street}, ${house}\n👥 ${groupName}\n\n`;
        msg += `🕒 Графік на сьогодні:\n`;
        
        for (let i = 1; i <= 24; i++) {
            const status = groupData[i.toString()];
            const hourStart = (i - 1).toString().padStart(2, '0') + ":00";
            const hourEnd = i.toString().padStart(2, '0') + ":00";
            
            msg += `${hourStart} - ${hourEnd} | ${timeTypes[status] || status}\n`;
        }
        
        msg += `\nАктуальність даних: ${updateData.updateTimestamp || updateData.fact.update}`;
        
        ctx.editMessageText(msg, { parse_mode: 'Markdown' });
        
    } catch (e) {
        console.error(e);
        ctx.editMessageText("Помилка при завантаженні графіка.");
    }
});

bot.launch().then(() => {
    console.log("Bot is running!");
}).catch(console.error);

// Enable graceful stop
process.once('SIGINT', () => { bot.stop('SIGINT'); dtek.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); dtek.close(); });
