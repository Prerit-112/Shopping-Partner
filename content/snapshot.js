/**
 * Compact DOM snapshot — no full HTML (plan §10).
 */
(function () {
  function text(sel, root = document) {
    const el = root.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function amazon(snapshot) {
    const title = text('#productTitle') || text('#productTitle_feature_div h1');
    let price = '';
    const off = document.querySelector('.a-price .a-offscreen');
    if (off) price = off.textContent.trim();
    if (!price) {
      const whole = document.querySelector('.a-price-whole');
      const frac = document.querySelector('.a-price-fraction');
      if (whole) price = `${whole.textContent.trim()}${frac ? `.${frac.textContent.trim()}` : ''}`;
    }
    const asin =
      window.ShopAgentDetector.amazonAsinFromUrl() ||
      document.querySelector('[data-asin]')?.getAttribute('data-asin') ||
      '';
    snapshot.title = title || document.title;
    snapshot.priceText = price;
    snapshot.asin = asin;
    snapshot.hostname = location.hostname;
    return snapshot;
  }

  function flipkart(snapshot) {
    const title =
      text('span.B_NuCI') ||
      text('.yhB1nd') ||
      text('[class*="title"]');
    const priceEl = document.querySelector('div._30jeq3._16Jk6d, div._25b18d, ._30jeq3');
    const price = priceEl ? priceEl.textContent.replace(/\s+/g, ' ').trim() : '';
    snapshot.title = title || document.title;
    snapshot.priceText = price;
    snapshot.hostname = location.hostname;
    return snapshot;
  }

  function build() {
    const retailer = window.ShopAgentDetector.getRetailer();
    const base = {
      url: location.href,
      retailer,
      capturedAt: new Date().toISOString(),
    };
    if (retailer === 'amazon') return amazon(base);
    if (retailer === 'flipkart') return flipkart(base);
    base.title = document.title;
    return base;
  }

  window.ShopAgentSnapshot = { build };
})();
