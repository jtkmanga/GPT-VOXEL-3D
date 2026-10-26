let liveSiteConfig = {
    announcement: '',
    freeName: 'Free Server ฟรีไม่จำกัด',
    vipName: 'VIP Server 1',
    maintenanceFree: false,
    maintenanceVip: false,
    paymentPaused: false,
    vipAdmissionPaused: false,
    promptPayEnabled: false,
    pricing: { currency:'THB', speed:10, coin:20, vip1:50 }
};

function liveApplySiteConfig(value = {}) {
    liveSiteConfig = {
        announcement: typeof value.announcement === 'string' ? value.announcement.slice(0, 300) : '',
        freeName: typeof value.freeName === 'string' && value.freeName ? value.freeName.slice(0, 80) : 'Free Server ฟรีไม่จำกัด',
        vipName: typeof value.vipName === 'string' && value.vipName ? value.vipName.slice(0, 80) : 'VIP Server 1',
        maintenanceFree: value.maintenanceFree === true,
        maintenanceVip: value.maintenanceVip === true,
        paymentPaused: value.paymentPaused === true,
        vipAdmissionPaused: value.vipAdmissionPaused === true,
        promptPayEnabled: value.promptPayEnabled === true,
        pricing: {
            currency: value?.pricing?.currency === 'THB' ? 'THB' : 'THB',
            speed: Number.isSafeInteger(Number(value?.pricing?.speed)) && Number(value.pricing.speed) > 0 ? Number(value.pricing.speed) : 10,
            coin: Number.isSafeInteger(Number(value?.pricing?.coin)) && Number(value.pricing.coin) > 0 ? Number(value.pricing.coin) : 20,
            vip1: Number.isSafeInteger(Number(value?.pricing?.vip1)) && Number(value.pricing.vip1) > 0 ? Number(value.pricing.vip1) : 50
        }
    };
    const announcement = document.getElementById('live-announcement');
    if (announcement) {
        announcement.textContent = liveSiteConfig.announcement;
        announcement.classList.toggle('hidden', !liveSiteConfig.announcement);
    }
    const free = document.getElementById('live-free-name');
    if (free) free.textContent = '🌐 ' + liveSiteConfig.freeName;
    const vip = document.getElementById('live-vip-name');
    if (vip) vip.textContent = '👑 ' + liveSiteConfig.vipName;
    const vipPrice = document.getElementById('live-vip-price');
    if (vipPrice) vipPrice.textContent = liveSiteConfig.pricing.vip1 + ' บาท/เดือน';
    if (typeof updateShopUI === 'function') updateShopUI();
    if (typeof renderServersUI === 'function') renderServersUI();
}

async function liveLoadSiteConfig() {
    try {
        if (window.location.protocol === 'http:') return;
        const base = SECURE_WORKER_HTTP_BASE || window.location.origin;
        const response = await fetch(base + '/site-config', { cache: 'no-store' });
        const value = await response.json();
        if (response.ok && value?.ok) liveApplySiteConfig(value);
    } catch (_) {}
}

setTimeout(() => {
    liveLoadSiteConfig();
    setInterval(liveLoadSiteConfig, 5000);
}, 0);
