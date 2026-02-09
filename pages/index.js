(() => {
  // ===== Hook your existing opener =====
  // Add data-open-alert to whatever already opens it:
  // <a href="#" data-open-alert>Set Alert</a>
  const openers = document.querySelectorAll("[data-open-alert]");

  const backdrop = document.getElementById("sbAlertBackdrop");
  const closeBtn = document.getElementById("sbAlertClose");
  const form = document.getElementById("sbSetAlertForm");

  const emailEl = document.getElementById("sbAlertEmail");
  const brandEl = document.getElementById("sbAlertBrand");
  const modelEl = document.getElementById("sbAlertModel");
  const priceEl = document.getElementById("sbAlertPrice");

  const brandSug = document.getElementById("sbBrandSug");
  const modelSug = document.getElementById("sbModelSug");

  const genderWrap = document.getElementById("sbGender");
  const btn = document.getElementById("sbSetAlertBtn");

  const status = document.getElementById("sbStatus");
  const confirmBox = document.getElementById("sbConfirm");
  const confirmDetails = document.getElementById("sbConfirmDetails");
  const setAnother = document.getElementById("sbSetAnother");

  const API_ALERTS = "/api/alerts";

  // ===== Brand/models data =====
  // brandModels.js (root) should define: window.brandModels = { ... }
  const brandModels = window.brandModels || {};
  const brands = Object.keys(brandModels).sort((a, b) => a.localeCompare(b));
  const allModels = (() => {
    const flat = [];
    for (const b of Object.keys(brandModels)) {
      const arr = brandModels[b];
      if (Array.isArray(arr)) flat.push(...arr);
    }
    return Array.from(new Set(flat)).sort((a, b) => a.localeCompare(b));
  })();

  // ===== Modal open/close =====
  let lastFocus = null;

  function openModal(prefillEmail) {
    lastFocus = document.activeElement;

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    // reset panels
    hideStatus();
    confirmBox.hidden = true;

    if (prefillEmail) emailEl.value = String(prefillEmail).trim().toLowerCase();

    // Target price now uses placeholder like "Enter whole dollars."
    // So we do NOT force "0" into it anymore.
    if (priceEl) priceEl.value = "";

    // clear any suggestions state (fresh open)
    closeSuggestions();

    setTimeout(() => (emailEl.value ? brandEl.focus() : emailEl.focus()), 0);
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    closeSuggestions();
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  openers.forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const emailFromQS = new URLSearchParams(location.search).get("email");
      openModal(emailFromQS);
    });
  });

  // Per your requirement: modal should ONLY close when hitting the close X
  closeBtn.addEventListener("click", closeModal);

  // ===== Gender (chips) =====
  let selectedGender = "both";
  genderWrap.addEventListener("click", (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) return;
    selectedGender = b.getAttribute("data-g") || "both";
    genderWrap.querySelectorAll(".sb-chip").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });

  // ===== Clear buttons =====
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-clear]");
    if (!c) return;
    // Only act when modal is open
    if (!backdrop.classList.contains("open")) return;

    e.preventDefault();

    const sel = c.getAttribute("data-clear");
    const input = sel ? document.querySelector(sel) : null;
    if (!input) return;

    input.value = "";
    hideStatus();
    confirmBox.hidden = true;

    // keep suggestions open behavior simple: only close if user clears that field
    if (input === brandEl) closeSuggestions("brand");
    if (input === modelEl) closeSuggestions("model");

    input.focus();
    toggleClear(brandEl);
    toggleClear(modelEl);
    togglePriceClear();
  });

  // ===== Price behavior: whole dollars only (no ".00" element anymore) =====
  function normalizeWholeDollars(v) {
    let s = String(v || "").replace(/[^0-9]/g, "");
    // collapse leading zeros unless it's the only digit
    s = s.replace(/^0+(?=\d)/, "");
    return s.slice(0, 4); // optional safety cap
  }

  function togglePriceClear() {
    const clear = backdrop.querySelector(".sb-clear-price");
    if (!clear) return;
    clear.style.display = priceEl.value.trim() ? "flex" : "none";
  }

  // Keep typing natural (caret starts at the front like normal inputs)
  priceEl.addEventListener("input", () => {
    const before = priceEl.value;
    priceEl.value = normalizeWholeDollars(before);
    togglePriceClear();
  });

  // block non-numeric keys (keeps mobile + desktop clean)
  priceEl.addEventListener("keypress", (e) => {
    if (e.key && !/[0-9]/.test(e.key)) e.preventDefault();
  });

  priceEl.addEventListener("focus", togglePriceClear);
  priceEl.addEventListener("blur", togglePriceClear);

  // ===== Suggestions =====
  const S = { open: null, items: [], idx: -1 };
  const norm = (s) => String(s || "").trim().toLowerCase();
  const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  function score(cand, q) {
    const c = String(cand || "");
    const cl = c.toLowerCase();
    q = String(q || "").trim().toLowerCase();
    if (!q) return 0;
    const cs = squash(c), qs = squash(q);
    let s = 0;
    if (cl.startsWith(q)) s += 120;
    if (cl.includes(q)) s += 80;
    if (qs.length >= 3 && cs.includes(qs)) s += 110;
    s -= Math.min(c.length, 30) * 0.25;
    return s;
  }

  function topMatches(list, typed, limit = 10) {
    const q = String(typed || "").trim();
    if (!q) return [];
    return list
      .map((v) => ({ v, s: score(v, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.v);
  }

  function renderSug(box, items, which, onPick) {
    box.innerHTML = "";
    if (!items.length) {
      box.hidden = true;
      if (S.open === which) S.open = null;
      return;
    }
    S.open = which;
    S.items = items;
    S.idx = -1;

    items.forEach((v) => {
      const d = document.createElement("div");
      d.className = "item";
      d.textContent = v;

      // use mousedown so it doesn't get killed by input blur on mobile
      d.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(v);
      });

      box.appendChild(d);
    });

    box.hidden = false;
  }

  function closeSuggestions(which) {
    if (!which || which === "brand") {
      brandSug.hidden = true;
      brandSug.innerHTML = "";
    }
    if (!which || which === "model") {
      modelSug.hidden = true;
      modelSug.innerHTML = "";
    }
    if (!which) {
      S.open = null; S.items = []; S.idx = -1;
    } else if (S.open === which) {
      S.open = null; S.items = []; S.idx = -1;
    }
  }

  function resolveBrandKey(input) {
    const n = norm(input);
    return brands.find((b) => norm(b) === n) || "";
  }

  brandEl.addEventListener("input", () => {
    const t = brandEl.value.trim();
    toggleClear(brandEl);
    if (!t) return closeSuggestions("brand");
    renderSug(brandSug, topMatches(brands, t, 12), "brand", (v) => {
      brandEl.value = v;
      toggleClear(brandEl);
      closeSuggestions("brand");
      setTimeout(() => modelEl.focus(), 0);
    });
  });

  modelEl.addEventListener("input", () => {
    const t = modelEl.value.trim();
    toggleClear(modelEl);
    if (!t) return closeSuggestions("model");

    const bk = resolveBrandKey(brandEl.value);
    const pool = (bk && Array.isArray(brandModels[bk])) ? brandModels[bk] : allModels;

    renderSug(modelSug, topMatches(pool, t, 12), "model", (v) => {
      modelEl.value = v;
      toggleClear(modelEl);
      closeSuggestions("model");
      setTimeout(() => priceEl.focus(), 0);
    });
  });

  function toggleClear(input) {
    const wrap = input.closest(".sb-input-wrap");
    if (!wrap) return;
    const c = wrap.querySelector(".sb-clear");
    if (!c) return;
    c.style.display = input.value.trim() ? "flex" : "none";
  }

  brandEl.addEventListener("focus", () => toggleClear(brandEl));
  modelEl.addEventListener("focus", () => toggleClear(modelEl));

  // IMPORTANT: We removed "click outside closes suggestions" entirely per your requirement.
  // Suggestions will close when:
  // - user picks a suggestion
  // - user clears that field
  // - modal closes via X

  // ===== API + submit =====
  let busy = false;

  function setBusy(v) {
    busy = v;
    btn.disabled = v;
    btn.textContent = v ? "Setting..." : "Set Alert";
  }

  function sanitize(str) {
    return String(str || "")
      .replace(/[<>'"]/g, "")
      .replace(/script/gi, "")
      .replace(/javascript:/gi, "")
      .replace(/on\w+=/gi, "")
      .trim()
      .slice(0, 100);
  }

  function showStatus(msg, ok = false) {
    status.hidden = false;
    status.className = "sb-status " + (ok ? "ok" : "err");
    status.textContent = msg;
  }
  function hideStatus() {
    status.hidden = true;
    status.textContent = "";
    status.className = "sb-status";
  }

  async function postJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}: Failed to create alert`);
    }
    return res.json();
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;

    hideStatus();
    confirmBox.hidden = true;

    const email = sanitize(emailEl.value).toLowerCase();
    const brand = sanitize(brandEl.value);
    const model = sanitize(modelEl.value);
    const targetPrice = parseInt(String(priceEl.value || ""), 10);
    const gender = selectedGender;

    if (!email || !email.includes("@")) return showStatus("Please enter a valid email address.");
    if (!brand) return showStatus("Please enter a shoe brand.");
    if (!model) return showStatus("Please enter a shoe model.");
    if (!targetPrice || targetPrice <= 0) return showStatus("Please enter a valid target price (whole dollars).");

    setBusy(true);
    try {
      await postJson(API_ALERTS, { email, brand, model, targetPrice, gender });

      const genderText = gender === "mens" ? "Men’s" : gender === "womens" ? "Women’s" : "Men’s or Women’s";
      confirmDetails.innerHTML =
        `<div><strong>Shoe:</strong> ${esc(brand)} ${esc(model)}</div>
         <div><strong>Gender:</strong> ${esc(genderText)}</div>
         <div><strong>Target Price:</strong> $${esc(String(targetPrice))} or less</div>`;

      confirmBox.hidden = false;

      // Clear fields (keep email + gender)
      brandEl.value = "";
      modelEl.value = "";
      priceEl.value = "";

      toggleClear(brandEl);
      toggleClear(modelEl);
      togglePriceClear();

      closeSuggestions();

    } catch (err) {
      console.error(err);
      showStatus(err.message || "Failed to set alert.");
    } finally {
      setBusy(false);
    }
  });

  setAnother.addEventListener("click", () => {
    confirmBox.hidden = true;
    hideStatus();

    brandEl.value = "";
    modelEl.value = "";
    priceEl.value = "";

    toggleClear(brandEl);
    toggleClear(modelEl);
    togglePriceClear();

    closeSuggestions();
    setTimeout(() => brandEl.focus(), 0);
  });

  // init clear state
  toggleClear(brandEl);
  toggleClear(modelEl);
  togglePriceClear();
})();
