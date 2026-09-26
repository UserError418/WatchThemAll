package net.watchthemall.app;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

/**
 * One override, and it is the phone's answer to popunder ads.
 *
 * ## What it replaces
 *
 * The desktop blocks them in a single line — `setWindowOpenHandler(() =>
 * ({ action: 'deny' }))` on the player's `WebContentsView`. Every provider in
 * the catalogue monetises with popunders, so without an equivalent the phone
 * shows ads the desktop never does.
 *
 * The phone's first equivalent was the `sandbox` attribute on the player
 * iframe, which omits `allow-popups` and so makes `window.open` return null.
 * It worked, and it cost far more than it was worth: **providers detect it and
 * refuse to play.** VidFast replaces its whole page with "Please Disable
 * Sandbox" — measured, and confirmed by loading the same URL in the same
 * WebView with the attribute removed, which brings up its real player. That is
 * the larger half of "many providers won't even play in the app".
 *
 * ## Why this is the right layer
 *
 * `setJavaScriptCanOpenWindowsAutomatically(false)` makes `window.open()`
 * return null for every frame in the WebView — the same outcome the sandbox
 * produced, and the same outcome the desktop's handler produces — with nothing
 * for a page to detect, because there is no attribute and no API that reports
 * it. Capacitor turns it *on* in `Bridge.initWebView`, so this has to run
 * after `super.onCreate`.
 *
 * Nothing in the app wants `window.open`: the renderer never calls it, and
 * Capacitor's Browser plugin opens external URLs through a native intent
 * rather than through the WebView.
 *
 * `setSupportMultipleWindows` is left at its default of `false`, which is what
 * completes the pair: with multiple windows unsupported the WebView has
 * nowhere to put a popup even if one were asked for.
 *
 * Note what this does *not* claim to stop, because the desktop does not stop
 * it either: a provider navigating away after a real tap. Capacitor's own
 * `shouldOverrideUrlLoading` sends such a navigation to the system browser
 * rather than letting it take the app's window, which is the behaviour worth
 * having — the app survives it and the user comes back to it.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * Must precede super.onCreate: Capacitor builds the bridge there, and a
         * plugin registered afterwards is simply absent from `window.Capacitor`
         * with no error anywhere — the renderer's call rejects as "not
         * implemented" and the cause is three layers away.
         */
        registerPlugin(CastPlugin.class);
        registerPlugin(ScanPlugin.class);
        registerPlugin(ProbeViewPlugin.class);

        super.onCreate(savedInstanceState);

        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        // The other half of the same job: popups are blocked above, and
        // redirects are refused in `PlayerNavigationClient`. Either one alone
        // still lets an embed's advertising take the user out of the app.
        getBridge().getWebView().setWebViewClient(new PlayerNavigationClient(getBridge()));
    }
}
