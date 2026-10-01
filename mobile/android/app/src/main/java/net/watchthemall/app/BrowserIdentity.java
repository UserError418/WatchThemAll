package net.watchthemall.app;

import android.webkit.WebSettings;

import androidx.webkit.UserAgentMetadata;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

import java.util.ArrayList;
import java.util.List;

/**
 * The browser the phone app presents as: Chrome on Android, at the WebView's
 * own engine version, in every WebView that loads a source.
 *
 * An Android WebView names itself twice. Its User-Agent carries {@code ; wv}
 * and {@code Version/4.0}, and its client hints carry an "Android WebView"
 * brand. Some sources refuse it for that alone: Videm, the server 2Embed
 * plays, answers any WebView User-Agent with "This player is not available
 * here" and the same request from Chrome on Android with its player
 * (measured 2026-10-01, curl, both User-Agents, same address).
 *
 * Both are changed together, for the reason the desktop learned the hard way
 * ({@code src/main/identity.ts}): the User-Agent string is what the page's
 * {@code navigator.userAgent} reports as well as what the requests send, and
 * the brands are what {@code navigator.userAgentData} reports as well as the
 * {@code Sec-CH-UA} header. Changing one and not the other is a browser that
 * contradicts itself, which is what checks look for. Everything else — the
 * version, the platform, the device — stays the engine's own.
 *
 * Applied to the app's WebView ({@link MainActivity}), which holds the player
 * and preview frames, and to each hidden probe ({@link ProbeSession}), so a
 * source test sees what the player would.
 */
final class BrowserIdentity {

    private static final String WEBVIEW_BRAND = "Android WebView";

    private BrowserIdentity() {}

    /** The WebView's User-Agent without the two tokens that say it is one. Idempotent. */
    static String chromeUserAgent(String webViewUserAgent) {
        return webViewUserAgent.replace("; wv)", ")").replace(" Version/4.0", "");
    }

    static void apply(WebSettings settings) {
        settings.setUserAgentString(chromeUserAgent(settings.getUserAgentString()));

        // Older WebViews cannot set the hints. There only the User-Agent
        // changes, which is what the measured block looks at.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.USER_AGENT_METADATA)) return;
        UserAgentMetadata current = WebSettingsCompat.getUserAgentMetadata(settings);
        List<UserAgentMetadata.BrandVersion> brands = new ArrayList<>();
        for (UserAgentMetadata.BrandVersion brand : current.getBrandVersionList()) {
            if (!WEBVIEW_BRAND.equals(brand.getBrand())) brands.add(brand);
        }
        WebSettingsCompat.setUserAgentMetadata(
                settings, new UserAgentMetadata.Builder(current).setBrandVersionList(brands).build());
    }
}
