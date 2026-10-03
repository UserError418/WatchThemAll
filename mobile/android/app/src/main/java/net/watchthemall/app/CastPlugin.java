package net.watchthemall.app;

import android.os.Handler;
import android.util.Base64;
import android.os.Looper;
import android.util.Log;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastDevice;
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
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

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

    /** How long a television gets to finish connecting before we say so. */
    private static final long CONNECT_TIMEOUT_MS = 20_000L;

    /**
     * The proxy is the process's, not this plugin instance's.
     *
     * With the keep-alive service up, the process outlives the activity: the
     * task swiped away mid-cast, or the activity rebuilt after its WebView's
     * renderer died. The television is still fetching from the server then,
     * and the rebuilt activity gets a new plugin. With a server per instance,
     * that new one reported no proxy for a cast in progress and never started
     * the progress ticker, so the television's position stopped being saved.
     */
    private static final CastProxyServer PROXY = new CastProxyServer();

    /**
     * Where `fetchText` does its blocking work.
     *
     * Capacitor runs every plugin call, of every plugin, on one shared thread.
     * A fetch held that thread for up to its 15-second timeouts, and a scan
     * makes dozens, so the library's own file writes and every other plugin
     * call queued behind a slow provider. Four at once is more than a scan's
     * two probes ask for.
     */
    private final ExecutorService fetchPool = Executors.newFixedThreadPool(4);

    /**
     * The `connect` call still waiting for its session to actually exist.
     *
     * Selecting a route only *starts* a connection; the CastSession appears
     * later, through the session listener. Resolving `connect` at selection
     * time is what produced "the Chromecast is connected but not ready" on a
     * real device — `beam` ran immediately afterwards and asked a session that
     * was still being built for its RemoteMediaClient, which was null.
     */
    private PluginCall pendingConnect;

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
                // A cast the previous activity started is still being served.
                if (PROXY.isRunning()) startProgress();
            } catch (Exception error) {
                // Play Services missing or too old. Every method below reports
                // this as "unavailable" rather than crashing the app: casting is
                // one feature, and the rest of the app does not depend on it.
                Log.w(TAG, "Cast unavailable: " + error);
                castContext = null;
            }
        });
    }

    /**
     * The activity is going. The cast is not, so only what is this
     * instance's is let go: its session listener (or a rebuilt activity's
     * plugin and this one would both act on a session ending), its discovery
     * callback, its ticker, a connect still waiting, and its fetch threads.
     */
    @Override
    protected void handleOnDestroy() {
        stopProgress();
        if (castContext != null) {
            castContext.getSessionManager().removeSessionManagerListener(sessionListener, CastSession.class);
        }
        if (mediaRouter != null && routeCallback != null) mediaRouter.removeCallback(routeCallback);
        if (pendingConnect != null) {
            pendingConnect.reject("the app was closed");
            pendingConnect = null;
        }
        fetchPool.shutdown();
    }

    /** Run `work` on the fetch threads; after `handleOnDestroy` there are none, and the call says so. */
    private void offThread(PluginCall call, Runnable work) {
        try {
            fetchPool.execute(work);
        } catch (RejectedExecutionException closed) {
            call.reject("the app was closed");
        }
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
     *
     * With `encoding: "base64"` the body comes back as the raw bytes, base64
     * encoded, for the scan's quality reading: an init segment or the head of a
     * TS segment is binary, and decoding it as UTF-8 would replace every byte
     * that is not valid text — which is most of them — before JavaScript saw it.
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
        boolean binary = "base64".equals(call.getString("encoding", "text"));
        offThread(call, () -> fetchTextNow(call, url, headers, limit, binary));
    }

    /**
     * Fetch a URL with the source's headers straight into a file, for the
     * preview cache (`src/main/segmentsave.ts`). The bytes never cross into
     * the WebView: a window is several megabytes, and base64 over the bridge
     * would triple that in memory for nothing, since the page plays the file
     * from disk (`convertFileSrc`).
     *
     * `path` is relative to the app's files directory and must stay under
     * `preview-cache/`: nothing else there is this method's to write. Resolves
     * with the status, the bytes written and the first bytes (base64), which
     * the TypeScript side reads to tell a segment from an error page.
     */
    @PluginMethod
    public void downloadToFile(PluginCall call) {
        String url = call.getString("url");
        String path = call.getString("path");
        if (url == null || path == null) {
            call.reject("url and path are required");
            return;
        }
        java.io.File root = new java.io.File(getContext().getFilesDir(), "preview-cache");
        java.io.File target = new java.io.File(getContext().getFilesDir(), path);
        try {
            if (!target.getCanonicalPath().startsWith(root.getCanonicalPath() + java.io.File.separator)) {
                call.reject("path must be under preview-cache/");
                return;
            }
        } catch (IOException error) {
            call.reject("bad path");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());
        offThread(call, () -> downloadNow(call, url, headers, target));
    }

    /** `downloadToFile`'s request, on `fetchPool`. */
    private static void downloadNow(PluginCall call, String url, JSObject headers, java.io.File target) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setInstanceFollowRedirects(true);
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    connection.setRequestProperty(key, headers.getString(key));
                }
            }
            int status = connection.getResponseCode();
            long written = 0;
            byte[] head = new byte[400];
            int headLength = 0;
            if (status < 400) {
                java.io.File parent = target.getParentFile();
                if (parent != null) parent.mkdirs();
                try (InputStream in = connection.getInputStream();
                        java.io.FileOutputStream out = new java.io.FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (headLength < head.length) {
                            int take = Math.min(read, head.length - headLength);
                            System.arraycopy(buffer, 0, head, headLength, take);
                            headLength += take;
                        }
                        out.write(buffer, 0, read);
                        written += read;
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("bytes", written);
            result.put("head", Base64.encodeToString(head, 0, headLength, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("download failed: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** `fetchText`'s request, on `fetchPool`. A `PluginCall` may be resolved from any thread. */
    private static void fetchTextNow(PluginCall call, String url, JSObject headers, int limit, boolean binary) {
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
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = binary ? readBase64(stream, limit) : readText(stream, limit);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("contentType", connection.getContentType() != null ? connection.getContentType() : "");
            result.put("body", body);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("fetch failed: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Up to `limit` characters of a response, as UTF-8 text.
     *
     * A body we cannot read comes back empty; the status is reported beside it
     * and the caller decides whether that disqualifies the candidate.
     */
    private static String readText(InputStream stream, int limit) {
        StringBuilder body = new StringBuilder();
        if (stream == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) != -1 && body.length() < limit) {
                body.append(buffer, 0, read);
            }
        } catch (Exception ignored) {
            // Whatever was read before the failure is still returned.
        }
        return body.toString();
    }

    /** Up to `limit` bytes of a response, base64 encoded; empty when unreadable. */
    private static String readBase64(InputStream stream, int limit) {
        if (stream == null) return "";
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream in = stream) {
            byte[] buffer = new byte[8192];
            int read;
            while (bytes.size() < limit && (read = in.read(buffer, 0, Math.min(buffer.length, limit - bytes.size()))) != -1) {
                bytes.write(buffer, 0, read);
            }
        } catch (Exception ignored) {
            // Whatever was read before the failure is still returned.
        }
        return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
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
        // The receiver's address belongs to the Cast session, which is the
        // main thread's to read; finding the route to it opens a socket, which
        // Android refuses on the main thread. Hence the two hops.
        getActivity().runOnUiThread(() -> {
            InetAddress receiver = receiverAddress();
            offThread(call, () -> startProxyNow(call, receiver));
        });
    }

    private void startProxyNow(PluginCall call, InetAddress receiver) {
        try {
            JSObject playlistsIn = call.getObject("playlists", new JSObject());
            JSObject targetsIn = call.getObject("targets", new JSObject());
            JSObject headersIn = call.getObject("headers", new JSObject());

            InetAddress address = CastProxyServer.lanAddress(receiver);
            if (address == null) {
                call.reject("no local network address — casting needs Wi-Fi");
                return;
            }

            int port = PROXY.start(address);
            PROXY.load(toMap(playlistsIn), toMap(targetsIn), toMap(headersIn));
            CastKeepAliveService.start(getContext());
            startProgress();

            JSObject result = new JSObject();
            result.put("base", "http://" + address.getHostAddress() + ":" + port + "/");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("proxy failed to start: " + error.getMessage());
        }
    }

    /** The connected receiver's address, or null with none. Main thread only. */
    private InetAddress receiverAddress() {
        CastSession session = currentSession();
        CastDevice device = session != null ? session.getCastDevice() : null;
        return device != null ? device.getInetAddress() : null;
    }

    @PluginMethod
    public void stopProxy(PluginCall call) {
        PROXY.stop();
        CastKeepAliveService.stop(getContext());
        stopProgress();
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
            // Already attached to something: nothing to wait for.
            CastSession existing = currentSession();
            if (existing != null && existing.isConnected()) {
                call.resolve();
                return;
            }

            for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
                if (!route.getId().equals(id)) continue;

                if (pendingConnect != null) pendingConnect.reject("superseded by another connection");
                pendingConnect = call;
                // Held open deliberately — Capacitor would otherwise discard the
                // call object once this method returns and the later resolve
                // would go nowhere.
                call.setKeepAlive(true);

                mediaRouter.selectRoute(route);

                /*
                 * A television that is off, or busy with another sender, never
                 * completes the session and never reports a failure either. A
                 * bounded wait turns that into a sentence the user can act on
                 * instead of a spinner that never stops.
                 */
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (pendingConnect != call) return;
                    pendingConnect = null;
                    call.reject("the TV did not finish connecting — it may be off or in use");
                }, CONNECT_TIMEOUT_MS);
                return;
            }
            call.reject("no such device — it may have gone off the network");
        });
    }

    /** Finish whichever `connect` is outstanding, if any. */
    private void settleConnect(boolean ok, String error) {
        PluginCall call = pendingConnect;
        if (call == null) return;
        pendingConnect = null;
        if (ok) {
            call.resolve();
        } else {
            call.reject(error);
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (castContext != null) castContext.getSessionManager().endCurrentSession(true);
            PROXY.stop();
            CastKeepAliveService.stop(getContext());
            stopProgress();
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
     * The receiver's volume and mute.
     *
     * `CastSession`, not `RemoteMediaClient`: this is the *device's* volume,
     * which on a television doing HDMI-CEC is the set's own. It therefore
     * works with nothing playing, which is why it is not another `control`
     * action — that one needs a media client and correctly refuses without
     * one.
     *
     * Either field may be absent; the call sets only what it was given, so
     * muting does not silently also reset the level.
     */
    @PluginMethod
    public void setVolume(PluginCall call) {
        Double level = call.getDouble("level");
        Boolean muted = call.getBoolean("muted");

        getActivity().runOnUiThread(() -> {
            CastSession session = currentSession();
            if (session == null) {
                call.reject("not connected to a Chromecast");
                return;
            }
            try {
                if (level != null) {
                    double clamped = Math.max(0.0, Math.min(1.0, level));
                    session.setVolume(clamped);
                }
                if (muted != null) session.setMute(muted);
                call.resolve();
            } catch (IOException error) {
                // The session went away between the null check and the call,
                // which is ordinary on a flaky network rather than exceptional.
                call.reject("the TV did not accept the volume change", error);
            }
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
            result.put("proxyRunning", PROXY.isRunning());

            // Device volume, and it survives having nothing to play: a
            // connected receiver has a volume before and after a stream.
            if (session != null && session.isConnected()) {
                result.put("volume", session.getVolume());
                result.put("muted", session.isMute());
            } else {
                result.put("volume", 0);
                result.put("muted", false);
            }

            putPlayback(result, client);
            call.resolve(result);
        });
    }

    /**
     * Where the television is: position, length, playing, and whether it
     * played to the end (IDLE with reason FINISHED, as opposed to paused or
     * stopped) — what starts auto-next on the television (main/upnext.ts).
     * Shared by `status` and the progress ticker so the two cannot disagree.
     */
    private static void putPlayback(JSObject result, RemoteMediaClient client) {
        if (client == null) {
            result.put("playing", false);
            result.put("seconds", 0);
            result.put("duration", 0);
            result.put("idleReason", 0);
            result.put("finished", false);
            return;
        }
        MediaStatus status = client.getMediaStatus();
        result.put("playing", client.isPlaying());
        result.put("seconds", client.getApproximateStreamPosition() / 1000.0);
        result.put("duration", client.getStreamDuration() / 1000.0);
        result.put("idleReason", status != null ? status.getIdleReason() : 0);
        result.put(
            "finished",
            status != null
                && status.getPlayerState() == MediaStatus.PLAYER_STATE_IDLE
                && status.getIdleReason() == MediaStatus.IDLE_REASON_FINISHED
        );
    }

    /**
     * The television's position, pushed to JavaScript every five seconds while
     * a stream is served to it (`castProgress`).
     *
     * Pushed from here rather than polled from JavaScript because, measured on
     * the emulator (2026-09-27), a backgrounded app's JavaScript timers run
     * once a minute even with the keep-alive service up — and a phone casting
     * is usually a phone in a pocket. An event from native code is not a
     * timer, and runs at once. It drives the position being saved and synced,
     * the television's end being noticed, and auto-next's countdown.
     */
    private static final long PROGRESS_EVERY_MS = 5_000L;
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressTick = new Runnable() {
        @Override
        public void run() {
            CastSession session = currentSession();
            RemoteMediaClient client = session != null && session.isConnected() ? session.getRemoteMediaClient() : null;
            if (client != null && client.getMediaStatus() != null) {
                JSObject payload = new JSObject();
                putPlayback(payload, client);
                notifyListeners("castProgress", payload);
            }
            progressHandler.postDelayed(this, PROGRESS_EVERY_MS);
        }
    };

    private void startProgress() {
        progressHandler.removeCallbacks(progressTick);
        progressHandler.postDelayed(progressTick, PROGRESS_EVERY_MS);
    }

    private void stopProgress() {
        progressHandler.removeCallbacks(progressTick);
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
            // The moment `connect` has been waiting for: a session that can
            // actually hand out a RemoteMediaClient.
            settleConnect(true, null);
            notifyListeners("castSession", statusObject("started", session));
        }

        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            settleConnect(true, null);
            notifyListeners("castSession", statusObject("resumed", session));
        }

        @Override
        public void onSessionEnded(CastSession session, int error) {
            PROXY.stop();
            CastKeepAliveService.stop(getContext());
            stopProgress();
            notifyListeners("castSession", statusObject("ended", session));
        }

        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            settleConnect(false, "the TV refused the connection (code " + error + ")");
            PROXY.stop();
            CastKeepAliveService.stop(getContext());
            stopProgress();
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
            PROXY.stop();
            CastKeepAliveService.stop(getContext());
            stopProgress();
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
