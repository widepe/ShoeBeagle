// Owns Price Alert modal open/close, validation, suggestions, and submit flow.
(() => {
  const SB = (window.SB = window.SB || {});
  SB.alerts = SB.alerts || {};

  const openers = document.querySelectorAll("[data-open-alert]");
  const backdrop = document.getElementById("sbAlertBackdrop");
  const closeBtn = document.getElementById("sbAlertClose");
  const form = document.getElementById("sbSetAlertForm");
  const formView = document.getElementById("sbAlertFormView");
  const confirmBox = document.getElementById("sbConfirm");
  const confirmDetails = document.getElementById("sbConfirmDetails");
  const setAnother = document.getElementById("sbSetAnother");
  const maxedBox = document.getElementById("sbMaxed");
  const maxedClose = document.getElementById("sbMaxedClose");
  const bottomCloseBtn = document.getElementById("sbAlertBottomClose");
  const emailEl = document.getElementById("sbAlertEmail");
  const brandEl = document.getElementById("sbAlertBrand");
  const modelEl = document.getElementById("sbAlertModel");
  const priceEl = document.getElementById("sbAlertPrice");
  const brandSug = document.getElementById("sbBrandSug");
  const modelSug = document.getElementById("sbModelSug");
  const genderWrap = document.getElementById("sbGender");
  const btn = document.getElementById("sbSetAlertBtn");
  const status = document.getElementById("sbStatus");
  const API_ALERTS = "/api/alerts";
  if (!backdrop || !closeBtn || !form || !emailEl || !brandEl || !modelEl || !priceEl || !genderWrap || !btn) return;

  let brandModels = {}, brands = [], BRAND_CANON = new Map(), lastFocus = null, busy = false, selectedGender = "";
  const S = { open: null, items: [], idx: -1 };

  const normKey = (s) => String(s || "").toLowerCase().replace(/[\u00AE\u2122\u2120]/g, "").replace(/[^a-z0-9]/g, "");
  const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const sanitize = (str) => String(str || "").replace(/[<>'"]/g, "").replace(/script/gi, "").replace(/javascript:/gi, "").replace(/on\w+=/gi, "").trim().slice(0, 100);
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  function getModelsForBrandKey(brandKey) { const e = brandModels[brandKey]; return Array.isArray(e) ? e : (e && Array.isArray(e.models) ? e.models : []); }
  function getAliasesForBrandKey(brandKey) { const e = brandModels[brandKey]; return (e && Array.isArray(e.aliases)) ? e.aliases : [brandKey]; }
  function resolveBrandKey(input) { return BRAND_CANON.get(normKey(input)) || ""; }
  function normalizeWholeDollars(v) { let s = String(v || "").replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, ""); return (s || "").slice(0, 4); }
  function wrapOf(el) { return el ? el.closest(".sb-input-wrap") : null; }
  function toggleClear(input) { const w = input.closest(".sb-input-wrap"); const c = w?.querySelector(".sb-clear"); if (c) c.style.display = input.value.trim() ? "flex" : "none"; }

  const emailWrap = wrapOf(emailEl), brandWrap = wrapOf(brandEl), modelWrap = wrapOf(modelEl), priceWrap = priceEl.closest(".sb-price-wrap");
  function clearNextHighlight() { [emailWrap, brandWrap, modelWrap].forEach((w) => w?.classList.remove("sb-next")); genderWrap.classList.remove("sb-next"); priceWrap?.classList.remove("sb-next"); }
  function markNext(t) { clearNextHighlight(); if (t === "email") emailWrap?.classList.add("sb-next"); if (t === "brand") brandWrap?.classList.add("sb-next"); if (t === "model") modelWrap?.classList.add("sb-next"); if (t === "gender") genderWrap.classList.add("sb-next"); if (t === "price") priceWrap?.classList.add("sb-next"); }
  function hideStatus() { status.hidden = true; status.textContent = ""; status.className = "sb-status"; }
  function showStatus(msg, ok = false) { status.hidden = false; status.className = "sb-status " + (ok ? "ok" : "err"); status.textContent = msg; }
  function setBusy(v) { busy = v; btn.disabled = v; btn.textContent = v ? "Setting..." : "Set Alert"; }
  function setEnabled(el, on) { el.disabled = !on; if (!on) { el.value = ""; toggleClear(el); } }
  function setGender(g) { selectedGender = String(g || ""); genderWrap.querySelectorAll(".sb-gender-option").forEach((o) => { const on = (o.getAttribute("data-g") || "") === selectedGender; o.classList.toggle("active", on); o.setAttribute("aria-checked", on ? "true" : "false"); }); }

  const isEmailOk = () => !!(sanitize(emailEl.value).toLowerCase().includes("@"));
  const isBrandOk = () => !!resolveBrandKey(sanitize(brandEl.value));
  const isGenderOk = () => selectedGender === "mens" || selectedGender === "womens";
  const isPriceOk = () => { const p = parseInt(String(priceEl.value || ""), 10); return Number.isFinite(p) && p > 0; };
  function isModelOk() { const bk = resolveBrandKey(sanitize(brandEl.value)); if (!bk) return false; const m = sanitize(modelEl.value).toLowerCase(); return !!m && getModelsForBrandKey(bk).some((x) => String(x).trim().toLowerCase() === m); }

  function score(cand, q) { const c = String(cand || ""); const cl = c.toLowerCase(); q = String(q || "").trim().toLowerCase(); if (!q) return 0; const cs = squash(c), qs = squash(q); let s = 0; if (cl.startsWith(q)) s += 120; if (cl.includes(q)) s += 80; if (qs.length >= 3 && cs.includes(qs)) s += 110; return s - Math.min(c.length, 30) * 0.25; }
  function topMatches(list, typed, limit = 10) { const q = String(typed || "").trim(); if (!q) return []; return list.map((v) => ({ v, s: score(v, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.v); }
  function closeSuggestions(which) { if (!which || which === "brand") { brandSug.hidden = true; brandSug.innerHTML = ""; } if (!which || which === "model") { modelSug.hidden = true; modelSug.innerHTML = ""; } if (!which || S.open === which) { S.open = null; S.items = []; S.idx = -1; } }
  function renderSug(box, items, which, onPick) {
    box.innerHTML = ""; if (!items.length) { box.hidden = true; if (S.open === which) S.open = null; return; }
    S.open = which; S.items = items; S.idx = -1; const typedQuery = String((which === "brand" ? brandEl.value : modelEl.value) || "").trim();
    items.forEach((v) => { const d = document.createElement("div"); d.className = "item"; const match = v.toLowerCase().startsWith(typedQuery.toLowerCase()) ? v.slice(0, typedQuery.length) : v; const rest = v.toLowerCase().startsWith(typedQuery.toLowerCase()) ? v.slice(typedQuery.length) : ""; d.innerHTML = `<span class="sb-sug-match"></span>${rest ? '<span class="sb-sug-rest"></span>' : ''}`; d.querySelector('.sb-sug-match').textContent = match; const rr = d.querySelector('.sb-sug-rest'); if (rr) rr.textContent = rest; d.addEventListener("mousedown", (e) => { e.preventDefault(); onPick(v); }); box.appendChild(d); });
    box.hidden = false;
  }

  function syncStepUI({ focusNext = false } = {}) {
    const emailOk = isEmailOk(), brandOk = isBrandOk(), modelOk = isModelOk(), genderOk = isGenderOk(), priceOk = isPriceOk();
    setEnabled(brandEl, emailOk); if (!emailOk) { setEnabled(modelEl, false); setGender(""); setEnabled(priceEl, false); }
    setEnabled(modelEl, emailOk && brandOk); const genderEnabled = emailOk && brandOk && modelOk; genderWrap.classList.toggle("sb-disabled", !genderEnabled);
    if (!genderEnabled) { setGender(""); setEnabled(priceEl, false); }
    setEnabled(priceEl, emailOk && brandOk && modelOk && genderOk); if (!(emailOk && brandOk && modelOk && genderOk)) { priceEl.value = ""; toggleClear(priceEl); }
    btn.disabled = busy || !(emailOk && brandOk && modelOk && genderOk && priceOk);
    if (!emailOk) markNext("email"); else if (!brandOk) markNext("brand"); else if (!modelOk) markNext("model"); else if (!genderOk) markNext("gender"); else if (!priceOk) markNext("price"); else markNext(null);
    if (focusNext) { if (!emailOk) emailEl.focus(); else if (!brandOk) brandEl.focus(); else if (!modelOk) modelEl.focus(); else if (!genderOk) genderWrap.querySelector(".sb-gender-option")?.focus(); else if (!priceOk) priceEl.focus(); }
  }

  function openModal(prefillEmail) {
    lastFocus = document.activeElement; hideStatus(); confirmBox.hidden = true; maxedBox.hidden = true; formView.hidden = false;
    emailEl.value = prefillEmail ? String(prefillEmail).trim().toLowerCase() : ""; brandEl.value = ""; modelEl.value = ""; priceEl.value = ""; setGender("");
    [emailEl, brandEl, modelEl, priceEl].forEach(toggleClear); closeSuggestions(); backdrop.classList.add("open"); backdrop.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden"; syncStepUI({ focusNext: true });
  }
  function closeModal() { closeSuggestions(); backdrop.classList.remove("open"); backdrop.setAttribute("aria-hidden", "true"); const menuOpen = document.getElementById("slidePanelBackdrop")?.classList.contains("open"); document.body.style.overflow = menuOpen ? "hidden" : ""; clearNextHighlight(); if (lastFocus?.focus) lastFocus.focus(); }
  SB.alerts.openPriceAlert = () => openModal(new URLSearchParams(location.search).get("email"));

  async function loadCanonicalBrandModels() {
    const url = window.__SB_CANONICAL_BRAND_MODELS_URL__ || "/lib/canonical-brands-models.json";
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load canonical brands/models: ${res.status}`);
    brandModels = (await res.json()) || {}; brands = Object.keys(brandModels).sort((a, b) => a.localeCompare(b)); BRAND_CANON = new Map();
    for (const b of brands) { BRAND_CANON.set(normKey(b), b); for (const alias of getAliasesForBrandKey(b)) BRAND_CANON.set(normKey(alias), b); }
  }
  (async () => { try { await loadCanonicalBrandModels(); } catch (e) { console.error("[Set Alert] Failed loading canonical brand/models:", e?.message || String(e)); brandModels = {}; brands = []; BRAND_CANON = new Map(); } })();

  openers.forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); SB.alerts.openPriceAlert(); }));
  closeBtn.addEventListener("click", closeModal); bottomCloseBtn?.addEventListener("click", closeModal); maxedClose?.addEventListener("click", closeModal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener("click", (e) => { if (!backdrop.classList.contains("open")) return; const c = e.target.closest("[data-clear]"); if (!c) return; e.preventDefault(); const input = document.querySelector(c.getAttribute("data-clear")); if (!input) return; input.value = ""; toggleClear(input); hideStatus(); closeSuggestions(input === brandEl ? "brand" : input === modelEl ? "model" : null); syncStepUI({ focusNext: true }); });

  emailEl.addEventListener("input", () => { toggleClear(emailEl); hideStatus(); syncStepUI(); });
  emailEl.addEventListener("blur", () => syncStepUI());
  brandEl.addEventListener("input", () => { toggleClear(brandEl); hideStatus(); const bk = resolveBrandKey(brandEl.value); if (!bk) { modelEl.value = ""; toggleClear(modelEl); closeSuggestions("model"); setGender(""); priceEl.value = ""; toggleClear(priceEl); }
    if (!isEmailOk()) return syncStepUI(); const t = brandEl.value.trim(); if (!t) { closeSuggestions("brand"); return syncStepUI(); }
    renderSug(brandSug, topMatches(brands, t, 12), "brand", (v) => { brandEl.value = v; toggleClear(brandEl); closeSuggestions("brand"); syncStepUI({ focusNext: true }); }); syncStepUI(); });
  modelEl.addEventListener("input", () => { toggleClear(modelEl); hideStatus(); if (!isEmailOk() || !isBrandOk()) { modelEl.value = ""; toggleClear(modelEl); closeSuggestions("model"); return syncStepUI({ focusNext: true }); }
    const pool = getModelsForBrandKey(resolveBrandKey(brandEl.value)); const t = modelEl.value.trim(); if (!t) { closeSuggestions("model"); return syncStepUI(); }
    renderSug(modelSug, topMatches(pool, t, 6), "model", (v) => { modelEl.value = v; toggleClear(modelEl); closeSuggestions("model"); syncStepUI({ focusNext: true }); }); syncStepUI(); });
  priceEl.addEventListener("input", () => { priceEl.value = normalizeWholeDollars(priceEl.value); toggleClear(priceEl); hideStatus(); syncStepUI(); });
  priceEl.addEventListener("keypress", (e) => { if (e.key && !/[0-9]/.test(e.key)) e.preventDefault(); });
  genderWrap.addEventListener("click", (e) => { if (genderWrap.classList.contains("sb-disabled")) return showStatus("Fill out the fields above first."); const opt = e.target.closest(".sb-gender-option"); if (!opt) return; setGender(opt.getAttribute("data-g") || ""); hideStatus(); syncStepUI({ focusNext: true }); });
  genderWrap.addEventListener("keydown", (e) => { const opt = e.target.closest(".sb-gender-option"); if (!opt) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setGender(opt.getAttribute("data-g") || ""); hideStatus(); syncStepUI({ focusNext: true }); } });

  async function postJson(url, payload) {
    const res = await fetch(url, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data?.error ? String(data.error) : `HTTP ${res.status}: Failed to create alert`); err.code = data?.code ? String(data.code) : ""; throw err; }
    return data;
  }
  function showSuccess(brand, model, gender, price) { confirmDetails.innerHTML = `<div><strong>Shoe:</strong> ${esc(brand)} ${esc(model)}</div><div><strong>Gender:</strong> ${esc(gender === "mens" ? "Men’s" : "Women’s")}</div><div><strong>Target Price:</strong> $${esc(String(price))} or less</div>`; hideStatus(); closeSuggestions(); formView.hidden = true; maxedBox.hidden = true; confirmBox.hidden = false; brandEl.value = ""; modelEl.value = ""; priceEl.value = ""; setGender(""); [brandEl, modelEl, priceEl].forEach(toggleClear); syncStepUI(); }
  function showMaxedOut() { hideStatus(); closeSuggestions(); formView.hidden = true; confirmBox.hidden = true; maxedBox.hidden = false; brandEl.value = ""; modelEl.value = ""; priceEl.value = ""; setGender(""); [brandEl, modelEl, priceEl].forEach(toggleClear); syncStepUI(); }

  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return; hideStatus(); confirmBox.hidden = true; maxedBox.hidden = true; syncStepUI();
    if (!isEmailOk()) return showStatus("Please enter a valid email address."); if (!isBrandOk()) return showStatus("Please choose a brand from the list."); if (!isModelOk()) return showStatus("Please choose a model from the list."); if (!isGenderOk()) return showStatus("Select a gender."); if (!isPriceOk()) return showStatus("Please enter a valid target price (whole dollars).");
    const email = sanitize(emailEl.value).toLowerCase(), brand = resolveBrandKey(sanitize(brandEl.value)) || sanitize(brandEl.value), model = sanitize(modelEl.value), targetPrice = parseInt(String(priceEl.value || ""), 10), gender = selectedGender;
    setBusy(true);
    try { await postJson(API_ALERTS, { email, brand, model, targetPrice, gender }); showSuccess(brand, model, gender, targetPrice); }
    catch (err) { const msg = err?.message ? String(err.message) : "Failed to set alert."; const code = err?.code ? String(err.code) : ""; const looksMax = code.toUpperCase().includes("MAX") || msg.toLowerCase().includes("max") || msg.toLowerCase().includes("limit"); if (looksMax) showMaxedOut(); else showStatus(msg); }
    finally { setBusy(false); syncStepUI(); }
  });
  setAnother?.addEventListener("click", () => { confirmBox.hidden = true; maxedBox.hidden = true; formView.hidden = false; hideStatus(); brandEl.value = ""; modelEl.value = ""; priceEl.value = ""; setGender(""); [brandEl, modelEl, priceEl].forEach(toggleClear); closeSuggestions(); syncStepUI({ focusNext: true }); });
})();
