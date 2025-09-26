module.exports = function attachPost(app){
  try {
    const attachIcuPostExact = require('./icu_post_exact.js');
    if (typeof attachIcuPostExact === 'function') {
      attachIcuPostExact(app);
      console.log('[icu][POST] attach ok (explicit before proxy)');
    } else {
      console.error('[icu][POST] attach failed: not a function');
    }
  } catch(e) {
    console.error('[icu][POST] attach failed:', e && e.message);
  }
};
