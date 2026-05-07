import json
import time
import os
import re
import threading
import logging
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request
from flask_cors import CORS
from curl_cffi import requests

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# --- Concurrency Setup ---
MAX_WORKERS = 20
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
cache_lock = threading.Lock()
key_locks = defaultdict(threading.Lock)
token_cache_lock = threading.Lock()
rate_lock = threading.Lock()

# --- Cache Management ---
class CacheManager:
    def __init__(self, cache_file="cache_anigo_bypass.json"):
        # On Vercel, /tmp is the only writable directory. Local par relative path use karenge.
        if os.environ.get("VERCEL"):
            self.cache_file = os.path.join("/tmp", cache_file)
        else:
            self.cache_file = os.path.abspath(cache_file)
        self.cache = self._load_cache()
        self._save_scheduled = False
        self._last_save_ts = 0.0
        self._min_save_interval = 2.0

    def _load_cache(self):
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except:
                return {}
        return {}

    def _save_cache(self):
        with cache_lock:
            try:
                with open(self.cache_file, "w", encoding="utf-8") as f:
                    json.dump(self.cache, f, separators=(",", ":"), ensure_ascii=False)
                self._last_save_ts = time.time()
            except Exception as e:
                logger.error(f"Cache Save Error: {e}")
            finally:
                self._save_scheduled = False

    def _schedule_save(self):
        with cache_lock:
            if self._save_scheduled:
                return
            delay = max(0.0, self._min_save_interval - (time.time() - self._last_save_ts))
            self._save_scheduled = True
        timer = threading.Timer(delay, self._save_cache)
        timer.daemon = True
        timer.start()

    def get(self, key):
        with cache_lock:
            entry = self.cache.get(key)
            if entry:
                if time.time() < entry["expiry"]:
                    return entry["data"]
                else:
                    del self.cache[key]
            return None

    def set(self, key, data, ttl_hours: float = 2):
        expiry = time.time() + (ttl_hours * 3600)
        with cache_lock:
            self.cache[key] = {"data": data, "expiry": expiry}
        self._schedule_save()

cache_mgr = CacheManager()

app = Flask(__name__)
CORS(app)

# --- Configuration & Constants ---
ANIGO_URL = "https://anigo.to/"
ANIGO_HOME_URL = "https://anigo.to/home"

ENCDEC_URL = "https://enc-dec.app/api/enc-kai"
ENCDEC_DEC_KAI = "https://enc-dec.app/api/dec-kai"
ENCDEC_DEC_MEGA = "https://enc-dec.app/api/dec-mega"
ANIGO_BASE = ANIGO_URL.rstrip("/")

CONNECT_TIMEOUT = 4
READ_TIMEOUT = 15
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 0.35
TITLE_RE = re.compile(r'JTitle\(`([^`]+)`\)')
TOOLTIP_RE = re.compile(r"Tooltip\('([^']+)'\)")
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
DEBUG_MODE = os.getenv("ANIGO_DEBUG", "false").lower() == "true"

PREFETCH_ENABLED = False
SEARCH_CACHE_TTL_HOURS = 4
HOME_CACHE_TTL_HOURS = 0.5
EPISODES_CACHE_TTL_HOURS = 12
SERVERS_CACHE_TTL_HOURS = 0.01
SOURCE_CACHE_TTL_HOURS = 4

TOKEN_CACHE_TTL_SECONDS = 6 * 3600
TOKEN_CACHE_MAX_ITEMS = 5000
token_cache = {}

RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 60
ip_hits = defaultdict(deque)

BROWSER = "chrome110"
cf_session = requests.Session(impersonate=BROWSER)

def _with_retries(method, url, **kwargs):
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            kwargs.setdefault("timeout", (CONNECT_TIMEOUT, READ_TIMEOUT))
            return method(url, **kwargs)
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_BASE * (2 ** attempt))
    if last_err is not None:
        raise last_err
    raise RuntimeError("Request failed without capturing an exception")

def _token_cache_get(cache_key):
    now = time.time()
    with token_cache_lock:
        entry = token_cache.get(cache_key)
        if not entry:
            return None
        if entry["expiry"] > now:
            return entry["value"]
        del token_cache[cache_key]
    return None

def _token_cache_set(cache_key, value, ttl_seconds=TOKEN_CACHE_TTL_SECONDS):
    if value is None:
        return
    now = time.time()
    with token_cache_lock:
        if len(token_cache) >= TOKEN_CACHE_MAX_ITEMS:
            expired_keys = [k for k, v in token_cache.items() if v["expiry"] <= now]
            for k in expired_keys:
                token_cache.pop(k, None)
            if len(token_cache) >= TOKEN_CACHE_MAX_ITEMS:
                oldest_key = next(iter(token_cache), None)
                if oldest_key is not None:
                    token_cache.pop(oldest_key, None)
        token_cache[cache_key] = {"value": value, "expiry": now + ttl_seconds}

# Warm up the session
try:
    _with_retries(cf_session.get, ANIGO_HOME_URL)
except:
    pass

@app.before_request
def _basic_rate_limit():
    if not request.path.startswith("/api/"):
        return None
    fwd = request.headers.get("X-Forwarded-For", "")
    client_ip = (fwd.split(",")[0].strip() if fwd else request.remote_addr) or "unknown"
    now = time.time()
    with rate_lock:
        q = ip_hits[client_ip]
        while q and (now - q[0]) > RATE_LIMIT_WINDOW_SECONDS:
            q.popleft()
        if len(q) >= RATE_LIMIT_MAX_REQUESTS:
            return jsonify({
                "error": "Rate limit exceeded",
                "retry_after_seconds": RATE_LIMIT_WINDOW_SECONDS
            }), 429
        q.append(now)
    return None

@app.after_request
def _finalize_io_v4(r):
    if r.is_json:
        try:
            d = r.get_json()
            if isinstance(d, dict):
                _new = {"Author": "Zayrix-bit", "Bypass": "Active"}
                _new.update(d)
                r.set_data(json.dumps(_new, separators=(",", ":"), ensure_ascii=False))
        except Exception:
            pass
    return r

AJAX_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://anigo.to/"
}

# --- Utility Functions ---
def encode_token(text):
    cache_key = f"enc:{text}"
    cached = _token_cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        r = _with_retries(requests.get, ENCDEC_URL, params={"text": text})
        if r.status_code == 200:
            result = r.json().get("result")
            _token_cache_set(cache_key, result)
            return result
    except:
        pass
    return None

def decode_token(text, mega=False):
    cache_key = f"dec:{'mega' if mega else 'kai'}:{text}"
    cached = _token_cache_get(cache_key)
    if cached is not None:
        return cached
    url = ENCDEC_DEC_MEGA if mega else ENCDEC_DEC_KAI
    try:
        payload = {"text": text}
        if mega:
            payload["agent"] = DEFAULT_UA
        
        r = _with_retries(requests.post, url, json=payload)
        if r.status_code == 200:
            result = r.json().get("result")
            _token_cache_set(cache_key, result)
            return result
    except Exception as e:
        logger.error(f"Decode Error: {e}")
    return None

# --- Core Scraping Logic ---

def search_anime(keyword):
    try:
        response = _with_retries(
            cf_session.get,
            f"{ANIGO_BASE}/browser",
            params={"keyword": keyword}, 
        )
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        
        for item in soup.select(".unit"):
            poster_a = item.select_one("a.poster")
            if not poster_a: continue
            
            href = poster_a.get("href", "")
            slug = href.replace("/watch/", "") if href.startswith("/watch/") else href
            
            poster_img = poster_a.select_one("img")
            poster = poster_img.get("src", "") if poster_img else ""
            
            title_tag = item.select_one("h6.title")
            title = ""
            if title_tag:
                x_data = title_tag.get("x-data", "")
                m = TITLE_RE.search(x_data)
                if m:
                    title = m.group(1)
                else:
                    title = title_tag.text.strip()
            
            ani_id = ""
            ctrl_div = item.select_one(".ctrl button, button.ttipBtn")
            if ctrl_div:
                x_data = ctrl_div.get("x-data", "")
                m = TOOLTIP_RE.search(x_data)
                if m:
                    ani_id = m.group(1)

            if title:
                results.append({
                    "title": title,
                    "slug": slug,
                    "ani_id": ani_id,
                    "url": f"{ANIGO_BASE}{href}",
                    "poster": poster,
                })
        return results
    except Exception as e:
        return {"error": str(e)}

def home_anime():
    try:
        response = _with_retries(cf_session.get, f"{ANIGO_BASE}/home")
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        seen = set()
        
        for item in soup.select(".unit"):
            if "noti.url" in str(item): continue
            
            poster_a = item.select_one("a.poster")
            if not poster_a: continue
            
            href = poster_a.get("href", "")
            slug = href.replace("/watch/", "") if href.startswith("/watch/") else href
            
            poster_img = poster_a.select_one("img")
            poster = poster_img.get("src", "") if poster_img else ""
            
            title_tag = item.select_one("h6.title")
            title = ""
            if title_tag:
                x_data = title_tag.get("x-data", "")
                m = TITLE_RE.search(x_data)
                if m:
                    title = m.group(1)
                else:
                    title = title_tag.text.strip()
            
            ani_id = ""
            ctrl_div = item.select_one(".ctrl button, button.ttipBtn")
            if ctrl_div:
                x_data = ctrl_div.get("x-data", "")
                m = TOOLTIP_RE.search(x_data)
                if m:
                    ani_id = m.group(1)

            if title and ani_id and ani_id not in seen:
                seen.add(ani_id)
                results.append({
                    "title": title,
                    "slug": slug,
                    "ani_id": ani_id,
                    "url": f"{ANIGO_BASE}{href}",
                    "poster": poster,
                })
        return results
    except Exception as e:
        return {"error": str(e)}

def get_episodes(ani_id):
    encoded_id = encode_token(ani_id)
    if not encoded_id:
        return {"error": "Failed to encrypt ani_id"}
    try:
        r = _with_retries(
            cf_session.get,
            f"{ANIGO_BASE}/api/v1/titles/{ani_id}/episodes",
            params={"_": encoded_id},
            headers=AJAX_HEADERS,
        )
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def get_servers(ep_token):
    encoded_token = encode_token(ep_token)
    if not encoded_token:
        return {"error": "Failed to encrypt ep_token"}
    try:
        r = _with_retries(
            cf_session.get,
            f"{ANIGO_BASE}/api/v1/eptokens/{ep_token}",
            params={"_": encoded_token},
            headers=AJAX_HEADERS,
        )
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def get_source(link_id):
    try:
        encoded_id = encode_token(link_id)
        if not encoded_id:
            return {"error": "Failed to encrypt link id"}

        r = _with_retries(
            cf_session.get,
            f"{ANIGO_BASE}/api/v1/links/{link_id}",
            params={"_": encoded_id},
            headers=AJAX_HEADERS,
        )
        data = r.json()
        if data.get("status") == "ok":
            encrypted_result = data.get("result")
            decoded_link = decode_token(encrypted_result)
            if not decoded_link:
                return {"error": "Failed to decode link result"}
            
            if isinstance(decoded_link, dict) and "url" in decoded_link:
                url = decoded_link["url"]
                vid_id = url.rstrip("/").split("/")[-1].split("?")[0]
                embed_base = url.rsplit("/e/", 1)[0] if "/e/" in url else url.rsplit("/", 1)[0]
                
                v_param = ""
                if "?" in url:
                    query_str = url.split("?")[1]
                    for param in query_str.split("&"):
                        if param.startswith("v="):
                            v_param = f"&{param}"
                            break
                
                resolve_url = f"{embed_base}/media/{vid_id}?_={int(time.time()*1000)}{v_param}"
                
                media_headers = {
                    "User-Agent": DEFAULT_UA,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": url,
                    "Origin": embed_base
                }
                
                try:
                    _with_retries(
                        cf_session.get,
                        url,
                        headers={"User-Agent": media_headers["User-Agent"]},
                        timeout=(CONNECT_TIMEOUT, 10)
                    )
                except:
                    pass
                
                source_req = _with_retries(cf_session.get, resolve_url, headers=media_headers)
                source_data = source_req.json()
                
                encrypted_media = source_data.get("result", "")
                if encrypted_media:
                    mega_providers = ["megacloud.tv", "megaup.nl", "megaup.live", "rabbitstream.net", "dokicloud.one", "cloudemb.com"]
                    mega = any(p in url for p in mega_providers)
                    
                    dec_sources = decode_token(encrypted_media, mega=mega)
                    
                    if isinstance(dec_sources, dict):
                        source_data["sources"] = dec_sources.get("sources", [])
                        source_data["tracks"] = dec_sources.get("tracks", [])
                        source_data["download"] = dec_sources.get("download", "")
                    else:
                        source_data["sources"] = dec_sources
                
                return {
                    "success": True,
                    "link_id": link_id,
                    "provider": url,
                    "stream_data": source_data,
                    "skip_data": decoded_link.get("skip")
                }
            else:
                return {"error": "Invalid decrypted format", "decoded": decoded_link}
        return data
    except Exception as e:
        return {"error": str(e)}

# --- API Endpoints ---

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"success": True, "api": "Anigo Bypass API", "status": "Ready"})

@app.route("/api/search", methods=["GET"])
def api_search():
    kw = request.args.get("keyword", "").strip()
    if not kw: return jsonify({"error": "Keyword is required"}), 400
    norm_kw = " ".join(kw.lower().split())
    cache_key = f"search_{norm_kw}"
    cached = cache_mgr.get(cache_key)
    if cached: return jsonify({"success": True, "count": len(cached), "results": cached, "cached": True})

    res = search_anime(kw)
    if isinstance(res, dict) and "error" in res:
        return jsonify(res), 500
    
    cache_mgr.set(cache_key, res, ttl_hours=SEARCH_CACHE_TTL_HOURS)
    return jsonify({"success": True, "count": len(res), "results": res})

@app.route("/api/episodes/<ani_id>", methods=["GET"])
def api_episodes(ani_id):
    cache_key = f"episodes_{ani_id}"
    cached = cache_mgr.get(cache_key)
    if cached: return jsonify({"success": True, "cached": True, "data": cached})

    res = get_episodes(ani_id)
    if isinstance(res, dict) and "error" in res:
        return jsonify(res), 500

    cache_mgr.set(cache_key, res, ttl_hours=EPISODES_CACHE_TTL_HOURS)
    return jsonify({"success": True, "data": res})

@app.route("/api/servers/<ep_token>", methods=["GET"])
def api_servers(ep_token):
    cache_key = f"servers_{ep_token}"
    cached = cache_mgr.get(cache_key)
    if cached: return jsonify({"success": True, "cached": True, "data": cached})

    res = get_servers(ep_token)
    if isinstance(res, dict) and "error" in res:
        return jsonify(res), 500

    cache_mgr.set(cache_key, res, ttl_hours=SERVERS_CACHE_TTL_HOURS)
    return jsonify({"success": True, "data": res})

@app.route("/api/source/<link_id>", methods=["GET"])
def api_source(link_id):
    cache_key = f"source_{link_id}"
    cached = cache_mgr.get(cache_key)
    if cached: return jsonify(cached)

    res = get_source(link_id)
    if isinstance(res, dict) and "error" in res:
        cache_mgr.set(cache_key, res, ttl_hours=0.05)
        return jsonify(res), 500

    cache_mgr.set(cache_key, res, ttl_hours=SOURCE_CACHE_TTL_HOURS)
    return jsonify(res)

@app.route("/api/home", methods=["GET"])
def api_home():
    cache_key = "home_latest"
    cached = cache_mgr.get(cache_key)
    if cached: return jsonify({"success": True, "cached": True, "data": cached})
    
    res = home_anime()
    if isinstance(res, dict) and "error" in res:
        return jsonify(res), 500
        
    cache_mgr.set(cache_key, res, ttl_hours=HOME_CACHE_TTL_HOURS)
    return jsonify({"success": True, "data": res})


if __name__ == "__main__":
    logger.info("Starting Anigo Bypass API on Port 5002...")
    app.run(host="0.0.0.0", port=5002, debug=True)
