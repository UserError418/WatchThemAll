package net.watchthemall.app;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.Map;

/**
 * Keeps the app in the app.
 *
 * A provider embed is an advertising surface, and its ads are navigations: the
 * page tries to take the user somewhere else, either from inside the player
 * frame or by aiming at the top one. On desktop neither can reach the app,
 * because the player is a separate `WebContentsView` — a redirect inside it
 * navigates *it*, and the app window is not involved at all.
 *
 * A WebView has no such separation, and Capacitor's default makes it worse
 * rather than better: `Bridge.launchIntent` fires an `ACTION_VIEW` for any
 * navigation to a host that is not the app's, so an ad redirect does not just
 * interrupt playback — it leaves the app entirely. Measured after the iframe's
 * `sandbox` attribute came off: one tap on VidRock's play button and the
 * emulator was sitting on Chrome's first-run screen.
 *
 * So this restores the desktop's two outcomes, and nothing else:
 *
 * - **A navigation inside the player frame is allowed**, and stays in the
 *   frame. The picture may be replaced by an ad, which is recoverable — the
 *   player chrome has a reload button and a source switcher a tap away.
 * - **A navigation of the main frame to a third party is refused outright.**
 *   Returning `true` says "handled" and then does nothing, so the WebView goes
 *   nowhere and no intent is fired. The app is still there.
 *
 * Every other scheme is refused, apart from the documents a WebView shows by
 * itself (`data:`, `blob:`, `about:`). Handed on to Capacitor, it became an
 * `ACTION_VIEW` intent, which is exactly how an advert opens the Play Store or
 * another app over the film.
 */
public class PlayerNavigationClient extends BridgeWebViewClient {

    private final Bridge bridge;

    public PlayerNavigationClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String scheme = url.getScheme();

        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            // Documents the WebView shows itself, which frames use all the time.
            if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) return false;
            // Refused from any frame, whatever started it. Capacitor's
            // `launchIntent` fires ACTION_VIEW for these, so an advert in the
            // player's frame naming `market://` or another app's scheme put
            // that app over the film. A tap does not tell the user's own
            // navigation from an advert's, and the app never navigates to such
            // a scheme itself: external links go through the Browser plugin.
            return true;
        }

        // The player's frame navigating itself: let it, and let it stay here.
        if (!request.isForMainFrame()) {
            return false;
        }

        // The main frame may only ever hold the app's own page. Anything else
        // is a third party trying to take the whole window, and so is any other
        // address on the app's host, which used to pass on the host alone:
        // `/_capacitor_file_/` serves the app's private files there, under the
        // app's origin. Refuse and stay put.
        return !isAppDocument(url);
    }

    /**
     * Watch what the provider's player fetches, and change nothing about it.
     *
     * This is the only place on Android where the app can see inside the
     * player's cross-origin frame. It fires for every subresource of every
     * frame and hands over both the URL and the request headers, which together
     * are exactly what casting needs: the manifest to point the Chromecast at,
     * and the `Referer`/`Origin` the provider requires and the Chromecast
     * cannot send. See `MediaCapture` and `src/main/hlsrewrite.ts`.
     *
     * **Returning null is load-bearing.** It tells the WebView to handle the
     * request itself, exactly as if this method did not exist. Returning a
     * response would make the app the transport for every request the embed
     * makes, and it would then own redirects, cookies, ranges and compression —
     * a large surface, all of it invisible to this project's gates, in exchange
     * for nothing this feature needs.
     *
     * Called on the WebView's network threads, so it must not block: capturing
     * does no I/O, and the decision about what any of it *means* is deferred to
     * TypeScript at cast time.
     */
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (isFileDocument(request)) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
        try {
            MediaCapture.record(request, appHost());
        } catch (Exception ignored) {
            // Capture is a side feature; nothing here may break playback.
        }
        return super.shouldInterceptRequest(view, request);
    }

    /**
     * A frame opening one of the app's files as a page.
     *
     * Capacitor serves the app's private files under the app's own origin, at
     * `/_capacitor_file_/` (that is how the preview cache plays from disk), to
     * any frame that asks, a provider's included. The app only ever plays them
     * as media. Opened as a document, a file holding a page would run with the
     * app's origin, and with it the reach of the native bridge and of the app's
     * own window. The preview cache keeps bytes a provider served, so that is
     * not a file this can rule out. Navigations are told apart as Capacitor's
     * own HTTP proxy tells them apart (`isDocumentRequest`), with Sec-Fetch-Dest
     * where the WebView passes it on.
     */
    private boolean isFileDocument(WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path == null || !isAppHost(url)) return false;
        if (!path.startsWith(Bridge.CAPACITOR_FILE_START) && !path.startsWith(Bridge.CAPACITOR_CONTENT_START)) return false;
        if (request.isForMainFrame()) return true;
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return false;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            String name = header.getKey();
            if ("Upgrade-Insecure-Requests".equalsIgnoreCase(name)) return true;
            if ("Sec-Fetch-Dest".equalsIgnoreCase(name)) {
                String dest = header.getValue();
                if ("document".equals(dest) || "iframe".equals(dest) || "frame".equals(dest)
                    || "embed".equals(dest) || "object".equals(dest)) return true;
            }
        }
        return false;
    }

    private String appHost() {
        String serverUrl = bridge.getServerUrl();
        return serverUrl != null ? Uri.parse(serverUrl).getHost() : "localhost";
    }

    /**
     * The app's own page: its index on the Capacitor host, over https because
     * `capacitor.config.ts` sets `androidScheme: 'https'`.
     */
    private boolean isAppDocument(Uri url) {
        String path = url.getPath();
        boolean index = path == null || path.isEmpty() || "/".equals(path) || "/index.html".equals(path);
        return index && "https".equals(url.getScheme()) && isAppHost(url);
    }

    private boolean isAppHost(Uri url) {
        String serverUrl = bridge.getServerUrl();
        String appHost = serverUrl != null ? Uri.parse(serverUrl).getHost() : "localhost";
        return appHost != null && appHost.equals(url.getHost());
    }
}
