package net.watchthemall.app;

import android.content.pm.PackageInfo;

import androidx.webkit.WebViewCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Probe sessions: providers loaded out of sight, several at once, each with
 * its own network log.
 *
 * ## What this replaces, and why
 *
 * Today's scan (`mobile/src/bridge/scan.ts`) loads each provider into an
 * iframe the user can see, one at a time, six seconds apart. All three
 * properties come from one fact: the app has a single WebView and a single
 * capture buffer (`MediaCapture`), so two providers in flight would share one
 * undifferentiated pile of requests, and pressing play inside a cross-origin
 * iframe needs a real touch on real pixels.
 *
 * A session here is a separate `WebView` per provider (`ProbeSession`), which
 * removes the fact rather than working around it:
 *
 * - **Attribution is by ownership.** Each session's `shouldInterceptRequest`
 *   sees only its own provider's traffic, so two sessions can run side by
 *   side and nothing needs blanking or settling between providers.
 * - **Play is pressed from inside the page.** A document-start script reaches
 *   every frame, cross-origin included, so no touch is needed for the
 *   providers measured; `tap` remains for any that ignore a synthetic click.
 * - **It is out of sight.** The session's view sits under the app's WebView,
 *   fully covered, but attached and visible as far as Chromium can tell, so
 *   the provider plays as it would on screen. See `ProbeSession`.
 *
 * ## The contract
 *
 * `open` → poll `requests` with the cursor it returns → `close`. Sessions are
 * named by the caller, so events can be matched to a session before `open`
 * has even resolved. Two events are pushed rather than polled because they
 * are rare and final: `probeDocumentError` (the provider's own page failed)
 * and `probeGone` (the renderer died and took the session with it).
 * Everything else is a poll, because requests arrive by the dozen per second
 * while a stream plays, and one bridge message per request would cost more
 * than the probe.
 *
 * ## Why this is not `ScanPlugin`
 *
 * `ScanPlugin` taps the app's own WebView and is what the visible scan
 * surface uses. This owns views of its own and their lifecycles. Keeping them
 * apart means the old path keeps working, untouched, until the scan moves
 * over.
 *
 * ## Threading
 *
 * Views are created, tapped and destroyed on the main thread; plugin calls
 * arrive on a Capacitor worker, so those methods hop. `requests` does not
 * hop: it reads a synchronised log and has no reason to queue behind the UI.
 * The session map is concurrent for that one reader; it is only ever written
 * on the main thread.
 */
@CapacitorPlugin(name = "ProbeView")
public class ProbeViewPlugin extends Plugin {

    /**
     * The most sessions allowed at once.
     *
     * The scan needs two. The cap is not about the scan working, it is about a
     * caller's leak failing loudly: every session is a live WebView decoding
     * video, and a phone quietly accumulating them would get slower and
     * hotter with nothing to say why.
     */
    private static final int MAX_SESSIONS = 4;

    /** The in-app player's origin: what a provider sees framing it. */
    private static final String DEFAULT_EMBEDDER = "https://localhost/";

    private final Map<String, ProbeSession> sessions = new ConcurrentHashMap<>();

    /** What this WebView can do, so the caller can decide before it opens anything. */
    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("documentStartScript", ProbeSession.documentStartScriptSupported());
        result.put("muteAudio", ProbeSession.muteAudioSupported());
        PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(getContext());
        result.put("webViewVersion", webView != null ? webView.versionName : "");
        result.put("maxSessions", MAX_SESSIONS);
        call.resolve(result);
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String sessionId = call.getString("sessionId");
        final String url = call.getString("url");
        if (sessionId == null || url == null) {
            call.reject("open needs sessionId and url");
            return;
        }
        final String referer = call.getString("referer", DEFAULT_EMBEDDER);
        final String pageScript = call.getString("pageScript");

        getActivity().runOnUiThread(() -> {
            if (sessions.containsKey(sessionId)) {
                call.reject("probe session already open: " + sessionId);
                return;
            }
            if (sessions.size() >= MAX_SESSIONS) {
                call.reject("too many probe sessions open (" + MAX_SESSIONS + "); close one first");
                return;
            }

            ProbeSession session;
            try {
                session = new ProbeSession(getActivity(), getBridge().getWebView(), sessionId, url, referer,
                    pageScript, listener);
            } catch (Exception error) {
                // A WebView that cannot be created (the provider package is
                // mid-update, say) is a failed probe, not a crashed app.
                call.reject("could not open probe view: " + error.getMessage());
                return;
            }
            sessions.put(sessionId, session);

            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            result.put("openedAtMs", session.openedAtMs);
            result.put("documentStartScript", session.documentStartScript);
            result.put("audioMuted", session.audioMuted);
            call.resolve(result);
        });
    }

    /** Destroy one session. Closing one that is already gone is not an error. */
    @PluginMethod
    public void close(PluginCall call) {
        final String sessionId = call.getString("sessionId");
        getActivity().runOnUiThread(() -> {
            ProbeSession session = sessionId != null ? sessions.remove(sessionId) : null;
            if (session != null) session.destroy();
            JSObject result = new JSObject();
            result.put("closed", session != null);
            call.resolve(result);
        });
    }

    /**
     * Destroy every session.
     *
     * For a cancelled scan and for a bridge that reloads with sessions still
     * open — the JavaScript that knew their names is gone, and the views
     * would otherwise decode until the app was killed.
     */
    @PluginMethod
    public void closeAll(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            int closed = closeEverything();
            JSObject result = new JSObject();
            result.put("closed", closed);
            call.resolve(result);
        });
    }

    /** A real touch in the session's view, at CSS pixels `x`,`y`, or at its centre. */
    @PluginMethod
    public void tap(PluginCall call) {
        final String sessionId = call.getString("sessionId");
        final Double x = call.getDouble("x");
        final Double y = call.getDouble("y");
        getActivity().runOnUiThread(() -> {
            ProbeSession session = sessionId != null ? sessions.get(sessionId) : null;
            if (session == null) {
                call.reject("no open probe session: " + sessionId);
                return;
            }
            session.tap(x, y);
            call.resolve();
        });
    }

    /**
     * The session's requests after `after` (a cursor from a previous call; 0
     * or absent for the start), oldest first.
     *
     * A closed or vanished session answers `open: false` with nothing new,
     * rather than rejecting, so a poll loop that races a `probeGone` ends on
     * a value instead of an exception.
     */
    @PluginMethod
    public void requests(PluginCall call) {
        String sessionId = call.getString("sessionId");
        /*
         * Not `call.getLong`: it answers only when the JSON parser produced a
         * Long, and a cursor under 2^31 arrives as an Integer — so it returned
         * the default every time, every poll re-read the whole log, and the
         * first measurement counted Videasy's one playlist twenty-six times.
         */
        Object rawAfter = call.getData().opt("after");
        long after = rawAfter instanceof Number ? ((Number) rawAfter).longValue() : 0L;
        ProbeSession session = sessionId != null ? sessions.get(sessionId) : null;

        JSObject result = new JSObject();
        if (session == null) {
            result.put("requests", new JSArray());
            result.put("cursor", after);
            result.put("missed", 0);
            result.put("open", false);
            call.resolve(result);
            return;
        }

        ProbeRequestLog.Slice slice = session.requestsSince(after);
        JSArray requests = new JSArray();
        for (ProbeRequestLog.Entry entry : slice.entries) {
            JSObject item = new JSObject();
            item.put("seq", entry.seq);
            item.put("url", entry.url);
            item.put("method", entry.method);
            item.put("mainFrame", entry.mainFrame);
            item.put("atMs", entry.atMs);
            JSObject headers = new JSObject();
            for (Map.Entry<String, String> header : entry.headers.entrySet()) {
                headers.put(header.getKey(), header.getValue());
            }
            item.put("headers", headers);
            requests.put(item);
        }
        result.put("requests", requests);
        result.put("cursor", slice.cursor);
        result.put("missed", slice.missed);
        result.put("open", true);
        call.resolve(result);
    }

    /**
     * The activity is going away; take every probe with it.
     *
     * Already on the main thread here. Without this a session open when the
     * activity is destroyed would leak its WebView, its renderer's share of
     * memory and its decoder.
     */
    @Override
    protected void handleOnDestroy() {
        closeEverything();
    }

    /** Main thread only. */
    private int closeEverything() {
        int closed = 0;
        for (ProbeSession session : new ArrayList<>(sessions.values())) {
            sessions.remove(session.id);
            session.destroy();
            closed += 1;
        }
        return closed;
    }

    private final ProbeSession.Listener listener = new ProbeSession.Listener() {
        @Override
        public void onDocumentError(ProbeSession session, String url, int status, String description) {
            JSObject payload = new JSObject();
            payload.put("sessionId", session.id);
            payload.put("url", url);
            payload.put("status", status);
            payload.put("description", description != null ? description : "");
            notifyListeners("probeDocumentError", payload);
        }

        @Override
        public void onGone(ProbeSession session, String reason) {
            sessions.remove(session.id);
            JSObject payload = new JSObject();
            payload.put("sessionId", session.id);
            payload.put("reason", reason);
            notifyListeners("probeGone", payload);
        }
    };
}
