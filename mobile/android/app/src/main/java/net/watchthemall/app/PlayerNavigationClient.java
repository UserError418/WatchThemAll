package net.watchthemall.app;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

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
 * Non-http schemes keep Capacitor's handling: `mailto:`, `tel:` and a plugin's
 * own `shouldOverrideLoad` hook all belong to it, and none of them is how an
 * embed advertises.
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
            return super.shouldOverrideUrlLoading(view, request);
        }

        // The app's own document, served from the Capacitor scheme host.
        if (isAppHost(url)) {
            return false;
        }

        // The player's frame navigating itself: let it, and let it stay here.
        if (!request.isForMainFrame()) {
            return false;
        }

        // A third party trying to take the whole window. Refuse and stay put.
        return true;
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
        try {
            MediaCapture.record(request, appHost());
        } catch (Exception ignored) {
            // Capture is a side feature; nothing here may break playback.
        }
        return super.shouldInterceptRequest(view, request);
    }

    private String appHost() {
        String serverUrl = bridge.getServerUrl();
        return serverUrl != null ? Uri.parse(serverUrl).getHost() : "localhost";
    }

    private boolean isAppHost(Uri url) {
        String serverUrl = bridge.getServerUrl();
        String appHost = serverUrl != null ? Uri.parse(serverUrl).getHost() : "localhost";
        return appHost != null && appHost.equals(url.getHost());
    }
}
