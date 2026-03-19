(() => {
  const track = document.getElementById('rssTrack');
  const prevBtn = document.getElementById('rssPrevBtn');
  const nextBtn = document.getElementById('rssNextBtn');

  if (!track || !prevBtn || !nextBtn) return;

  const PLACEHOLDER_IMG = '/images/rss-images/image_placeholder.svg';
  const SOURCE_DEFAULT_IMG = {
    iRunFar: '/images/rss-images/i_run_far.svg',
    'Runners Connect': '/images/rss-images/runners_connect.svg',
    'Steve Magness': '/images/rss-images/steve_magness.svg',
    'Track & Field News': '/images/rss-images/track_and_field_news.svg',
    'Believe In The Run': '/images/rss-images/believe_in_the_run.svg',
    'Marathon Handbook': '/images/rss-images/marathon_handbook.svg',
    Run: '/images/rss-images/run.svg',
    'Running Shoes Guru': '/images/rss-images/running_shoes_guru.svg',
  };

  const setButtons = (disabled) => {
    prevBtn.disabled = disabled;
    nextBtn.disabled = disabled;
  };

  const formatDate = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getImageForItem = (item) => {
    if (item && typeof item.imageUrl === 'string' && item.imageUrl.trim()) {
      return { url: item.imageUrl.trim(), logo: false };
    }

    const source = (item && typeof item.source === 'string' && item.source.trim()) || '';
    if (source && SOURCE_DEFAULT_IMG[source]) {
      return { url: SOURCE_DEFAULT_IMG[source], logo: true };
    }

    return { url: PLACEHOLDER_IMG, logo: true };
  };

  const safeUrl = (url) => {
    if (typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {
      return null;
    }

    return null;
  };

const makeCard = (item) => {
  const article = document.createElement('article');
  article.className = 'rss-card';

  const row = document.createElement('div');
  row.className = 'rss-row';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'rss-thumbWrap';

  const image = document.createElement('img');
  const pickedImage = getImageForItem(item);
  image.className = `rss-thumb${pickedImage.logo ? ' is-logo' : ''}`;
  image.src = pickedImage.url;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    image.src = PLACEHOLDER_IMG;
    image.classList.add('is-logo');
  });

  const content = document.createElement('div');
  content.className = 'rss-content';

  const title = document.createElement('h3');
  title.className = 'rss-title';

  const titleLink = document.createElement('a');
  const articleUrl = safeUrl(item.link);
  titleLink.href = articleUrl || '#';
  titleLink.target = '_blank';
  titleLink.rel = 'noopener';
  titleLink.textContent = (item.title || '').trim() || 'Untitled article';

  if (!articleUrl) {
    titleLink.removeAttribute('target');
    titleLink.removeAttribute('rel');
    titleLink.setAttribute('aria-disabled', 'true');
    titleLink.addEventListener('click', (event) => event.preventDefault());
  }

  title.appendChild(titleLink);
  content.appendChild(title);

  const publishedText = formatDate(item.publishedAt);
  if (publishedText) {
    const published = document.createElement('div');
    published.className = 'rss-date';
    published.textContent = publishedText;
    content.appendChild(published);
  }

  const descText = (item.description || '').trim();
  if (descText) {
    const desc = document.createElement('p');
    desc.className = 'rss-desc';
    desc.textContent = descText;
    content.appendChild(desc);
  }

  const linkRow = document.createElement('div');
  linkRow.className = 'rss-linkRow';

  const source = document.createElement('span');
  source.className = 'rss-tabNote';
  source.textContent = (item.source || '').trim() || 'Unknown source';

  const readLink = document.createElement('a');
  readLink.textContent = 'Read →';
  readLink.href = articleUrl || '#';

  if (articleUrl) {
    readLink.target = '_blank';
    readLink.rel = 'noopener';
  } else {
    readLink.setAttribute('aria-disabled', 'true');
    readLink.addEventListener('click', (event) => event.preventDefault());
  }

  linkRow.append(source, readLink);

  thumbWrap.appendChild(image);
  thumbWrap.appendChild(linkRow);

  row.append(thumbWrap, content);
  article.append(row);

  return article;
};

  const renderState = (message) => {
    track.textContent = '';
    const state = document.createElement('div');
    state.className = 'rss-state';
    state.textContent = message;
    track.appendChild(state);
    setButtons(true);
  };

  const updateButtons = () => {
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    const atStart = track.scrollLeft <= 2;
    const atEnd = track.scrollLeft >= maxScroll - 2;

    prevBtn.disabled = atStart;
    nextBtn.disabled = maxScroll <= 2 || atEnd;
  };

  const getStepSize = () => {
    const firstCard = track.querySelector('.rss-card');
    if (!firstCard) return 0;

    const trackStyle = window.getComputedStyle(track);
    const gap = parseFloat(trackStyle.columnGap || trackStyle.gap || '0') || 0;
    return firstCard.getBoundingClientRect().width + gap;
  };

  const scrollByCard = (direction) => {
    const step = getStepSize();
    if (!step) return;

    track.scrollBy({
      left: direction * step,
      behavior: 'smooth',
    });
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      updateButtons();
      ticking = false;
    });
  };

  prevBtn.addEventListener('click', () => scrollByCard(-1));
  nextBtn.addEventListener('click', () => scrollByCard(1));
  track.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  const loadFeed = async () => {
    renderState('Loading recent articles…');

    try {
      const response = await fetch('/api/running-news?limit=24', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Feed request failed (${response.status})`);

      const payload = await response.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];

      if (!items.length) {
        renderState('No recent articles right now.');
        return;
      }

      const fragment = document.createDocumentFragment();
      items.forEach((item) => {
        if (item && typeof item === 'object') fragment.appendChild(makeCard(item));
      });

      if (!fragment.childNodes.length) {
        renderState('No recent articles right now.');
        return;
      }

      track.textContent = '';
      track.appendChild(fragment);
      updateButtons();
    } catch {
      renderState('Failed to load recent articles. Please try again later.');
    }
  };

  loadFeed();
})();
