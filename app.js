const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" 
    ? "http://localhost:5002/api" 
    : "/api";
let currentAnime = null;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const resultsGrid = document.getElementById('resultsGrid');
const searchLoader = document.getElementById('search-loader');
const epLoader = document.getElementById('ep-loader');

const viewSearch = document.getElementById('view-search');
const viewPlayer = document.getElementById('view-player');
const backToSearch = document.getElementById('backToSearch');
const playerTitle = document.getElementById('playerTitle');
const playerSubtitle = document.getElementById('playerSubtitle');
const episodesList = document.getElementById('episodesList');
const resultCount = document.getElementById('resultCount');
const toast = document.getElementById('toast');
const quickHomeBtn = document.getElementById('quickHomeBtn');
const heroDesc = document.getElementById('hero-desc');
const heroBadge = document.getElementById('hero-badge');
const heroSecondaryBtn = document.getElementById('hero-secondary-btn');
const heroMetaType = document.getElementById('hero-meta-type');
const heroMetaLang = document.getElementById('hero-meta-lang');
const heroMetaQuality = document.getElementById('hero-meta-quality');
const prevEpBtn = document.getElementById('prevEpBtn');
const nextEpBtn = document.getElementById('nextEpBtn');
const episodeSearch = document.getElementById('episodeSearch');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const autocompleteList = document.getElementById('autocompleteList');
const matchMode = document.getElementById('matchMode');
const sortMode = document.getElementById('sortMode');
const resultLimit = document.getElementById('resultLimit');
const posterOnly = document.getElementById('posterOnly');

// Event Listeners
let currentEp = null;
let allEpisodes = [];
let currentEpIndex = -1;
let searchTimer = null;
let latestSearchSeq = 0;
let discoveryPool = [];
searchBtn.addEventListener('click', () => performSearch(searchInput.value));
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        performSearch(searchInput.value);
    }
});
searchInput.addEventListener('input', handleRealtimeSearch);
document.getElementById('logoBtn').addEventListener('click', goHome);
quickHomeBtn.addEventListener('click', goHome);
prevEpBtn.addEventListener('click', () => jumpEpisode(-1));
nextEpBtn.addEventListener('click', () => jumpEpisode(1));
episodeSearch.addEventListener('input', () => filterEpisodes(episodeSearch.value));
clearSearchBtn.addEventListener('click', clearSearchInput);
document.addEventListener('click', (e) => {
    return;
});
matchMode.addEventListener('change', rerunCurrentSearch);
sortMode.addEventListener('change', rerunCurrentSearch);
resultLimit.addEventListener('change', rerunCurrentSearch);
posterOnly.addEventListener('change', rerunCurrentSearch);
document.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const query = btn.dataset.query;
        searchInput.value = query;
        performSearch(query);
    });
});

function showToast(message, duration = 1800) {
    toast.innerText = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), duration);
}

function getHeroDescription(title) {
    const moods = [
        "Cinematic action, emotional moments, and top-tier visuals in one binge-worthy journey.",
        "High-intensity arcs, iconic characters, and powerful storytelling crafted for marathon watching.",
        "Trending episodes with polished playback, fast servers, and a premium watch experience."
    ];
    if (!title) return moods[0];
    const idx = Math.abs(title.length) % moods.length;
    return moods[idx];
}

function bindHero(anime, badgeText = "🔥 Spotlight") {
    if (!anime) return;
    document.getElementById('hero-bg-img').src = anime.poster || "";
    document.getElementById('hero-title').innerText = anime.title || "Anime Title";
    heroBadge.innerText = badgeText;
    heroDesc.innerText = getHeroDescription(anime.title);
    heroMetaType.innerText = anime.slug && anime.slug.includes("movie") ? "Movie" : "Series";
    heroMetaLang.innerText = "SUB + DUB";
    heroMetaQuality.innerText = "Adaptive Stream";

    const oldPlayBtn = document.getElementById('hero-play-btn');
    const newPlayBtn = oldPlayBtn.cloneNode(true);
    oldPlayBtn.parentNode.replaceChild(newPlayBtn, oldPlayBtn);
    newPlayBtn.addEventListener('click', () => openAnime(anime));

    const oldSecondaryBtn = document.getElementById('hero-secondary-btn');
    const newSecondaryBtn = oldSecondaryBtn.cloneNode(true);
    oldSecondaryBtn.parentNode.replaceChild(newSecondaryBtn, oldSecondaryBtn);
    newSecondaryBtn.addEventListener('click', () => openAnime(anime));
}

function hideAutocomplete() {
    if (!autocompleteList) return;
    autocompleteList.classList.remove('show');
    autocompleteList.innerHTML = '';
}

function showAutocomplete(items) {
    return;
}

function renderAnimeGrid(list) {
    resultsGrid.innerHTML = '';
    list.forEach(anime => {
        const card = document.createElement('div');
        card.className = 'anime-card';
        card.innerHTML = `
            <div class="poster-wrapper">
                <img src="${anime.poster}" alt="${anime.title}">
                <div class="poster-gradient"></div>
                <div class="card-content">
                    <div class="card-title" title="${anime.title}">${anime.title}</div>
                </div>
                <div class="play-overlay"><i class="fa-solid fa-play"></i></div>
            </div>
        `;
        card.addEventListener('click', () => openAnime(anime));
        resultsGrid.appendChild(card);
    });
    resultCount.innerText = `${list.length} titles`;
}

function normalizeText(value) {
    return (value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isSubsequence(needle, haystack) {
    if (!needle || !haystack) return false;
    let i = 0;
    for (const ch of haystack) {
        if (ch === needle[i]) i += 1;
        if (i === needle.length) return true;
    }
    return false;
}

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

function scoreAnimeMatch(query, title) {
    const q = normalizeText(query);
    const t = normalizeText(title);
    if (!q || !t) return 0;

    if (t === q) return 1000;
    if (t.startsWith(q)) return 900;
    if (t.includes(q)) return 700;

    const qTokens = q.split(" ").filter(Boolean);
    const tTokens = t.split(" ").filter(Boolean);
    const overlap = qTokens.filter(tok => tTokens.some(tt => tt.includes(tok))).length;
    let score = overlap * 120;

    if (isSubsequence(q.replace(/\s/g, ""), t.replace(/\s/g, ""))) {
        score += 180;
    }

    const dist = levenshtein(q, t);
    const maxLen = Math.max(q.length, t.length);
    const sim = 1 - dist / Math.max(1, maxLen);
    if (sim >= 0.55) score += Math.floor(sim * 300);

    return score;
}

function fuzzyFindFromPool(query, pool) {
    const unique = new Map();
    pool.forEach(item => {
        if (item && item.ani_id && !unique.has(item.ani_id)) unique.set(item.ani_id, item);
    });

    const ranked = [];
    unique.forEach(item => {
        const score = scoreAnimeMatch(query, item.title);
        if (score >= 180) ranked.push({ score, item });
    });

    ranked.sort((a, b) => b.score - a.score);
    return ranked.map(r => r.item);
}

function applyAdvancedFilters(list, query) {
    const q = query.trim().toLowerCase();
    let output = [...list];

    if (posterOnly.checked) {
        output = output.filter(item => item.poster && item.poster.trim() !== '');
    }

    if (matchMode.value === 'exact') {
        output = output.filter(item => item.title.toLowerCase() === q);
    } else if (matchMode.value === 'starts') {
        output = output.filter(item => item.title.toLowerCase().startsWith(q));
    }

    if (sortMode.value === 'az') {
        output.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortMode.value === 'za') {
        output.sort((a, b) => b.title.localeCompare(a.title));
    }

    const limit = Number(resultLimit.value || 24);
    return output.slice(0, limit);
}

async function fetchSearchRaw(query) {
    const res = await fetch(`${API_BASE}/search?keyword=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!data.results) return [];
    return data.results;
}

async function rerunCurrentSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    await performSearch(q, false);
}

async function handleRealtimeSearch() {
    const query = searchInput.value.trim();
    if (query.length === 0) {
        clearSearchBtn.style.display = 'none';
        hideAutocomplete();
        return;
    }

    clearSearchBtn.style.display = 'inline-flex';
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
        if (query.length >= 2) {
            await performSearch(query, true);
        }
    }, 500);
}

function clearSearchInput() {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    hideAutocomplete();
    resultCount.innerText = '0 titles';
    loadHome();
}

function filterEpisodes(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('.ep-btn').forEach(btn => {
        const text = btn.innerText.toLowerCase();
        btn.style.display = text.includes(q) ? '' : 'none';
    });
}

function syncEpisodeNavState() {
    prevEpBtn.disabled = currentEpIndex <= 0;
    nextEpBtn.disabled = currentEpIndex < 0 || currentEpIndex >= allEpisodes.length - 1;
}

function jumpEpisode(direction) {
    if (!allEpisodes.length || currentEpIndex < 0) return;
    const nextIndex = currentEpIndex + direction;
    if (nextIndex < 0 || nextIndex >= allEpisodes.length) return;
    currentEpIndex = nextIndex;
    const target = allEpisodes[currentEpIndex];
    const btn = document.getElementById(`ep-btn-${target.number}`);
    if (btn) btn.click();
}

function renderEpisodeButtons(episodes) {
    episodesList.innerHTML = '';
    episodes.forEach(ep => {
        const btn = document.createElement('button');
        btn.className = 'ep-btn';
        btn.id = `ep-btn-${ep.number}`;
        btn.innerHTML = `Episode ${ep.number} ${ep.name !== String(ep.number) ? ` - ${ep.name}` : ''}`;
        btn.addEventListener('click', () => {
            document.querySelectorAll('.ep-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentEpIndex = allEpisodes.findIndex(item => item.token === ep.token);
            syncEpisodeNavState();
            playEpisode(ep);
        });
        episodesList.appendChild(btn);
    });
}

function goHome() {
    window.location.hash = '';
    viewPlayer.classList.remove('active');
    viewSearch.classList.add('active');

    // Clear any iframe fallback playing in the background
    document.getElementById('video-player').innerHTML = '';

    // Reset to Latest Updates
    searchInput.value = '';
    episodeSearch.value = '';
    allEpisodes = [];
    currentEpIndex = -1;
    syncEpisodeNavState();
    showToast('Back to home');
    loadHome();
}

backToSearch.addEventListener('click', goHome);
document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('langFilter').value = btn.dataset.lang;
        if (currentEp) playEpisode(currentEp);
    });
});

async function performSearch(query, isRealtime = false) {
    if (!query) return;
    const searchSeq = ++latestSearchSeq;
    if (!isRealtime) {
        resultsGrid.innerHTML = '';
        searchLoader.style.display = 'block';
    }
    resultCount.innerText = 'Searching...';

    const heroBanner = document.getElementById('hero-banner');
    heroBanner.style.display = 'none';
    document.getElementById('grid-title').innerText = query === "Jujutsu Kaisen" ? "Trending Now" : `Search Results: ${query}`;

    try {
        const rawResults = await fetchSearchRaw(query);
        if (searchSeq !== latestSearchSeq) return;
        searchLoader.style.display = 'none';

        let finalResults = rawResults;

        // Fuzzy fallback: टूटा / misspelled naam ko identify karne ke liye.
        if (finalResults.length === 0 && discoveryPool.length > 0) {
            finalResults = fuzzyFindFromPool(query, discoveryPool);
        }

        if (finalResults.length > 0) {
            // Setup Hero Banner with the first result
            const heroAnime = finalResults[0];
            bindHero(heroAnime, "🔎 Search Highlight");
            heroBanner.style.display = 'flex';

            const filtered = applyAdvancedFilters(finalResults.slice(1), query);
            renderAnimeGrid(filtered);
            if (rawResults.length === 0 && filtered.length > 0 && !isRealtime) {
                showToast('Approximate matches shown');
            }
            if (!isRealtime) showToast(`Loaded ${filtered.length} results`);
        } else {
            resultsGrid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No results found.</p>';
            resultCount.innerText = '0 titles';
        }
    } catch (e) {
        console.error("Search Error:", e);
        searchLoader.style.display = 'none';
        resultCount.innerText = 'Error';
        resultsGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: red;">Error fetching results: ${e.message}. Ensure API is running on port 5002.</p>`;
    }
}

async function openAnime(anime) {
    currentAnime = anime;
    sessionStorage.setItem('currentAnime', JSON.stringify(anime));
    window.location.hash = 'watch/' + anime.ani_id;

    viewSearch.classList.remove('active');
    viewPlayer.classList.add('active');

    playerTitle.innerText = anime.title;
    playerSubtitle.innerText = "Loading episodes...";
    episodesList.innerHTML = '';
    episodeSearch.value = '';
    epLoader.style.display = 'block';

    document.getElementById('video-player').innerHTML = '<div style="display:flex; height:100%; justify-content:center; align-items:center; color:#888;">Select an episode to play</div>';

    try {
        const res = await fetch(`${API_BASE}/episodes/${anime.ani_id}`);
        const data = await res.json();
        epLoader.style.display = 'none';

        if (data.data && data.data.result && data.data.result.rangedEpisodes) {
            playerSubtitle.innerText = `${data.data.result.episodeCount} Episodes Available`;
            const eps = [];
            data.data.result.rangedEpisodes.forEach(group => {
                eps.push(...group.episodes);
            });

            // Sort episodes numerically just in case
            eps.sort((a, b) => a.number - b.number);
            allEpisodes = eps;
            currentEpIndex = -1;
            renderEpisodeButtons(eps);
            syncEpisodeNavState();

            // Auto play first ep if available
            if (eps.length > 0) {
                episodesList.firstChild.click();
                showToast(`Now watching ${anime.title}`);
            }
        } else {
            playerSubtitle.innerText = "No episodes found.";
            allEpisodes = [];
            currentEpIndex = -1;
            syncEpisodeNavState();
        }
    } catch (e) {
        epLoader.style.display = 'none';
        playerSubtitle.innerText = "Error loading episodes.";
    }
}

async function playEpisode(ep) {
    currentEp = ep;
    document.getElementById('video-player').innerHTML = '<div class="loader"></div>';
    playerSubtitle.innerText = `Playing Episode ${ep.number}... Resolving Servers...`;

    const serverListContainer = document.getElementById('serverList');
    const serverBtnsContainer = document.getElementById('serverButtonsContainer');
    serverListContainer.style.display = 'none';
    serverBtnsContainer.innerHTML = '';

    try {
        const srvRes = await fetch(`${API_BASE}/servers/${ep.token}`);
        const srvData = await srvRes.json();

        const selectedLang = document.getElementById('langFilter').value;

        if (!srvData.data || !srvData.data.result || srvData.data.result.length === 0) {
            throw new Error("No servers found for this episode.");
        }

        // Logic for enabling/disabling Sub/Dub UI buttons
        const hasSub = srvData.data.result.some(c => c.lang === 'sub');
        const hasDub = srvData.data.result.some(c => c.lang === 'dub');

        document.querySelectorAll('.lang-btn').forEach(btn => {
            if (btn.dataset.lang === 'sub') {
                btn.disabled = !hasSub;
            } else if (btn.dataset.lang === 'dub') {
                btn.disabled = !hasDub;
            }
        });

        let links = [];
        srvData.data.result.forEach(cat => {
            if (cat.lang === selectedLang && cat.links) {
                links.push(...cat.links);
            }
        });

        // Fallback: If no links for selected language, take everything from the first category
        if (links.length === 0 && srvData.data.result[0] && srvData.data.result[0].links) {
            links = srvData.data.result[0].links;
        }

        if (links.length === 0) throw new Error("No links available.");

        // If multiple servers have the same title, add a suffix to distinguish them
        const titleCounts = {};
        links.forEach(l => {
            titleCounts[l.server_title] = (titleCounts[l.server_title] || 0) + 1;
        });

        const currentCounts = {};
        if (links.length > 1) {
            links.forEach(l => {
                if (titleCounts[l.server_title] > 1) {
                    currentCounts[l.server_title] = (currentCounts[l.server_title] || 0) + 1;
                    l.display_title = `${l.server_title} (${String.fromCharCode(64 + currentCounts[l.server_title])})`;
                } else {
                    l.display_title = l.server_title;
                }
            });
        } else {
            links[0].display_title = links[0].server_title;
        }

        // Render Server Buttons UI
        serverListContainer.style.display = 'flex';
        links.forEach(link => {
            const btn = document.createElement('button');
            btn.className = 'server-btn';
            btn.id = `server-btn-${link.id}`;
            btn.innerText = link.display_title; 
            btn.addEventListener('click', () => {
                // Manual override
                playServer(link, ep.number);
            });
            serverBtnsContainer.appendChild(btn);
        });

        // Auto-play the first working server
        let played = false;
        for (const link of links) {
            const success = await playServer(link, ep.number, true);
            if (success) {
                played = true;
                break;
            }
        }

        if (!played) {
            throw new Error("All servers are dead or returned 404.");
        }

    } catch (e) {
        console.error(e);
        document.getElementById('video-player').innerHTML = '<div style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; color:var(--text-muted); gap: 10px;"><h2><i class="fa-solid fa-link-slash"></i> Links Dead</h2><p>Servers for this episode have been removed by the provider.</p></div>';
        playerSubtitle.innerText = "Error playing video.";
    }
}

async function playServer(link, epNumber, isAuto = false) {
    if (!isAuto) {
        document.getElementById('video-player').innerHTML = '<div class="loader"></div>';
    }

    // UI Update
    document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`server-btn-${link.id}`);
    if (btn) btn.classList.add('active');

    playerSubtitle.innerText = `Testing Server: ${link.server_title}...`;

    try {
        const streamRes = await fetch(`${API_BASE}/source/${link.id}`);
        const streamData = await streamRes.json();

        if (streamData.success && streamData.provider) {
            if (btn) {
                btn.classList.remove('dead');
                btn.classList.add('active');
            }
            
            document.getElementById('video-player').innerHTML = `<iframe src="${streamData.provider}" allowfullscreen style="width:100%; height:100%; border:none; border-radius:12px;"></iframe>`;
            playerSubtitle.innerText = `Episode ${epNumber} - Embedded Player (${link.display_title})`;
            return true;
        }

        // If it reaches here, it means 404 or dead link
        if (btn) {
            btn.classList.remove('active');
            btn.classList.add('dead');
            btn.innerText = `${link.server_title} (Dead)`;
        }
        return false;
    } catch (err) {
        console.warn(`Server ${link.server_title} failed:`, err);
        if (btn) {
            btn.classList.remove('active');
            btn.classList.add('dead');
            btn.innerText = `${link.server_title} (Dead)`;
        }
        return false;
    }
}



async function loadHome() {
    resultsGrid.innerHTML = '';
    resultCount.innerText = 'Loading...';
    searchLoader.style.display = 'block';

    const heroBanner = document.getElementById('hero-banner');
    heroBanner.style.display = 'none';
    document.getElementById('grid-title').innerText = "Trending & Latest Updates";

    try {
        const res = await fetch(`${API_BASE}/home`);
        const data = await res.json();

        searchLoader.style.display = 'none';

        if (data.data && data.data.length > 0) {
            discoveryPool = data.data;
            // Setup Hero Banner with the first result
            const heroAnime = data.data[0];
            bindHero(heroAnime, "🔥 Spotlight");
            heroBanner.style.display = 'flex';

            renderAnimeGrid(data.data.slice(1));
            showToast('Latest updates loaded');
        } else {
            resultsGrid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No trending anime found.</p>';
            resultCount.innerText = '0 titles';
        }
    } catch (e) {
        searchLoader.style.display = 'none';
        resultCount.innerText = 'Error';
        resultsGrid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: red;">Error fetching results. Ensure API is running on port 5002.</p>';
    }
}

// Initial Load Logic
function initApp() {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#watch/')) {
        const stored = sessionStorage.getItem('currentAnime');
        if (stored) {
            const anime = JSON.parse(stored);
            // Verify it matches the hash
            if (hash === '#watch/' + anime.ani_id) {
                openAnime(anime);
                return;
            }
        }
    }
    // Default Home
    loadHome();
}

initApp();
