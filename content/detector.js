/**
 * Amazon / Flipkart product page detection (plan §10).
 */
(function () {
  function hostname() {
    return window.location.hostname || '';
  }

  function path() {
    return window.location.pathname || '';
  }

  function amazonAsinFromUrl() {
    const p = path();
    const m = p.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1] : null;
  }

  function flipkartPid() {
    const u = window.location.href;
    const m = u.match(/flipkart\.com\/[^/]+\/p\//i);
    return Boolean(m);
  }

  function hasAmazonSignals() {
    const h = hostname();
    if (!/amazon\./i.test(h)) return false;
    const asin = amazonAsinFromUrl();
    const el =
      document.querySelector('#productTitle') ||
      document.querySelector('[data-feature-name="title"]');
    return Boolean(asin || el);
  }

  function hasFlipkartSignals() {
    if (!/flipkart\.com$/i.test(hostname()) && !/\.flipkart\.com$/i.test(hostname())) {
      return false;
    }
    return flipkartPid() || Boolean(document.querySelector('span.B_NuCI, .yhB1nd'));
  }

  function getRetailer() {
    const h = hostname();
    if (/flipkart/i.test(h)) return 'flipkart';
    if (/amazon\./i.test(h)) return 'amazon';
    return 'other';
  }

  window.ShopAgentDetector = {
    isProductPage() {
      return hasAmazonSignals() || hasFlipkartSignals();
    },
    getRetailer,
    amazonAsinFromUrl,
  };
})();
