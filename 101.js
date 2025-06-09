const { chromium } = require('playwright');

(async () => {
  const baseUrl = 'https://top.lookuptrends.co/search/?srprc=3&q=iphone&t=4&clear';
  const testUrl = baseUrl + '&test';

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  const page = await context.newPage();

  // Stealth: Remove navigator.webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
  });

  let clarityId = null;
  let fbPixelDetected = false;
  let fbPixelId = null;

  function findClarityId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.ms_clarityid) return obj.ms_clarityid;
    for (const key in obj) {
      if (typeof obj[key] === 'object') {
        const found = findClarityId(obj[key]);
        if (found) return found;
      }
    }
    return null;
  }

  page.on('requestfinished', async (request) => {
    const reqUrl = request.url();

    if (!clarityId) {
      const match = reqUrl.match(/clarity\.ms\/tag\/([a-z0-9]+)/i);
      if (match) clarityId = match[1];
    }

    if (reqUrl.includes('facebook.com/tr')) {
      fbPixelDetected = true;
      try {
        const urlObj = new URL(reqUrl);
        const id = urlObj.searchParams.get('id');
        if (id) fbPixelId = id;
      } catch {}
    }

    if (!clarityId) {
      try {
        const postData = request.postData();
        if (postData) {
          let json;
          try {
            json = JSON.parse(postData);
          } catch {}
          if (json) {
            const found = findClarityId(json);
            if (found) clarityId = found;
          }
        }
      } catch {}
    }
  });

  // STEP 1: Load base URL to extract tracking and content info
  try {
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(5000);
  } catch (err) {
    console.warn(`⚠️ Initial load failed: ${err.message}`);
  }

  try {
    await page.reload({ waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(5000);
  } catch (err) {
    console.warn(`⚠️ Hard reload failed: ${err.message}`);
  }

  const fallbackIds = await page.evaluate(() => {
    const result = { clarity: null, fbPixel: null };
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      if (!result.clarity && script.src?.includes('clarity.ms/tag/')) {
        const match = script.src.match(/clarity\.ms\/tag\/([a-z0-9]+)/i);
        if (match) result.clarity = match[1];
      }
      if (!result.fbPixel && script.innerText.includes("fbq('init'")) {
        const match = script.innerText.match(/fbq\(['"]init['"],\s*['"](\d{5,})['"]\)/);
        if (match) result.fbPixel = match[1];
      }
    }
    return result;
  });

  clarityId = clarityId || fallbackIds.clarity;
  fbPixelId = fbPixelId || fallbackIds.fbPixel;

   const footerLinks = await page.evaluate(() => {
    const anchors = new Set();

    const collectLinks = (container) => {
      if (!container) return;
      for (const a of container.querySelectorAll('a')) {
        const href = a.href?.trim();
        const text = a.textContent?.trim();
        if (href) anchors.add(JSON.stringify({ text, href }));
      }
    };

    collectLinks(document.querySelector('footer'));
    document.querySelectorAll('[class*="footer"]').forEach(collectLinks);
    collectLinks(document.querySelector('.footer-links'));

    // Deduplicate and parse back from stringified form
    return Array.from(anchors).map(str => JSON.parse(str));
  });


  const trfUrl = await page.evaluate(() => {
    const trfLinks = Array.from(document.querySelectorAll('a[href*="trf"]'));
    return trfLinks.length > 0 ? trfLinks[0].href : null;
  });

  // STEP 2: Load &test version to extract Portfolio ID and Sourctag
  let portfolioId = null;
  let sourctag = null;

  try {
    await page.goto(testUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);

    const debugInfo = await page.evaluate(() => {
      const text = document.body.innerText;

      const portfolioMatch = text.match(/portfolio[_\s\-]?id[:=]?\s*([a-zA-Z0-9\-]+)/i);
      const sourctagMatch = text.match(/src=([a-zA-Z0-9\-_]+)/i);

      return {
        portfolioId: portfolioMatch ? portfolioMatch[1] : null,
        sourctag: sourctagMatch ? sourctagMatch[1] : null
      };
    });

    portfolioId = debugInfo.portfolioId;
    sourctag = debugInfo.sourctag;
  } catch (err) {
    console.warn(`⚠️ Test mode page failed: ${err.message}`);
  }

  // OUTPUT
  console.log(`\n🔍 URL Tested: ${baseUrl}`);
  console.log(`📌 Clarity Script Detected: ${clarityId ? '✅' : '❌'}`);
  if (clarityId) console.log(`    Clarity ID: ${clarityId}`);

  console.log(`📌 Facebook Pixel Detected: ${fbPixelId ? '✅' : fbPixelDetected ? '⚠️ Partial (no ID)' : '❌'}`);
  if (fbPixelId) console.log(`    Facebook Pixel ID: ${fbPixelId}`);

  console.log(`\n📌 Footer Links (${footerLinks.length}):`);
  footerLinks.forEach((link, i) => {
    console.log(`    ${i + 1}. [${link.text || '(no text)'}] ${link.href}`);
  });

  console.log(`\n📌 TRF Ad URL Found: ${trfUrl ? '✅' : '❌'}`);
  if (trfUrl) console.log(`    TRF URL: ${trfUrl}`);

  console.log(`\n📌 Portfolio ID (via &test): ${portfolioId || '❌ Not Found'}`);
  console.log(`📌 Sourctag (via &test): ${sourctag || '❌ Not Found'}`);

  await browser.close();
})();
