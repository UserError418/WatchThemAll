package net.watchthemall.app;

import android.util.Log;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaSeekOptions;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Everything the phone needs to put a provider's stream on a Chromecast.
 *
 * Four jobs, deliberately in one plugin because they are useless apart:
 *
 *  1. **Hand over what the player fetched.** `MediaCapture` records candidates
 *     off the WebView; this exposes them, and `fetchText` lets the JavaScript
 *     side find out which one is actually a playlist by fetching it rather than
 *     by pattern-matching a URL. That distinction is the reason two of the
 *     catalogue's best providers report "no stream" to the desktop extractor.
 *  2. **Run the proxy**, so the receiver's own requests carry the provider's
 *     headers. See `CastProxyServer`.
 *  3. **Drive the Cast session** — discover, connect, load, control.
 *  4. **Keep the process alive** while a cast runs, via `CastKeepAliveService`.
 *     Without it the phone is a media server that Android is free to kill the
 *     moment the user leaves the app, which is precisely when they will.
 *
 * ## Threading
 *
 * Every Cast SDK and MediaRouter call must happen on the main thread; Capacitor
 * dispatches plugin calls on a worker. So each method that touches either hops
 * with `runOnUiThread` and resolves from there. Getting this wrong throws
 * `CalledFromWrongThreadException` intermittently rather than always, which is
 * the worst way for it to be wrong.
 */
@CapacitorPlugin(name = "Cast")
public class CastPlugin extends Plugin {

    private static final String TAG = "CastPlugin";

    private final CastProxyServer proxy = new CastProxyServer();

    private CastContext castContext;
    private MediaRouter mediaRouter;
    private MediaRouteSelector selector;
    private MediaRouter.Callback routeCallback;

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            try {
                castContext = CastContext.getSharedInstance(getContext());
                mediaRouter = MediaRouter.getInstance(getContext());
                selector = new MediaRouteSelector.Builder()
                    .addControlCategory(
                        CastMediaControlIntent.categoryForCast(
                            CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
                        )
                    )
                    .build();

                castContext.getSessionManager().addSessionManagerListener(sessionListener, CastSession.class);
            } catch (Exception error) {
                // Play Services missing or too old. Every method below reports
                // this as "unavailable" rather than crashing the app: casting is
                // one feature, and the rest of the app does not depend on it.
                Log.w(TAG, "Cast unavailable: " + error);
                castContext = null;
            }
        });
    }

    /* ── Captured stream candidates ─────────────────────────────────────── */

    /**
     * What the player has fetched recently, newest first.
     *
     * No judgement is applied here — see `MediaCapture` for why a URL pattern
     * cannot tell a manifest from an API call on these providers.
     */
    @PluginMethod
    public void candidates(PluginCall call) {
        JSArray out = new JSArray();
        for (MediaCapture.Candidate candidate : MediaCapture.candidates()) {
            JSObject entry = new JSObject();
            entry.put("url", candidate.url);
            entry.put("atMs", candidate.atMs);
            JSObject headers = new JSObject();
            for (Map.Entry<String, String> header : candidate.headers.entrySet()) {
                headers.put(header.getKey(), header.getValue());
            }
            entry.put("headers", headers);
            out.put(entry);
        }
        JSObject result = new JSObject();
        result.put("candidates", out);
        call.resolve(result);
    }

    /** Forget captures, so the next title cannot be cast using this one's URL. */
    @PluginMethod
    public void clearCandidates(PluginCall call) {
        MediaCapture.clear();
        call.resolve();
    }

    /**
     * Fetch a URL with arbitrary headers and return its body as text.
     *
     * Needed because the JavaScript side has to *read* a playlist to rewrite it,
     * and the headers that make that fetch succeed include `Referer` and
     * `Origin` — names a browser refuses to let a page set, whatever its CORS
     * situation. Capped, because a candidate may turn out to be a video file and
     * reading a feature-length one into a string would take the app out.
     */
    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());
        int limit = call.getInt("limitBytes", 4 * 1024 * 1024);

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(15_000);
            connection.setInstanceFollowRedirects(true);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    connection.setRequestProperty(key, headers.getString(key));
                }
            }

            int status = connection.getResponseCode();
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(
                    status >= 400 ? connection.getErrorStream() : connection.getInputStream(),
                    StandardCharsets.UTF_8
                )
            )) {
                char[] buffer = new char[8192];
                int read;
                while ((read = reader.read(buffer)) != -1 && body.length() < limit) {
                    body.append(buffer, 0, read);
                }
            } catch (Exception ignored) {
                // A body we cannot read is reported through `status` below; the
                // caller decides whether that disqualifies the candidate.
            }

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("contentType", connection.getContentType() != null ? connection.getContentType() : "");
            result.put("body", body.toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("fetch failed: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /* ── The proxy ──────────────────────────────────────────────────────── */

    /**
     * Publish a rewritten bundle and start serving it.
     *
     * Resolves with the base URL to prefix onto the bundle's root id. Rejects
     * when there is no LAN address, which is the honest answer on mobile data —
     * a Chromecast cannot reach the phone and every later step would time out
     * with a less useful message.
     */
    @PluginMethod
    public void startProxy(PluginCall call) {
        try {
            JSObject playlistsIn = call.getObject("playlists", new JSObject());
            JSObject targetsIn = call.getObject("targets", new JSObject());
            JSObject headersIn = call.getObject("headers", new JSObject());

            String address = CastProxyServer.lanAddress();
            if (address == null) {
                call.reject("no local network address — casting needs Wi-Fi");
                return;
            }

            int port = proxy.start();
            proxy.load(toMap(playlistsIn), toMap(targetsIn), toMap(headersIn));
            CastKeepAliveService.start(getContext());

            JSObject result = new JSObject();
            result.put("base", "http://" + address + ":" + port + "/");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("proxy failed to start: " + error.getMessage());
        }
    }

    @PluginMethod
    public void stopProxy(PluginCall call) {
        proxy.stop();
        CastKeepAliveService.stop(getContext());
        call.resolve();
    }

    private static Map<String, String> toMap(JSONObject source) {
        Map<String, String> out = new HashMap<>();
        if (source == null) return out;
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            out.put(key, source.optString(key, ""));
        }
        return out;
    }

    /* ── Devices and sessions ───────────────────────────────────────────── */

    /**
     * Start looking for Chromecasts, and report what turns up.
     *
     * Discovery is active — it costs battery and multicast traffic — so it is
     * started when the user opens the cast picker and stopped when they leave
     * it, rather than running for the life of the app.
     */
    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (castContext == null) {
            call.reject("Google Cast is unavailable on this device");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (routeCallback == null) {
                routeCallback = new MediaRouter.Callback() {
                    @Override
                    public void onRouteAdded(MediaRouter router, MediaRouter.RouteInfo route) {
                        emitDevices();
                    }

                    @Override
                    public void onRouteRemoved(MediaRouter router, MediaRouter.RouteInfo route) {
                        emitDevices();
                    }

                    @Override
                    public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) {
                        emitDevices();
                    }
                };
            }
            mediaRouter.addCallback(selector, routeCallback, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY);
            emitDevices();
            call.resolve();
        });
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (mediaRouter != null && routeCallback != null) mediaRouter.removeCallback(routeCallback);
            call.resolve();
        });
    }

    @PluginMethod
    public void devices(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            call.resolve(deviceList());
            });
    }

    private JSObject deviceList() {
        JSArray out = new JSArray();
        if (mediaRouter != null) {
            List<MediaRouter.RouteInfo> routes = mediaRouter.getRoutes();
            for (MediaRouter.RouteInfo route : routes) {
                if (!route.matchesSelector(selector) || route.isDefault()) continue;
                JSObject entry = new JSObject();
                entry.put("id", route.getId());
                entry.put("name", route.getName());
                entry.put("selected", route.isSelected());
                out.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("devices", out);
        return result;
    }

    private void emitDevices() {
        notifyListeners("castDevices", deviceList());
    }

    /** Connect to one device by the id `devices` reported. */
    @PluginMethod
    public void connect(PluginCall call) {
        String id = call.getString("deviceId");
        if (id == null) {
            call.reject("deviceId is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
                if (route.getId().equals(id)) {
                    mediaRouter.selectRoute(route);
                    call.resolve();
                    return;
                }
            }
            call.reject("no such device — it may have gone off the network");
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (castContext != null) castContext.getSessionManager().endCurrentSession(true);
            proxy.stop();
            CastKeepAliveService.stop(getContext());
            call.resolve();
        });
    }

    /* ── Playback ───────────────────────────────────────────────────────── */

    /**
     * Put a stream on the connected receiver.
     *
     * `contentUrl` is a proxy URL, never a provider URL: see `CastProxyServer`
     * for why handing over the original would fail on most of the catalogue.
     */
    @PluginMethod
    public void loadMedia(PluginCall call) {
        String contentUrl = call.getString("url");
        if (contentUrl == null) {
            call.reject("url is required");
            return;
        }
        String title = call.getString("title", "");
        String subtitle = call.getString("subtitle", "");
        String contentType = call.getString("contentType", "application/x-mpegurl");
        double startSeconds = call.getDouble("startSeconds", 0.0);

        getActivity().runOnUiThread(() -> {
            CastSession session = currentSession();
            if (session == null) {
                call.reject("not connected to a Chromecast");
                return;
            }
            RemoteMediaClient client = session.getRemoteMediaClient();
            if (client == null) {
                call.reject("the Chromecast is connected but not ready");
                return;
            }

            MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
            metadata.putString(MediaMetadata.KEY_TITLE, title);
            metadata.putString(MediaMetadata.KEY_SUBTITLE, subtitle);

            MediaInfo info = new MediaInfo.Builder(contentUrl)
                .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(contentType)
                .setMetadata(metadata)
                .build();

            client.load(
                new MediaLoadRequestData.Builder()
                    .setMediaInfo(info)
                    .setAutoplay(true)
                    .setCurrentTime((long) (startSeconds * 1000))
                    .build()
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void control(PluginCall call) {
        String action = call.getString("action", "");
        double seconds = call.getDouble("seconds", 0.0);

        getActivity().runOnUiThread(() -> {
            CastSession session = currentSession();
            RemoteMediaClient client = session != null ? session.getRemoteMediaClient() : null;
            if (client == null) {
                call.reject("not connected to a Chromecast");
                return;
            }
            switch (action) {
                case "play":
                    client.play();
                    break;
                case "pause":
                    client.pause();
                    break;
                case "stop":
                    client.stop();
                    break;
                case "seek":
                    client.seek(new MediaSeekOptions.Builder().setPosition((long) (seconds * 1000)).build());
                    break;
                default:
                    call.reject("unknown action: " + action);
                    return;
            }
            call.resolve();
        });
    }

    /**
     * Where the cast is right now.
     *
     * Polled rather than pushed for position, because `RemoteMediaClient`'s
     * progress listener fires on the main thread at a rate the WebView bridge
     * would have to marshal; a one-second poll from the renderer costs less and
     * the UI cannot show more than that anyway.
     */
    @PluginMethod
    public void status(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            CastSession session = currentSession();
            RemoteMediaClient client = session != null ? session.getRemoteMediaClient() : null;

            result.put("available", castContext != null);
            result.put("connected", session != null && session.isConnected());
            result.put(
                "deviceName",
                session != null && session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : ""
            );
            result.put("proxyRunning", proxy.isRunning());

            if (client != null) {
                result.put("playing", client.isPlaying());
                result.put("seconds", client.getApproximateStreamPosition() / 1000.0);
                result.put("duration", client.getStreamDuration() / 1000.0);
                MediaStatus status = client.getMediaStatus();
                result.put("idleReason", status != null ? status.getIdleReason() : 0);
            } else {
                result.put("playing", false);
                result.put("seconds", 0);
                result.put("duration", 0);
                result.put("idleReason", 0);
            }
            call.resolve(result);
        });
    }

    private CastSession currentSession() {
        if (castContext == null) return null;
        return castContext.getSessionManager().getCurrentCastSession();
    }

    /**
     * Tell the renderer when a session comes and goes.
     *
     * The ending cases matter more than the starting one: the proxy must stop
     * when the session does, or the phone keeps a server open on the LAN with
     * nothing reading from it.
     */
    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            notifyListeners("castSession", statusObject("started", session));
        }

        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            notifyListeners("castSession", statusObject("resumed", session));
        }

        @Override
        public void onSessionEnded(CastSession session, int error) {
            proxy.stop();
            CastKeepAliveService.stop(getContext());
            notifyListeners("castSession", statusObject("ended", session));
        }

        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            proxy.stop();
            CastKeepAliveService.stop(getContext());
            JSObject payload = statusObject("failed", session);
            payload.put("error", error);
            notifyListeners("castSession", payload);
        }

        @Override
        public void onSessionSuspended(CastSession session, int reason) {
            notifyListeners("castSession", statusObject("suspended", session));
        }

        @Override
        public void onSessionResumeFailed(CastSession session, int error) {
            // Resumption is switched off in CastOptionsProvider, so this is only
            // reached when the system tries on its own behalf. Treated exactly
            // like a failed start: tear the proxy down rather than leave a
            // server running for a session that does not exist.
            proxy.stop();
            CastKeepAliveService.stop(getContext());
            JSObject payload = statusObject("failed", session);
            payload.put("error", error);
            notifyListeners("castSession", payload);
        }

        @Override
        public void onSessionStarting(CastSession session) {}

        @Override
        public void onSessionEnding(CastSession session) {}

        @Override
        public void onSessionResuming(CastSession session, String sessionId) {}
    };

    private JSObject statusObject(String state, CastSession session) {
        JSObject payload = new JSObject();
        payload.put("state", state);
        payload.put(
            "deviceName",
            session != null && session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : ""
        );
        return payload;
    }
}
