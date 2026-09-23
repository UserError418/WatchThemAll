package net.watchthemall.app;

import android.os.SystemClock;
import android.view.MotionEvent;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pressing play on a provider the app cannot script.
 *
 * ## Why this has to be native
 *
 * The desktop presses play two ways — a synthetic mouse event at the viewport
 * centre, and a DOM `click()` run in *every* frame of the subtree. The second
 * is the one that matters, because a play button is rarely at the centre, and
 * Electron can do it because `executeJavaScript` reaches into any frame
 * regardless of origin. That is a privilege of being the embedder.
 *
 * A WebView grants nothing of the sort. `evaluateJavascript` reaches the main
 * frame only, every provider embed is cross-origin, and most nest their player
 * an iframe deeper still. So from JavaScript there is no way to reach the
 * button at all — `scan.ts` can load a provider and watch what it fetches, and
 * for the providers that resolve nothing until something clicks, it would watch
 * forever and conclude they were dead.
 *
 * `dispatchTouchEvent` on the WebView is the one mechanism left. It enters at
 * the top of the view, exactly as a finger does, and the WebView hit-tests it
 * against its own DOM — which includes whatever is inside a cross-origin
 * iframe. Origin does not enter into it, because this is not script reaching
 * into a document; it is a touch landing on a pixel.
 *
 * ## What that means for the caller
 *
 * The coordinates are real screen pixels in the WebView, so the thing being
 * tapped has to actually be laid out where the caller says it is. A probe
 * surface positioned off-screen or collapsed to nothing cannot be tapped, and
 * an overlay drawn above it will swallow the touch unless that overlay is
 * `pointer-events: none`. `scan.ts` arranges both.
 *
 * ## Why this is not on `CastPlugin`
 *
 * Only because it is not casting. It shares nothing with that plugin but the
 * WebView, and adding an unrelated verb there is how a plugin becomes a
 * junk drawer that nobody can describe in one sentence.
 */
@CapacitorPlugin(name = "Scan")
public class ScanPlugin extends Plugin {

    /**
     * A single tap at a point in the WebView.
     *
     * Down and up are dispatched as one gesture with the same event time, which
     * is what a click listener and an autoplay policy both look for. A pair of
     * events with unrelated timestamps is read as a long press by some players
     * and ignored entirely by others.
     */
    @PluginMethod
    public void tap(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) {
            call.reject("tap needs x and y");
            return;
        }

        final float px = x.floatValue();
        final float py = y.floatValue();
        final WebView webView = getBridge().getWebView();

        /*
         * Touch dispatch is main-thread only, and a plugin method arrives on one
         * of Capacitor's worker threads. Called directly this throws a
         * CalledFromWrongThreadException that surfaces in JavaScript as an
         * opaque rejection.
         */
        getActivity().runOnUiThread(() -> {
            long now = SystemClock.uptimeMillis();
            MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, px, py, 0);
            MotionEvent up = MotionEvent.obtain(now, now, MotionEvent.ACTION_UP, px, py, 0);
            try {
                webView.dispatchTouchEvent(down);
                webView.dispatchTouchEvent(up);
            } finally {
                // Recycled explicitly: these come from a shared pool, and a scan
                // taps several times per provider across a dozen providers.
                down.recycle();
                up.recycle();
            }
            call.resolve();
        });
    }
}
