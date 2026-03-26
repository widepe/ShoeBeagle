// Owns Saved Deals / Favorites state, persistence, and view wiring.
(() => {
  const SB = (window.SB = window.SB || {});
  SB.favorites = SB.favorites || {};
  if (SB.legacyInline) return;

  const STORAGE_FAVORITES = "sb-favorites-v1";
  let isShowingFavorites = false;
  let favoriteItems = loadFavoriteItems();

  function app() {
    return SB.app || {};
  }

  function favoriteKeyForItem(item) {
    const listing = String(item?.listingURL || "").trim();
    if (listing) return listing;
    return [
      String(item?.store || "").trim(),
      String(item?.brand || "").trim(),
      String(item?.model || "").trim(),
      String(item?.salePrice ?? "").trim(),
      String(item?.imageURL || "").trim(),
    ].join("|");
  }

  function loadFavoriteItems() {
    try {
      const raw = localStorage.getItem(STORAGE_FAVORITES);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
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
    if (!item || isFavoriteItem(item)) return;
    favoriteItems.unshift(item);
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

  function showSaveToast(message) {
    const el = document.getElementById("saveToast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => {
        el.hidden = true;
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
