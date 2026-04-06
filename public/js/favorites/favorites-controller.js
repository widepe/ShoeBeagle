// Owns Saved Deals / Favorites state, persistence, and view wiring.
(() => {
  const SB = (window.SB = window.SB || {});
  SB.favorites = SB.favorites || {};
  if (SB.legacyInline) return;

  const STORAGE_FAVORITES = "sb-favorites";
  let isShowingFavorites = false;
  let favoriteItems = loadFavoriteItems();

  function app() {
    return SB.app || {};
  }

  function normalizeText(value) { return String(value || "").trim().toLowerCase(); }
  function normalizeListingURL(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.origin);
      return `${url.origin}${url.pathname}`.toLowerCase();
    } catch {
      return raw.split("?")[0].trim().toLowerCase();
    }
  }
  function buildFavoriteMatchKey(item) {
    return [normalizeText(item?.store), normalizeText(item?.brand), normalizeText(item?.model), normalizeText(item?.gender)].join("|");
  }
  function favoriteKeyForItem(item) { return `${buildFavoriteMatchKey(item)}|${normalizeListingURL(item?.listingURL)}`; }
  function toSavedFavoriteShape(item) {
    return {
      brand: item?.brand ?? "",
      model: item?.model ?? "",
      salePrice: item?.salePrice ?? null,
      originalPrice: item?.originalPrice ?? null,
      discountPercent: item?.discountPercent ?? null,
      salePriceLow: item?.salePriceLow ?? null,
      salePriceHigh: item?.salePriceHigh ?? null,
      originalPriceLow: item?.originalPriceLow ?? null,
      originalPriceHigh: item?.originalPriceHigh ?? null,
      discountPercentUpTo: item?.discountPercentUpTo ?? null,
      store: item?.store ?? "",
      listingURL: item?.listingURL ?? "",
      imageURL: item?.imageURL ?? "",
      gender: item?.gender ?? "",
      shoeType: item?.shoeType ?? "",
    };
  }

  function loadFavoriteItems() {
    try {
      const raw = localStorage.getItem(STORAGE_FAVORITES);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(Boolean).map(toSavedFavoriteShape);
    } catch {
      return [];
    }
  }

  function saveFavoriteItems() {
    try {
      localStorage.setItem(STORAGE_FAVORITES, JSON.stringify(favoriteItems));
    } catch (err) {
      console.error("Failed saving favorites:", err);
    }
  }

  function isFavoriteItem(item) {
    const key = favoriteKeyForItem(item);
    return favoriteItems.some((fav) => favoriteKeyForItem(fav) === key);
  }

  function addFavoriteItem(item) {
    if (!item) return;
    const favorite = toSavedFavoriteShape(item);
    if (isFavoriteItem(favorite)) return;
    favoriteItems.unshift(favorite);
    saveFavoriteItems();
  }

  function removeFavoriteItem(item) {
    const key = favoriteKeyForItem(item);
    favoriteItems = favoriteItems.filter((fav) => favoriteKeyForItem(fav) !== key);
    saveFavoriteItems();
  }

  function toggleFavoriteItem(item) {
    if (isFavoriteItem(item)) {
      removeFavoriteItem(item);
      return false;
    }
    addFavoriteItem(item);
    return true;
  }

  function showSaveToast(message, anchorEl) {
    const el = document.getElementById("saveToast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const toastRect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const aboveY = rect.top - 10;
      const belowY = rect.bottom + 10;
      const fitsAbove = aboveY - toastRect.height > 0;
      el.style.position = "fixed";
      el.style.left = Math.max(8, Math.min(cx - toastRect.width / 2, window.innerWidth - toastRect.width - 8)) + "px";
      el.style.top = (fitsAbove ? aboveY - toastRect.height : belowY) + "px";
      el.style.bottom = "auto";
      el.style.transform = "none";
    } else {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.bottom = "";
      el.style.transform = "";
    }

    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => {
        el.hidden = true;
        el.style.position = "";
        el.style.left = "";
        el.style.top = "";
        el.style.bottom = "";
        el.style.transform = "";
      }, 160);
    }, 1200);
  }

  function getFavoriteItemsForDisplay() {
    return app().getFilteredAndSorted?.(favoriteItems || [], { skipFilters: true }) || [];
  }

  function renderFavoritesView({ resetPage = true, append = false } = {}) {
    if (resetPage) app().setPageIndex?.(0);
    isShowingFavorites = true;

    app().syncDisplayPageLinksUI?.();
    app().syncFavoritesFilterLockUI?.();

    if (app().dailyDeals) app().dailyDeals.style.display = "none";

    const filtered = getFavoriteItemsForDisplay();
    const pageSize = app().getPageSize?.() || 12;
    const start = (app().getPageIndex?.() || 0) * pageSize;
    const slice = filtered.slice(start, start + pageSize);

    const resultsEl = app().resultsEl;
    if (!resultsEl) return;
    if (!append) resultsEl.innerHTML = "";
    slice.forEach((item) => resultsEl.appendChild(app().createDealCard(item)));

    app().updateNavUI?.(filtered.length);
    app().updateStatusBar?.({
      showingDailyDeals: false,
      showingFavorites: true,
      totalBeforeFilters: favoriteItems.length,
      filteredTotal: filtered.length,
    });
  }

  function exitFavoritesView() {
    isShowingFavorites = false;
    app().syncDisplayPageLinksUI?.();
    app().syncFavoritesFilterLockUI?.();
  }

  function bindTopbar() {
    const favsLink = document.getElementById("favsLink");
    if (!favsLink || favsLink.dataset.sbFavBound === "1") return;
    favsLink.dataset.sbFavBound = "1";
    favsLink.addEventListener("click", (e) => {
      e.preventDefault();
      renderFavoritesView({ resetPage: true, append: false });
    });
  }

  Object.assign(SB.favorites, {
    STORAGE_FAVORITES,
    favoriteKeyForItem,
    loadFavoriteItems,
    saveFavoriteItems,
    isFavoriteItem,
    addFavoriteItem,
    removeFavoriteItem,
    toggleFavoriteItem,
    getFavoriteItemsForDisplay,
    renderFavoritesView,
    exitFavoritesView,
    showSaveToast,
    isShowingFavorites: () => isShowingFavorites,
    getItems: () => favoriteItems.slice(),
  });

  bindTopbar();
})();
