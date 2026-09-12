/**
 * WatchThemAll — Recommendation Engine v2
 * Large candidate pool, diverse categories, endless scroll with IMDB fallback.
 */
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TVMAZE = 'https://api.tvmaze.com';
const CONCURRENCY = 4;
const CACHE_TTL = 60 * 60 * 1000;
const ROWS_PER_CATEGORY = 100;
const PER_ROW_BATCH = 20;
const TVMAZE_PAGES = 20;
const IMDB_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const opts = { headers: { 'User-Agent': 'WatchThemAll/1.0', 'Accept': 'application/json' }, timeout: 8000 };
    get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

class RecommendationEngine {

  constructor(userData, cacheDir) {
    this.bookmarks = userData.bookmarks || [];
    this.watchlist = userData.watchlist || [];
    this.history = userData.history || [];
    this.cacheDir = cacheDir;
    this.cacheFile = path.join(cacheDir, 'recommendations_cache.json');
    this._allRanked = null;
    this._page = 0;
    this._imdbLetter = 0;
  }

  async buildProfile() {
    const genreCount = {}, networks = {};
    let ratingSum = 0, ratingCount = 0;
    const knownIds = new Set();
    const items = [];
    for (const bm of this.bookmarks) {
      if (bm.imdb) items.push({ imdb: bm.imdb, name: bm.name, type: 'bookmark' });
    }
    for (const w of this.watchlist) {
      if (w.showId && !knownIds.has(w.showId)) {
        items.push({ showId: w.showId, name: w.name, type: 'watchlist' });
        knownIds.add(w.showId);
      }
    }
    let idx = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (idx < items.length) {
        const i = idx++, item = items[i];
        try {
          let show;
          if (item.showId) show = await fetchJSON(TVMAZE + '/shows/' + item.showId);
          else show = await fetchJSON(TVMAZE + '/lookup/shows?imdb=' + item.imdb);
          if (show && show.genres) {
            for (const g of show.genres) genreCount[g] = (genreCount[g] || 0) + 1;
            const net = (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '';
            if (net) networks[net] = (networks[net] || 0) + 1;
            if (show.rating && show.rating.average) { ratingSum += show.rating.average; ratingCount++; }
          }
        } catch (e) {}
      }
    });
    await Promise.all(workers);
    const sortedGenres = Object.entries(genreCount).sort((a,b) => b[1] - a[1]).slice(0,5).map(e => e[0]);
    const sortedNetworks = Object.entries(networks).sort((a,b) => b[1] - a[1]).slice(0,3).map(e => e[0]);
    const avgRating = ratingCount > 0 ? ratingSum / ratingCount : 7.0;
    this.profile = { genres: sortedGenres, topGenre: sortedGenres[0] || '', networks: sortedNetworks, avgRating, hasData: true };
    this.bookmarkedIds = new Set();
    for (const bm of this.bookmarks) { if (bm.imdb) this.bookmarkedIds.add(bm.imdb); }
    for (const w of this.watchlist) { if (w.imdb) this.bookmarkedIds.add(w.imdb); }
    return this.profile;
  }

  async fetchCandidates() {
    const candidates = [], seen = new Set();
    const addCandidate = (show) => {
      if (!show || !show.id || seen.has(show.id) || !show.name) return;
      if (show.externals && show.externals.imdb && this.bookmarkedIds.has(show.externals.imdb)) return;
      seen.add(show.id);
      candidates.push({
        showId: show.id, name: show.name,
        genres: show.genres || [],
        rating: (show.rating && show.rating.average) || 0,
        status: show.status || 'Unknown',
        network: (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || '',
        imageUrl: (show.image && show.image.medium) || null,
        premiered: show.premiered || '', language: show.language || '',
        weight: show.weight || 50
      });
    };
    try {
      const schedule = await fetchJSON(TVMAZE + '/schedule/full');
      for (const entry of schedule) {
        const show = entry._embedded ? entry._embedded.show : entry.show;
        if (show) addCandidate(show);
      }
    } catch (e) {}
    for (let page = 0; page < TVMAZE_PAGES; page++) {
      try {
        const shows = await fetchJSON(TVMAZE + '/shows?page=' + page);
        for (const show of shows) addCandidate(show);
      } catch (e) { break; }
    }
    const broadGenres = ['Drama','Comedy','Action','Thriller','Science-Fiction','Horror','Crime','Fantasy','Romance','Mystery'];
    for (const genre of broadGenres) {
      try {
        const results = await fetchJSON(TVMAZE + '/search/shows?q=' + encodeURIComponent(genre));
        for (const r of (results || [])) { if (r.show) addCandidate(r.show); }
      } catch (e) {}
    }
    this.candidates = candidates;
    return candidates;
  }

  score(show) {
    if (!this.profile) return 0;
    const p = this.profile;
    let genreOverlap = 0;
    if (show.genres && p.genres) {
      for (const g of show.genres) {
        const idx = p.genres.indexOf(g);
        if (idx >= 0) genreOverlap += (5 - idx);
      }
    }
    const statusBonus = show.status === 'Running' ? 3 : show.status === 'In Development' ? 2 : 1;
    const ratingDiff = show.rating > 0 ? Math.abs(show.rating - p.avgRating) : 3;
    const ratingScore = Math.max(0, 5 - ratingDiff);
    const popularityScore = Math.min(5, (show.weight || 50) / 20);
    const networkScore = show.network && p.networks.includes(show.network) ? 2 : 0;
    return genreOverlap * 3 + statusBonus * 2 + ratingScore + popularityScore + networkScore;
  }

  rank() {
    if (!this.candidates) return [];
    for (const c of this.candidates) c._score = this.score(c);
    this.candidates.sort((a, b) => b._score - a._score);
    const maxScore = this.candidates.length > 0 ? this.candidates[0]._score : 1;
    if (maxScore > 0) for (const c of this.candidates) c._score = Math.round((c._score / maxScore) * 100);
    this._allRanked = this.candidates;
    this._page = 0;
    return this.candidates;
  }

  categorize() {
    const ranked = this.rank();
    const rows = [];
    const usedIds = new Set();
    const addRow = (category, filter, limit) => {
      const items = [];
      for (const s of ranked) {
        if (items.length >= (limit || ROWS_PER_CATEGORY)) break;
        if (filter(s) && !usedIds.has(s.showId)) { items.push(s); usedIds.add(s.showId); }
      }
      for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
      if (items.length >= 3) rows.push({ category, shows: items });
    };
    const currentYear = new Date().getFullYear();
    if (this.profile && this.profile.genres.length > 0) {
      addRow('Because you like ' + this.profile.genres[0], s => s.genres && s.genres.includes(this.profile.genres[0]));
    }
    addRow('Trending Now', s => s.status === 'Running' && s._score >= 5);
    addRow('Popular Classics', s => s.weight >= 70 && s.rating >= 7.0);
    addRow('New & Upcoming', s => s.premiered && parseInt(s.premiered) >= currentYear - 1);
    addRow('Critically Acclaimed', s => s.rating >= 8.0);
    addRow('Hidden Gems', s => s.rating >= 7.0 && s.weight < 70 && s.status !== 'Ended');
    const remaining = [];
    for (const s of ranked) { if (!usedIds.has(s.showId)) { remaining.push(s); usedIds.add(s.showId); } }
    for (let i = remaining.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [remaining[i], remaining[j]] = [remaining[j], remaining[i]]; }
    if (remaining.length >= 3) rows.push({ category: 'Random Discoveries', shows: remaining.slice(0, ROWS_PER_CATEGORY) });
    this.rows = rows;
    return rows;
  }

  async fetchImdbCandidates(letterIdx) {
    const candidates = [];
    const letters = IMDB_LETTERS.slice(letterIdx, letterIdx + 5);
    for (const letter of letters) {
      try {
        const data = await fetchJSON('https://v3.sg.media-imdb.com/suggestion/x/' + letter + '.json');
        if (data && data.d) {
          for (const item of data.d) {
            if (!item.id || !item.l) continue;
            if (!(item.qid && /^tv/i.test(item.qid))) continue;
            const imdb = item.id;
            if (this.bookmarkedIds && this.bookmarkedIds.has(imdb)) continue;
            candidates.push({
              showId: null, imdbId: imdb, name: item.l,
              genres: [], rating: 0, status: 'Unknown',
              network: '', imageUrl: item.i ? item.i.imageUrl : null,
              premiered: item.y ? String(item.y) : '', language: '',
              weight: item.rank || 50
            });
          }
        }
      } catch (e) {}
    }
    return candidates;
  }

  async getMoreRecommendations(count) {
    count = count || ROWS_PER_CATEGORY;
    const results = [];
    if (this._allRanked && this._allRanked.length > 0) {
      while (results.length < count && this._page * ROWS_PER_CATEGORY < this._allRanked.length) {
        const start = this._page * ROWS_PER_CATEGORY;
        const batch = this._allRanked.slice(start, start + ROWS_PER_CATEGORY);
        for (const s of batch) { if (results.length >= count) break; results.push(s); }
        this._page++;
      }
    }
    if (results.length < count) {
      const imdbCandidates = await this.fetchImdbCandidates(this._imdbLetter);
      this._imdbLetter = (this._imdbLetter + 5) % IMDB_LETTERS.length;
      for (let i = imdbCandidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [imdbCandidates[i], imdbCandidates[j]] = [imdbCandidates[j], imdbCandidates[i]]; }
      for (const c of imdbCandidates) { if (results.length >= count) break; results.push(c); }
    }
    return { shows: results, category: 'More to Explore', hasMore: true };
  }

  async getRecommendations() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const cached = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        if (cached.timestamp && (Date.now() - cached.timestamp) < CACHE_TTL) {
          const currentHash = this._dataHash();
          if (cached.dataHash === currentHash) {
            this.rows = cached.rows; this.profile = cached.profile;
            this._allRanked = cached.allRanked || null;
            return { rows: this.rows, profile: this.profile, allRanked: this._allRanked, cached: true };
          }
        }
      }
    } catch (e) {}
    try {
      await this.buildProfile();
      await this.fetchCandidates();
      this.categorize();
    } catch (e) { return { rows: [], profile: null, error: e.message, cached: false }; }
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        dataHash: this._dataHash(), timestamp: Date.now(),
        profile: this.profile, rows: this.rows, allRanked: this._allRanked
      }));
    } catch (e) {}
    return { rows: this.rows, profile: this.profile, allRanked: this._allRanked, cached: false };
  }

  _dataHash() {
    const ids = [];
    for (const bm of this.bookmarks) ids.push(bm.imdb || bm.id);
    for (const w of this.watchlist) ids.push(w.imdb || w.watchId);
    return ids.sort().join(',');
  }
}

module.exports = { RecommendationEngine };
