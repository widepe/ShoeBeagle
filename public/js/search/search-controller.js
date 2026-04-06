// Owns query input, suggestions, command parsing, and /api/search request flow.
(() => {
  const SB = (window.SB = window.SB || {});
  SB.search = SB.search || {};
  if (SB.legacyInline) return;
  const app = () => SB.app || {};
  const qInput = document.getElementById("q");
  const qSuggestions = document.getElementById("qSuggestions");
  const form = document.getElementById("search-form");
  const fetchBtn = document.getElementById("fetchBtn");
  if (!qInput || !form) return;

  const dealsSuggest = () => app().dealsSuggest;
  const suggestionState = { open: false, items: [], activeIndex: -1, mode: "model" };
  let pickingSuggestion = false;

  const squashStr = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalizeQueryForCommand = (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");

  function updateFetchReady() {
    const hasAny = !!qInput.value.trim();
    if (fetchBtn) fetchBtn.setAttribute("aria-disabled", hasAny ? "false" : "true");
  }

  function extractInlineFilters(q) {
    const tokens = q.split(" ");
    let gender = "", surface = "";
    tokens.forEach((t) => {
      if (["mens", "men", "man's", "mans"].includes(t)) gender = "mens";
      if (["womens", "women", "woman", "womans"].includes(t)) gender = "womens";
      if (t === "trail") surface = "trail";
      if (t === "road") surface = "road";
      if (t === "track") surface = "track";
      if (t === "xc") surface = "xc";
    });
    return { gender, surface };
  }

  function getCommandAction(rawQuery) {
    const q = normalizeQueryForCommand(rawQuery).replace(/-/g, " ");
    if (["all", "all deals", "all shoes"].includes(q)) return { type: "mode", mode: "all" };
    if (["daily", "daily deals"].includes(q)) return { type: "mode", mode: "daily" };
    if (["favs", "favorites", "saved", "saved deals"].includes(q)) return { type: "mode", mode: "favorites" };
    if (["price alert", "shoe price alert", "running shoe price alert"].includes(q)) return { type: "modal", modal: "priceAlert" };
    if (["mens", "men's", "men", "mens shoes", "men's shoes", "men shoes", "man", "man's", "mans", "man's shoes", "mans shoes"].includes(q)) return { type: "term", term: "mens" };
    if (["womens", "women's", "women", "womens shoes", "women's shoes", "women shoes", "woman", "woman's", "womans", "woman's shoes", "womans shoes"].includes(q)) return { type: "term", term: "womens" };
    if (["trail", "trail shoes", "trail running", "trail running shoes"].includes(q)) return { type: "term", term: "trail" };
    if (["road", "road shoes", "road running", "road running shoes"].includes(q)) return { type: "term", term: "road" };
    if (["track", "track shoes", "track running", "track running shoes"].includes(q)) return { type: "term", term: "track" };
    if (["xc", "xc shoes", "cross country", "cross country shoes"].includes(q)) return { type: "term", term: "xc" };
    return null;
  }

  function applyTermFilters(termKey) {
    app().setSelectedGender(""); app().setSelectedStore(""); app().setSelectedPriceMin(1); app().setSelectedPriceMax(400); app().setCurrentSort("");
    if (termKey === "mens") { app().setSelectedGender("mens"); app().setSelectedShoeType(""); }
    else if (termKey === "womens") { app().setSelectedGender("womens"); app().setSelectedShoeType(""); }
    else if (["trail", "road", "track", "xc"].includes(termKey)) app().setSelectedShoeType(termKey);
    else app().setSelectedShoeType("");
  }

  async function runApiSearch(displayQuery) {
    const res = await fetch("/api/search?" + new URLSearchParams({ query: displayQuery }));
    return res.json();
  }

  function closeSuggestions() { if (!qSuggestions) return; qSuggestions.style.display = "none"; qSuggestions.innerHTML = ""; suggestionState.open = false; suggestionState.items = []; suggestionState.activeIndex = -1; suggestionState.mode = "model"; }
  function dedupeSuggestionItems(items) { const out = [], seen = new Set(); for (const v of items || []) { const key = squashStr(String(v || "")); if (!key || seen.has(key)) continue; seen.add(key); out.push(v); } return out; }
  function highlightActive() { const children = Array.from(qSuggestions?.querySelectorAll(".suggestion-item") || []); children.forEach((el) => el.classList.remove("active")); if (suggestionState.activeIndex >= 0 && suggestionState.activeIndex < children.length) { const active = children[suggestionState.activeIndex]; active.classList.add("active"); const box = qSuggestions; const top = active.offsetTop; const bottom = top + active.offsetHeight; if (top < box.scrollTop) box.scrollTop = top; else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight; } }
  function handleSuggestionKeys(e, onPick) { if (!suggestionState.open || !suggestionState.items.length) return; const max = suggestionState.items.length; if (e.key === "ArrowDown") { e.preventDefault(); suggestionState.activeIndex = (suggestionState.activeIndex + 1) % max; return highlightActive(); } if (e.key === "ArrowUp") { e.preventDefault(); suggestionState.activeIndex = (suggestionState.activeIndex - 1 + max) % max; return highlightActive(); } if (e.key === "Enter" && suggestionState.activeIndex >= 0) { e.preventDefault(); return onPick(suggestionState.items[suggestionState.activeIndex]); } if (e.key === "Escape") { e.preventDefault(); closeSuggestions(); } }
  function renderSuggestions(items, onPick) {
    if (!qSuggestions) return; qSuggestions.innerHTML = "";
    if (!items.length) return closeSuggestions();
    suggestionState.open = true; suggestionState.items = items.slice(); suggestionState.activeIndex = -1;
    const typedQuery = String(qInput.value || "").trim();
    items.forEach((value, idx) => {
      const div = document.createElement("div"); div.className = "suggestion-item";
      const isPrefix = value.toLowerCase().startsWith(typedQuery.toLowerCase());
      const strong = document.createElement("span"); strong.className = "suggestion-match"; strong.textContent = isPrefix ? value.slice(0, typedQuery.length) : value; div.appendChild(strong);
      if (isPrefix && value.slice(typedQuery.length)) { const light = document.createElement("span"); light.className = "suggestion-rest"; light.textContent = value.slice(typedQuery.length); div.appendChild(light); }
      div.dataset.index = String(idx);
      const choose = (e) => { e.preventDefault(); e.stopPropagation(); pickingSuggestion = true; setTimeout(() => { pickingSuggestion = false; }, 0); onPick(value); };
      div.addEventListener("pointerdown", choose); div.addEventListener("click", choose); qSuggestions.appendChild(div);
    });
    qSuggestions.style.display = "block";
  }

  function applySuggestionAndSearch(value) {
    const bm = app().splitBrandModelFromPicked(value);
    qInput.value = (bm.brand && bm.model) ? `${bm.brand} ${bm.model}`.trim() : String(value || "").trim();
    closeSuggestions(); updateFetchReady(); if (fetchBtn) fetchBtn.setAttribute("aria-disabled", "false");
    setTimeout(() => form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })), 0);
  }

  async function handleSearch() {
    const rawQuery = qInput.value.trim();
    const normalizedQuery = normalizeQueryForCommand(rawQuery).replace(/-/g, " ");
    const inlineFilters = extractInlineFilters(normalizedQuery);
    const command = getCommandAction(rawQuery);
    updateFetchReady();

    if (command) {
      if (command.type === "mode") {
        if (command.mode === "all") return app().renderAllDealsView({ resetPage: true, append: false });
        if (command.mode === "daily") return app().renderDailyDealsView({ resetPage: true, append: false });
        if (command.mode === "favorites") return SB.favorites.renderFavoritesView({ resetPage: true, append: false });
      }
      if (command.type === "modal") return SB.alerts?.openPriceAlert?.();
      if (command.type === "term") {
        SB.favorites.exitFavoritesView();
        app().setCurrentSearch({ brand: "", model: "" });
        app().setLastSearchResults((app().getLastAllDeals() || []).slice());
        applyTermFilters(command.term);
        if (app().dailyDeals) app().dailyDeals.style.display = "none";
        app().syncPanelControls();
        return app().renderFilteredResults({ resetPage: true, append: false });
      }
    }

    let typedRaw = app().sanitizeInput(qInput.value).replace(/\b(mens|men|mans|womens|women|womans|trail|road|track|xc)\b/g, "").trim();
    if (!typedRaw) { app().setStatusSummary("Please enter a brand and/or a model."); app().setStatusMeta([]); app().setStatusSortVisibility(false); return; }

    let { brand, model } = app().splitBrandModelFromPicked(typedRaw);
    if (inlineFilters.gender) app().setSelectedGender(inlineFilters.gender);
    if (inlineFilters.surface) app().setSelectedShoeType(inlineFilters.surface);

    if (!brand && model && dealsSuggest()?.ready) {
      const exactBrand = dealsSuggest().modelNormToBrandDisplay.get(app().normalizeStr(model)) || "";
      const inferred = exactBrand || app().inferDefinitiveBrandFromPartialModel(model);
      if (inferred) brand = inferred;
    }
    if (brand) brand = app().resolveClosestBrand(brand);
    const displayQuery = [brand, model].filter(Boolean).join(" ").trim();
    if (!displayQuery) { app().setStatusSummary("Please enter a brand and/or a model."); app().setStatusMeta([]); app().setStatusSortVisibility(false); return; }

    app().setCurrentSearch({ brand, model });
    app().setStatusSummary("Searching deals…"); app().setStatusMeta([]); app().setStatusSortVisibility(true);
    app().resultsEl.innerHTML = ""; document.querySelector(".pager")?.style && (document.querySelector(".pager").style.display = "none");
    if (app().loadMoreWrap) app().loadMoreWrap.style.display = "none"; if (app().dailyDeals) app().dailyDeals.style.display = "none";

    let data;
    try { data = await runApiSearch(displayQuery); } catch (err) { console.error("Search error:", err); app().setStatusSummary("Search failed. Please try again."); app().setStatusMeta([]); app().setStatusSortVisibility(true); if (app().dailyDeals) app().dailyDeals.style.display = "block"; return; }

    const results = data?.results || [];
    app().setLastSearchResults(results);
    app().syncPanelControls();
    if (!results.length) { app().setStatusSummary(`No results found for ${displayQuery}`); app().setStatusMeta([]); app().setStatusSortVisibility(true); if (app().dailyDeals) app().dailyDeals.style.display = "block"; return; }
    app().renderFilteredResults({ resetPage: true, append: false });
  }

  qInput.addEventListener("input", () => {
    const typed = qInput.value.trim();
    if (!typed || !dealsSuggest()?.ready) { closeSuggestions(); return updateFetchReady(); }
    const built = app().buildUnifiedSuggestions(typed);
    suggestionState.mode = built.mode;
    renderSuggestions(dedupeSuggestionItems(built.items), (value) => applySuggestionAndSearch(value));
    updateFetchReady();
  });
  qInput.addEventListener("keydown", (e) => handleSuggestionKeys(e, (value) => applySuggestionAndSearch(value)));
  qInput.addEventListener("blur", () => setTimeout(() => { if (!pickingSuggestion) closeSuggestions(); }, 140));
  qInput.addEventListener("click", () => qInput.select());
  document.addEventListener("click", (e) => { const inside = (qSuggestions && qSuggestions.contains(e.target)) || qInput.contains(e.target); if (!inside) closeSuggestions(); });
  form.addEventListener("submit", async (e) => { e.preventDefault(); closeSuggestions(); await handleSearch(); });
  qInput.addEventListener("input", updateFetchReady);
  updateFetchReady();

  Object.assign(SB.search, { handleSearch, runApiSearch, getCommandAction, applyTermFilters });
})();
