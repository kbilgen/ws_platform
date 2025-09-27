// public/assets/login.js
// Exposes: window.signIn, window.signUp, window.oauth

(function(){
  const SUPABASE_URL = window.ENV_SUPABASE_URL || null;
  const SUPABASE_ANON_KEY = window.ENV_SUPABASE_ANON_KEY || null;
  const url = SUPABASE_URL || (window.SUPABASE_URL || '');
  const key = SUPABASE_ANON_KEY || (window.SUPABASE_ANON_KEY || '');
  const supabase = window.supabase.createClient(url, key);

  // Inject appropriate CAPTCHA script dynamically
  (function(){
    const tKey = window.ENV_TURNSTILE_SITE_KEY;
    const hKey = window.ENV_HCAPTCHA_SITE_KEY;
    if (tKey) {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.defer = true; document.head.appendChild(s);
    } else if (hKey) {
      const s = document.createElement('script');
      s.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
      s.defer = true; document.head.appendChild(s);
    }
  })();

  // OAuth callback handling
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const next = new URLSearchParams(location.search).get('next') || '/app';
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        localStorage.setItem('sb_token', token);
        location.replace(next);
      }
    } catch {}
  });

  let captchaProvider = null;
  let captchaWidgetId = null;

  function renderCaptcha(){
    const tKey = window.ENV_TURNSTILE_SITE_KEY;
    const hKey = window.ENV_HCAPTCHA_SITE_KEY;
    if (tKey && window.turnstile) {
      captchaProvider = 'turnstile';
      captchaWidgetId = window.turnstile.render('#captchaBox', { sitekey: tKey });
    } else if (hKey && window.hcaptcha) {
      captchaProvider = 'hcaptcha';
      captchaWidgetId = window.hcaptcha.render('captchaBox', { sitekey: hKey });
    } else {
      setTimeout(renderCaptcha, 300);
    }
  }
  renderCaptcha();

  function getCaptchaToken(){
    if (captchaProvider === 'turnstile') {
      try { return window.turnstile.getResponse(captchaWidgetId) || ''; } catch { return ''; }
    }
    if (captchaProvider === 'hcaptcha') {
      try { return window.hcaptcha.getResponse(captchaWidgetId) || ''; } catch { return ''; }
    }
    return '';
  }

  function resetCaptcha(){
    try{
      if (captchaProvider === 'turnstile' && window.turnstile) window.turnstile.reset(captchaWidgetId);
      if (captchaProvider === 'hcaptcha' && window.hcaptcha) window.hcaptcha.reset(captchaWidgetId);
    }catch{}
  }

  window.signIn = async function signIn(){
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    document.getElementById('msg').textContent = '';
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){ document.getElementById('msg').textContent = error.message; return; }
    const token = data.session?.access_token;
    if(!token){ document.getElementById('msg').textContent = 'Auth başarısız'; return; }
    localStorage.setItem('sb_token', token);
    location.href = '/app';
  }

  window.signUp = async function signUp(){
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    document.getElementById('msg').textContent = '';
    if(!email || !password){ document.getElementById('msg').textContent = 'E-posta ve şifre gerekli'; return; }
    const captchaToken = getCaptchaToken();
    if(!captchaToken){ document.getElementById('msg').textContent = 'Lütfen güvenlik doğrulamasını tamamlayın'; return; }
    try{
      const r = await fetch('/auth/signup', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ email, password, captchaToken, provider: captchaProvider })
      });
      const j = await r.json();
      if(!j.ok){ throw new Error(j.error||'Kayıt başarısız'); }
      document.getElementById('msg').textContent = 'Kayıt başarılı. Lütfen gelen doğrulama e-postasını onaylayın, sonra giriş yapın.';
    }catch(e){
      document.getElementById('msg').textContent = e.message;
    } finally {
      resetCaptcha();
    }
  }

  window.oauth = async function oauth(provider){
    const next = new URLSearchParams(location.search).get('next') || '/app';
    try{
      await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: location.origin + '/login.html?next=' + encodeURIComponent(next) }
      });
    }catch(e){ document.getElementById('msg').textContent = e.message || 'OAuth başlatılamadı'; }
  }
})();
