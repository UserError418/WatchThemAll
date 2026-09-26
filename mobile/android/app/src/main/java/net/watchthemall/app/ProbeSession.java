package net.watchthemall.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * One provider, loaded somewhere the user cannot see it, with its own network log.
 *
 * ## Where the view goes, and why there
 *
 * The desktop probes in hidden `BrowserWindow`s. Android has no hidden
 * window, and a WebView that is `GONE`, `INVISIBLE`, detached or zero-sized is
 * one Chromium treats as a background tab: timers throttle, media is
 * suspended, and a provider that streams perfectly looks dead.
 *
 * So the probe WebView is fully visible as far as Android and Chromium can
 * tell — attached, `VISIBLE`, a real size — and simply drawn *first*. It is
 * added to the app WebView's parent at index 0, which puts it under the app
 * WebView in both drawing and touch order. The app WebView paints an opaque
 * page over the whole of it, so the user sees the app and nothing else, and a
 * finger lands on the app, never on the provider. Nothing in the view system
 * culls a covered sibling, so the probe keeps drawing, decoding and fetching
 * exactly as it would on top. That is measured, not assumed — see
 * `ProbeViewPlugin` for the numbers.
 *
 * It is laid out inside the app WebView's own rectangle, never outside it.
 * The app WebView sits between the system bars, and a probe reaching under a
 * translucent bar would show through it.
 *
 * Sized 16:9 at the app's width, like the player, so a provider lays itself
 * out the way it does for a user, and a tap at the centre lands where a play
 * button usually is.
 *
 * ## Why the provider is framed rather than loaded
 *
 * Providers are embed products and several refuse a top-level load: Videasy
 * answers a document request with 403 and aborts its scripts when
 * `window.top === window.self` (see `src/main/localserver.ts`, which found
 * this on the desktop). So the probe loads a one-element shell whose iframe
 * is the provider, with the shell's origin set to the app's own, which is
 * exactly how the in-app player frames it: same `Referer`, same ancestor
 * origin, same iframe attributes.
 *
 * ## Pressing play without a finger
 *
 * The in-app scan can only press play with a real touch, because nothing
 * scripts a cross-origin iframe from outside. A document-start script is not
 * "from outside": `addDocumentStartJavaScript` installs it into every frame
 * the WebView creates, cross-origin included, before the page's own scripts
 * run. The script itself — silence the page, press play a few times — is
 * written in TypeScript's half (`mobile/src/bridge/probescript.ts`), which is
 * where the scan that tunes it lives. `tap` remains for players that ignore a
 * synthetic click.
 *
 * ## Silence
 *
 * Audio is muted twice. `WebViewCompat.setAudioMuted` mutes the whole WebView
 * — every frame, Web Audio included — where the WebView supports it, and the
 * page script mutes every media element before it plays, which is the only
 * defence on a WebView that does not. A probe that makes a sound has failed at
 * its one user-visible job, which is to be invisible.
 *
 * ## Threading
 *
 * Constructed, tapped and destroyed on the main thread only, as every WebView
 * must be. The request log is the one piece touched from elsewhere, and it is
 * synchronised.
 */
final class ProbeSession {

    private static final String TAG = "ProbeView";

    /**
     * How many requests one session remembers.
     *
     * A fifteen-second probe of an ad-heavy provider makes a few hundred,
     * page assets and segments together. The cap exists so a caller that
     * forgets to poll cannot grow a buffer without bound; a reader that falls
     * behind is told how many it missed.
     */
    private static final int LOG_CAPACITY = 1500;

    /**
     * Requests that are never replayed, so their cookies are not looked up.
     *
     * Everything is recorded — segments included, and segments are often
     * served under a disguise such as `.jpg` or `.js`, so an extension is no
     * grounds to drop a request. But the `Cookie` lookup is a synchronous call
     * into the cookie store made while the request waits, and only a request
     * something may fetch again (a playlist, an API call, an opaque proxy
     * path) needs it. The page's own code, styling and imagery never are.
     */
    private static final String[] NEVER_REPLAYED_EXTENSIONS = {
        ".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
        ".woff", ".woff2", ".ttf", ".otf"
    };

    /** Told about the few things worth pushing rather than polling. */
    interface Listener {
        /**
         * The provider's own document failed: an HTTP error status, or no
         * response at all (`status` 0). Not reported for its sub-resources,
         * which fail constantly on ad-heavy pages and mean nothing.
         */
        void onDocumentError(ProbeSession session, String url, int status, String description);

        /**
         * The session ended without being asked to — its renderer died. The
         * session has already destroyed its WebView by the time this is called.
         */
        void onGone(ProbeSession session, String reason);
    }

    final String id;
    final String providerUrl;
    final long openedAtMs;
    final boolean documentStartScript;
    final boolean audioMuted;

    private final WebView webView;
    private final ProbeRequestLog log = new ProbeRequestLog(LOG_CAPACITY);
    private final Listener listener;
    private final String shellHost;
    private ScriptHandler scriptHandler;
    private boolean destroyed;

    /**
     * When the page script first saw media playing, in any frame; 0 until then.
     *
     * Evidence the network log cannot always give. 111Movies fetches every
     * segment through a service worker, and a service worker's requests go to
     * the app-wide `ServiceWorkerClient`, never to this view's
     * `shouldInterceptRequest` — so its log showed no stream while the page
     * script watched the video advance from 47.9 s to 52.7 s. A decoder
     * starting is the same proof the desktop takes from `media-started-playing`.
     * Written on the UI thread by the console hook, read by `requests` on a
     * plugin worker, hence volatile.
     */
    private volatile long playingAtMs;

    /**
     * Build the view, put it behind the app, and start loading.
     *
     * @param appWebView  the Capacitor WebView; the probe goes under it, inside its bounds
     * @param shellOrigin the origin the provider will see as its embedder, e.g. `https://localhost/`
     * @param pageScript  run at document start in every frame, or null for none
     */
    @SuppressLint("SetJavaScriptEnabled")
    ProbeSession(
        Activity activity,
        WebView appWebView,
        String id,
        String providerUrl,
        String shellOrigin,
        String pageScript,
        Listener listener
    ) {
        this.id = id;
        this.providerUrl = providerUrl;
        this.listener = listener;
        this.shellHost = Uri.parse(shellOrigin).getHost();
        this.openedAtMs = System.currentTimeMillis();

        webView = new WebView(activity);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The same answer the app's own WebView gives (Capacitor sets it), so
        // `video.play()` from the page script needs no user gesture — which is
        // what lets a probe start playback without a touch at all.
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Popunders: the same two settings `MainActivity` applies to the app,
        // for the same reason. A probe must not open windows either.
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // Look like the app's player to the provider, not like a second client.
        settings.setUserAgentString(appWebView.getSettings().getUserAgentString());
        // The provider is a third party inside the shell, as it is inside the
        // app, and the app's WebView accepts third-party cookies (Capacitor's
        // cookie manager turns it on). A provider whose player needs its own
        // cookie would otherwise pass in the app and fail here.
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setBackgroundColor(Color.BLACK);
        // Invisible to the user means invisible to TalkBack and to focus too:
        // a screen reader walking into a hidden provider page, or a keyboard
        // focus landing in one, would be the probe showing itself.
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        webView.setFocusable(false);
        webView.setFocusableInTouchMode(false);

        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());

        audioMuted = muteAudio(webView);
        documentStartScript = pageScript != null && installPageScript(pageScript);

        attachBehind(appWebView);

        webView.loadDataWithBaseURL(shellOrigin, shellPage(providerUrl), "text/html", "utf-8", null);
    }

    /** Whether the WebView can install a script into every frame, cross-origin included. */
    static boolean documentStartScriptSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    /** Whether the WebView can mute itself outright. */
    static boolean muteAudioSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.MUTE_AUDIO);
    }

    private static boolean muteAudio(WebView view) {
        if (!muteAudioSupported()) return false;
        WebViewCompat.setAudioMuted(view, true);
        return WebViewCompat.isAudioMuted(view);
    }

    /**
     * Install the page script into every frame of every origin.
     *
     * `"*"` is the rule that matters: a provider's player is an iframe of a
     * different origin, often two deep, and a narrower rule would reach the
     * shell and nothing that has a play button.
     */
    private boolean installPageScript(String script) {
        if (!documentStartScriptSupported()) return false;
        scriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton("*"));
        return true;
    }

    /**
     * Add the view under the app WebView, centred inside its bounds.
     *
     * Margins rather than gravity, because they mean the same thing in any
     * `ViewGroup` Capacitor might host its WebView in, and the probe is gone
     * again within seconds, so it does not follow later layout changes.
     */
    private void attachBehind(WebView appWebView) {
        ViewGroup host = (ViewGroup) appWebView.getParent();
        // Zero only before the app's first layout, which no caller can reach.
        int width = Math.max(appWebView.getWidth(), 1);
        int height = Math.round(width * 9f / 16f);

        ViewGroup.MarginLayoutParams params = new ViewGroup.MarginLayoutParams(width, height);
        params.leftMargin = appWebView.getLeft() - host.getPaddingLeft();
        params.topMargin = appWebView.getTop() - host.getPaddingTop() + (appWebView.getHeight() - height) / 2;

        // Index 0 is drawn first and hit-tested last: under the app in both.
        host.addView(webView, 0, params);
    }

    /**
     * The shell document: the provider in a full-bleed iframe, and nothing else.
     *
     * The iframe's attributes are the in-app player's, copied from
     * `playersurface.ts` (its `ALLOW`, `allowfullscreen`, `referrerpolicy`) so
     * a provider cannot tell the probe from the player: `allow` lets it
     * autoplay, `referrerpolicy` makes the embedder's origin its `Referer`.
     * No `sandbox`, for the reason `MainActivity` records: providers detect
     * it and refuse to play. If the player's attributes change, change these.
     */
    private static String shellPage(String providerUrl) {
        return "<!doctype html><html><head>"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}"
            + "iframe{display:block;width:100%;height:100%;border:0}</style>"
            + "</head><body>"
            + "<iframe src=\"" + escapeAttribute(providerUrl) + "\" "
            + "allow=\"autoplay; fullscreen; encrypted-media; picture-in-picture\" "
            + "allowfullscreen=\"true\" referrerpolicy=\"origin\"></iframe>"
            + "</body></html>";
    }

    private static String escapeAttribute(String value) {
        return value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * A single tap at a point in the probe view, in CSS pixels, or its centre.
     *
     * Dispatched straight into the probe WebView rather than through the
     * window, so being under the app does not matter: the event never goes
     * through hit-testing among siblings, only through the probe's own DOM.
     * That DOM includes whatever is inside a cross-origin iframe, and origin
     * does not enter into it — this is not script reaching into a document,
     * it is a touch landing on a pixel, which is why a native tap reaches a
     * play button no script from outside can.
     *
     * Coordinates arrive in CSS pixels, the only unit a web caller has, and
     * are converted here, where the view can be asked its density: passing
     * one for the other (2.625 apart on the Pixel profile) put the old
     * scan's touch a third of the way up the screen, in the app's own UI.
     */
    void tap(Double cssX, Double cssY) {
        if (destroyed) return;
        float density = webView.getResources().getDisplayMetrics().density;
        float x = cssX != null ? (float) (cssX * density) : webView.getWidth() / 2f;
        float y = cssY != null ? (float) (cssY * density) : webView.getHeight() / 2f;

        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent up = MotionEvent.obtain(now, now, MotionEvent.ACTION_UP, x, y, 0);
        try {
            webView.dispatchTouchEvent(down);
            webView.dispatchTouchEvent(up);
        } finally {
            down.recycle();
            up.recycle();
        }
    }

    ProbeRequestLog.Slice requestsSince(long cursor) {
        return log.since(cursor);
    }

    /** See the field. 0 while nothing has played. */
    long playingAtMs() {
        return playingAtMs;
    }

    /**
     * Tear everything down, in the order that frees the decoder soonest.
     *
     * `stopLoading` ends network activity; loading `about:blank` unloads the
     * provider's document, which is what releases its media pipeline; the view
     * leaves the hierarchy before `destroy`, as `WebView.destroy` requires.
     * Idempotent, because a renderer crash and a caller's `close` can race.
     */
    void destroy() {
        teardown(true);
    }

    /**
     * `rendererAlive` is false after the renderer died: a WebView in that
     * state may only be removed and destroyed, and asking it to load anything
     * — even `about:blank` — would start a new renderer for a view that is
     * about to be thrown away.
     */
    private void teardown(boolean rendererAlive) {
        if (destroyed) return;
        destroyed = true;
        if (scriptHandler != null) {
            scriptHandler.remove();
            scriptHandler = null;
        }
        if (rendererAlive) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
        }
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) parent.removeView(webView);
        webView.destroy();
    }

    boolean isDestroyed() {
        return destroyed;
    }

    /** The provider's own document, as opposed to one of its sub-resources. */
    private boolean isProviderDocument(WebResourceRequest request) {
        return request.isForMainFrame() || providerUrl.equals(request.getUrl().toString());
    }

    private final class Client extends WebViewClient {

        /**
         * The shell stays; frames inside it may go wherever they like.
         *
         * A main-frame navigation here can only be a provider or an ad trying
         * to take the top window, which the app refuses too
         * (`PlayerNavigationClient`). Returning true without doing anything
         * keeps the shell and fires no intent, so an ad cannot open Chrome
         * from a view the user cannot even see.
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return request.isForMainFrame();
        }

        /**
         * Record, and change nothing: returning null lets the WebView fetch it
         * exactly as if this method did not exist. See
         * `PlayerNavigationClient.shouldInterceptRequest` for why taking over
         * the transport is not worth it.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            try {
                record(request);
            } catch (Exception ignored) {
                // The log is a measurement; nothing here may break the page.
            }
            return null;
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!isProviderDocument(request)) return;
            listener.onDocumentError(ProbeSession.this, request.getUrl().toString(),
                response.getStatusCode(), response.getReasonPhrase());
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!isProviderDocument(request)) return;
            listener.onDocumentError(ProbeSession.this, request.getUrl().toString(), 0,
                String.valueOf(error.getDescription()));
        }

        /**
         * The renderer died — killed for memory, or crashed.
         *
         * Returning true is what keeps the app alive: returning false for a
         * WebView whose renderer is gone kills the whole process. The WebView
         * is unusable afterwards and must be destroyed, which is done before
         * the plugin hears of it. Every WebView in the app shares one renderer,
         * so the app's own WebView gets this call too, through Capacitor's
         * client; that is not this session's to handle.
         */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            String reason = detail.didCrash() ? "renderer-crashed" : "renderer-killed";
            Log.w(TAG, "probe " + id + ": " + reason);
            teardown(false);
            listener.onGone(ProbeSession.this, reason);
            return true;
        }
    }

    /**
     * Surfaces the page script's own diagnostics in logcat, and nothing else.
     *
     * Every frame's console goes through here, and provider pages are noisy,
     * so only lines the page script tags as its own are logged. That is how a
     * run on a device answers "did the script reach the player's frame" with
     * `adb logcat -s ProbeView`, which nothing else can see from outside.
     */
    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            String text = message.message();
            if (text == null || !text.startsWith("[wta-probe]")) return true;
            Log.i(TAG, id + " " + text);
            // The script logs "playing" once per frame, when media there first
            // plays. The first one, in any frame, is the one that counts.
            if (playingAtMs == 0 && text.startsWith("[wta-probe] playing")) {
                playingAtMs = System.currentTimeMillis();
            }
            return true;
        }
    }

    private void record(WebResourceRequest request) {
        Uri url = request.getUrl();
        String scheme = url.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return;
        // The shell's origin is fictional; nothing is fetched from it.
        if (shellHost != null && shellHost.equals(url.getHost())) return;

        Map<String, String> headers = new LinkedHashMap<>();
        Map<String, String> requestHeaders = request.getRequestHeaders();
        if (requestHeaders != null) headers.putAll(requestHeaders);
        // Added by the network stack after this callback, so absent from
        // `getRequestHeaders` — and needed by anything that replays the request.
        // Same reasoning as `MediaCapture.record`.
        if (mayBeReplayed(url)) {
            try {
                String cookie = CookieManager.getInstance().getCookie(url.toString());
                if (cookie != null && !cookie.isEmpty()) headers.put("Cookie", cookie);
            } catch (Exception ignored) {
                // No cookie store: the entry is still worth having.
            }
        }

        log.add(url.toString(), request.getMethod(), headers, request.isForMainFrame(), System.currentTimeMillis());
    }

    private static boolean mayBeReplayed(Uri url) {
        String path = url.getPath();
        if (path == null) return true;
        String lower = path.toLowerCase(Locale.ROOT);
        for (String extension : NEVER_REPLAYED_EXTENSIONS) {
            if (lower.endsWith(extension)) return false;
        }
        return true;
    }
}
