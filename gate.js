/* Password gate. auth.json holds a salted PBKDF2-SHA256 hash (scripts/set_password.py).
 * The password is asked once per browser, then remembered on this device. No auth.json = no gate. */
"use strict";
const Gate = (() => {
  const KEY = "ps_auth";
  const TXT = {
    ar: { title: "محاكي المحافظ", prompt: "أدخل كلمة المرور للدخول إلى الموقع.", pw: "كلمة المرور", go: "دخول",
      bad: "كلمة المرور غير صحيحة.", busy: "جارٍ التحقق…", remember: "يُحفظ الدخول على هذا الجهاز." },
    en: { title: "Portfolio Simulator", prompt: "Enter the password to open the site.", pw: "Password", go: "Enter",
      bad: "Wrong password.", busy: "Checking…", remember: "You stay signed in on this device." },
  };
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const unhex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
  async function derive(pw, a) {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(a.salt), iterations: a.iter }, k, 256));
  }
  const get = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const set = v => { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: asks again next time */ } };

  async function ready() {
    let a = null;
    try { const r = await fetch("auth.json", { cache: "no-cache" }); if (r.ok) a = await r.json(); } catch (e) { a = null; }
    if (!a || !a.hash) return;                      // no password configured
    if (get() === a.hash) return;                   // already signed in on this device
    let lang = "ar"; try { if (localStorage.getItem("lang") === "en") lang = "en"; } catch (e) { /* default */ }
    const t = TXT[lang];
    const box = document.createElement("div");
    box.id = "gate";
    box.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    box.innerHTML = `<form><img src="icon-192.png" alt="" width="56" height="56"><h2>${t.title}</h2><p>${t.prompt}</p>
      <input type="password" autocomplete="current-password" placeholder="${t.pw}" required autofocus>
      <button class="btn" type="submit">${t.go}</button><p class="gmsg"></p><p class="muted gsmall">${t.remember}</p></form>`;
    document.body.appendChild(box);
    document.body.classList.add("locked");
    const f = box.querySelector("form"), inp = box.querySelector("input"), msg = box.querySelector(".gmsg");
    inp.focus();
    return new Promise(resolve => {
      f.onsubmit = async e => {
        e.preventDefault();
        msg.textContent = t.busy; msg.className = "gmsg muted";
        let h = "";
        try { h = await derive(inp.value, a); } catch (x) { msg.textContent = String(x.message || x); msg.className = "gmsg bad"; return; }
        if (h !== a.hash) { msg.textContent = t.bad; msg.className = "gmsg bad"; inp.select(); return; }
        set(a.hash);
        box.remove();
        document.body.classList.remove("locked");
        resolve();
      };
    });
  }
  function signOut() { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } location.reload(); }
  return { ready, signOut };
})();
