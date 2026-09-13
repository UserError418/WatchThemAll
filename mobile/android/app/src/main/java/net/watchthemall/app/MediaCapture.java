package net.watchthemall.app;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Remembers what the provider's player asked the network for.
 *
 * ## Why this exists
 *
 * Casting needs a URL. The app never has one: it loads a provider's embed page
 * into an iframe and that page's own JavaScript resolves the media, in a
 * cross-origin document nothing in the WebView can script into. The desktop
 * solves the same problem with Electron's `webRequest` API; on Android the only
 * equivalent is `WebViewClient.shouldInterceptRequest`, which fires for every
 * subresource of every frame — including a cross-origin one — and hands over
 * the URL and the request headers.
 *
 * That last part is what makes the whole feature possible. Most providers serve
 * their manifests only to a request carrying the embed page's `Referer` and
 * `Origin` (`streamextract.ts` calls that verdict `header-gated`), and a
 * Chromecast sends neither. Capturing the headers here is what lets the proxy
 * replay them later.
 *
 * ## Why this does not decide what a stream is
 *
 * It would be natural to match `.m3u8` here and record only that. The desktop
 * extractor does exactly that and it is the known reason two of the catalogue's
 * best providers report "no stream at all": several serve their manifest from a
 * path with no extension — `…/pl/H4sIAAAA…`, `…/v1/proxy?data=…` — and a URL
 * pattern cannot see through that.
 *
 * So this keeps *candidates* and refuses to judge them. It drops what is
 * obviously not media (scripts, images, fonts, and the segment flood that would
 * otherwise evict the manifest from a small buffer) and keeps the rest. The
 * decision is made in TypeScript at cast time, by fetching a candidate and
 * looking at what comes back — which is a fact rather than a guess, and is
 * covered by tests the four gates run.
 *
 * ## Threading
 *
 * `shouldInterceptRequest` is called on the WebView's network threads, several
 * at once, and blocking it stalls page loads. Everything here is synchronised
 * and does no I/O.
 */
public final class MediaCapture {

    /**
     * How many candidates to keep.
     *
     * A player resolves its stream through two or three chained API calls, and
     * an ad-heavy embed adds a dozen more requests around them. Forty is enough
     * to hold the whole resolution chain of every provider measured so far,
     * while staying small enough that the JS side can test them all.
     */
    private static final int CAPACITY = 40;

    /** One captured request. */
    public static final class Candidate {
        public final String url;
        public final Map<String, String> headers;
        public final long atMs;

        Candidate(String url, Map<String, String> headers, long atMs) {
            this.url = url;
            this.headers = headers;
            this.atMs = atMs;
        }
    }

    /**
     * Extensions that are never the thing we want to cast.
     *
     * `.ts`, `.m4s` and `.aac` are the important entries and they are here for a
     * different reason than the rest: they *are* media, but they are segments,
     * and a feature-length stream produces upwards of a thousand of them. One
     * of those floods would push the manifest out of the buffer within seconds
     * of playback starting — which is exactly when the user reaches for Cast.
     */
    private static final String[] IGNORED_EXTENSIONS = {
        ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
        ".woff", ".woff2", ".ttf", ".html", ".htm", ".vtt", ".srt",
        ".ts", ".m4s", ".aac", ".mp3"
    };

    private static final Deque<Candidate> RECENT = new ArrayDeque<>();

    private MediaCapture() {}

    /**
     * Record a request if it could plausibly be a stream.
     *
     * Called from `shouldInterceptRequest`, which must return promptly; this
     * does no network and no disk.
     */
    public static void record(WebResourceRequest request, String appHost) {
        Uri url = request.getUrl();
        if (url == null) return;

        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return;

        // The app's own bundle. Never interesting, and noisy on every navigation.
        if (appHost != null && appHost.equals(url.getHost())) return;

        // Only GETs can be replayed by a proxy the way the receiver will ask for
        // them; a POST that resolves a stream is part of the page's own dance.
        if (!"GET".equalsIgnoreCase(request.getMethod())) return;

        String path = url.getPath();
        if (path != null) {
            String lower = path.toLowerCase(Locale.ROOT);
            for (String extension : IGNORED_EXTENSIONS) {
                if (lower.endsWith(extension)) return;
            }
        }

        Map<String, String> headers = new LinkedHashMap<>();
        Map<String, String> requestHeaders = request.getRequestHeaders();
        if (requestHeaders != null) headers.putAll(requestHeaders);

        /*
         * `getRequestHeaders()` omits Cookie — the network stack adds it after
         * this callback. A provider that gates on a session cookie would
         * otherwise look reachable here and 403 for the Chromecast, which is the
         * `sealed` verdict arriving as a mystery instead of a diagnosis.
         */
        try {
            String cookie = CookieManager.getInstance().getCookie(url.toString());
            if (cookie != null && !cookie.isEmpty()) headers.put("Cookie", cookie);
        } catch (Exception ignored) {
            // No cookie store on this WebView. The candidate is still worth having.
        }

        synchronized (RECENT) {
            RECENT.addLast(new Candidate(url.toString(), headers, System.currentTimeMillis()));
            while (RECENT.size() > CAPACITY) RECENT.removeFirst();
        }
    }

    /** Everything captured since the last clear, newest first. */
    public static Candidate[] candidates() {
        synchronized (RECENT) {
            Candidate[] out = new Candidate[RECENT.size()];
            int index = out.length - 1;
            for (Candidate candidate : RECENT) out[index--] = candidate;
            return out;
        }
    }

    /**
     * Forget everything.
     *
     * Called when the player switches title, episode or provider. Without it the
     * previous title's manifest is still the newest thing in the buffer for the
     * first few seconds of the next one, and casting would silently start the
     * wrong film — the same class of error as a provider sweep crediting each
     * provider with its predecessor's stream.
     */
    public static void clear() {
        synchronized (RECENT) {
            RECENT.clear();
        }
    }
}
