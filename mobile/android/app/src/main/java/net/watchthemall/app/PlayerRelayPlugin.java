package net.watchthemall.app;

import android.webkit.WebView;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;

/**
 * Installs the mini player's play/pause relay into the app's own WebView.
 *
 * The provider's video sits in a cross-origin iframe of the app's document,
 * and nothing in the app's JavaScript can reach inside one. A document-start
 * script can: the WebView injects it into every new document of every origin,
 * before the page's own scripts. `ProbeSession` does the same for the hidden
 * source test, in its own WebView. This does it for the app's.
 *
 * The script is written in TypeScript (`mobile/src/bridge/mediarelay.ts`),
 * where it is tested; this class only installs what it is given. It only
 * acts on messages from a frame's own parent, and does nothing in the app's
 * own document.
 */
@CapacitorPlugin(name = "PlayerRelay")
public class PlayerRelayPlugin extends Plugin {
    /** Held so that installing again replaces the script rather than stacking a second. */
    private ScriptHandler handler;

    @PluginMethod
    public void install(PluginCall call) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) {
            call.reject("script is required");
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // An old WebView: the button will do nothing, and the provider's
            // own controls stay the way to pause. Not an error worth failing on.
            JSObject result = new JSObject();
            result.put("installed", false);
            call.resolve(result);
            return;
        }
        // WebView methods belong to the UI thread; plugin calls arrive on
        // Capacitor's own.
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            if (handler != null) handler.remove();
            handler = WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton("*"));
            JSObject result = new JSObject();
            result.put("installed", true);
            call.resolve(result);
        });
    }

    /**
     * Silence the app's WebView, every frame of it, or give it its sound back.
     *
     * While the television has the film the phone must make no sound, and an
     * episode step loads the source on the phone again (its stream is what the
     * television is handed). A page cannot unmute this; it is the WebView's.
     * Resolves with whether the WebView is muted now: never, where it predates
     * the feature.
     */
    @PluginMethod
    public void setMuted(PluginCall call) {
        boolean muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MUTE_AUDIO)) {
            JSObject result = new JSObject();
            result.put("muted", false);
            call.resolve(result);
            return;
        }
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            WebViewCompat.setAudioMuted(webView, muted);
            JSObject result = new JSObject();
            result.put("muted", WebViewCompat.isAudioMuted(webView));
            call.resolve(result);
        });
    }
}
