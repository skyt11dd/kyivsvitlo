import { chromium } from 'playwright';

const BASE = 'https://www.dtek-kem.com.ua';

class DtekAPI {
    constructor() {
        this.session = null;
        this.browser = null;
        this.context = null;
        this.streetsCache = [];
        this.initPromise = null;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._init();
        return this.initPromise;
    }

    async _init() {
        try {
            console.log("Initializing WAF bypass...");
            this.browser = await chromium.launch({ 
                channel: 'msedge', 
                headless: true, 
                args: ['--disable-blink-features=AutomationControlled'], 
                ignoreDefaultArgs: ['--enable-automation'] 
            });
            this.context = await this.browser.newContext({ locale: 'uk-UA', timezoneId: 'Europe/Kyiv' });
            
            await this.context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
            
            const page = await this.context.newPage();
            console.log("Navigating to dtek-kem...");
            await page.goto(BASE + '/ua/shutdowns', { waitUntil: 'domcontentloaded', timeout: 60000 });
            
            // Wait for WAF to clear
            for (let i = 0; i < 25; i++) { 
                await page.waitForTimeout(1000); 
                const h = await page.content().catch(() => ''); 
                if (h.length > 10000) break; 
            }
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            
            const info = await page.evaluate(() => {
                // If it fails to find DisconSchedule, WAF is probably still blocking
                if (typeof DisconSchedule === 'undefined') return null;
                return {
                    update: DisconSchedule.fact?.update || '',
                    csrf: document.querySelector('meta[name="csrf-token"]')?.content || '',
                    ua: navigator.userAgent,
                };
            });

            if (!info) {
                throw new Error("Failed to bypass WAF or DisconSchedule not found");
            }

            const cookies = await this.context.cookies(BASE);
            const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
            
            this.session = {
                cookieHeader,
                csrf: info.csrf,
                ua: info.ua,
                update: info.update
            };
            
            console.log("Session acquired successfully");
            await page.close();
            
        } catch (err) {
            console.error("DtekAPI init error:", err);
            this.initPromise = null;
            if (this.browser) {
                await this.browser.close().catch(()=>{});
                this.browser = null;
            }
            throw err;
        }
    }

    async _request(method, dataFields = []) {
        await this.init();
        
        const body = new URLSearchParams();
        body.append('method', method);
        
        if (method === 'checkDisconUpdate') {
            body.append('update', dataFields[0] ? dataFields[0].value : this.session.update);
        } else {
            dataFields.forEach((field, index) => {
                body.append(`data[${index}][name]`, field.name);
                body.append(`data[${index}][value]`, field.value);
            });
        }

        const headers = {
            'User-Agent': this.session.ua, 
            'Accept': 'application/json, text/javascript, */*; q=0.01', 
            'Accept-Language': 'uk-UA,uk;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 
            'X-Requested-With': 'XMLHttpRequest', 
            'X-CSRF-Token': this.session.csrf,
            'Origin': BASE, 
            'Referer': BASE + '/ua/shutdowns', 
            'Cookie': this.session.cookieHeader,
        };

        let res = await fetch(BASE + '/ua/ajax', { method: 'POST', headers, body: body.toString() });
        
        if (res.status === 403 || res.status === 401) {
            console.log("Session expired or WAF block. Refreshing session...");
            this.initPromise = null;
            if (this.browser) await this.browser.close().catch(()=>{});
            await this.init();
            headers['X-CSRF-Token'] = this.session.csrf;
            headers['Cookie'] = this.session.cookieHeader;
            res = await fetch(BASE + '/ua/ajax', { method: 'POST', headers, body: body.toString() });
        }

        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            console.error("Failed to parse JSON response:", text.substring(0, 200));
            throw e;
        }
    }

    async fetchStreets() {
        const res = await this._request('getStreets');
        if (res && res.streets) {
            this.streetsCache = res.streets;
        }
        return this.streetsCache;
    }

    searchStreets(query) {
        if (!query) return [];
        const lowerQ = query.toLowerCase();
        return this.streetsCache.filter(s => s.toLowerCase().includes(lowerQ)).slice(0, 10);
    }

    async getHouses(street) {
        // data array: [{name: 'street', value: ...}, {name: 'house_num', value: ''}, {name: 'updateFact', value: ...}]
        const res = await this._request('getHomeNum', [
            { name: 'street', value: street },
            { name: 'house_num', value: '' },
            { name: 'updateFact', value: this.session.update }
        ]);
        return res;
    }
    
    async checkDisconUpdate() {
        const res = await this._request('checkDisconUpdate', [
            { name: 'update', value: '01.01.2000 00:00' }
        ]);
        return res;
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close().catch(()=>{});
            this.browser = null;
        }
    }
}

export default new DtekAPI();
