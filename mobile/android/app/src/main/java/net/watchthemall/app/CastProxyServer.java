package net.watchthemall.app;

import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Serves a provider's stream to a Chromecast on the local network.
 *
 * ## Why the phone has to be in the path at all
 *
 * The Cast sender API hands the receiver a URL and the receiver does the
 * fetching. Our providers will not serve that request: most are `header-gated`,
 * meaning the manifest and segments are returned only to a request carrying the
 * embed page's `Referer` and `Origin`, and there is no way to attach either to
 * what the Chromecast sends. Measured on 2026-09-13, VidZee answers 403 to a
 * bare request and 200 to the same request with its headers replayed.
 *
 * So this sits in between: the receiver fetches from the phone over the LAN,
 * and the phone fetches upstream with the headers `MediaCapture` recorded.
 *
 * ## Why there is no route that takes a URL
 *
 * The obvious design puts the upstream URL in a query parameter. That would
 * make the phone an **open relay for every device on the network** for as long
 * as a cast runs — anything could ask it to fetch anything, from the phone's
 * address and with the phone's headers.
 *
 * Instead the JavaScript side enumerates every URL up front (see
 * `buildCastBundle`) and registers them here against opaque ids. This server
 * can only ever fetch something already decided on, which is a property the
 * query-string design cannot be given afterwards. Unknown id, 404, no fetch.
 *
 * ## Why it binds a wildcard address when the desktop's server does not
 *
 * `localserver.ts` binds 127.0.0.1 precisely so nothing off the machine can
 * reach it. This one is useless under that rule: the whole point is that
 * another device fetches from it. The mitigations are the ones above — no URL
 * route, ids valid only for the session that registered them, and the server
 * stopped the moment casting stops.
 *
 * ## Scope
 *
 * Deliberately the smallest HTTP server that can do this job. One request per
 * connection (`Connection: close`), no keep-alive, no chunked encoding, no
 * compression. At one connection per six-second segment the cost is
 * irrelevant, and each of those features is a place to be subtly wrong.
 */
public final class CastProxyServer {

    private static final String TAG = "CastProxy";

    /** Long enough for a slow provider, short enough not to pile up threads. */
    private static final int UPSTREAM_TIMEOUT_MS = 20_000;

    private static final int BUFFER_BYTES = 64 * 1024;

    /**
     * Request headers that must never be replayed upstream.
     *
     * `Range` is the one that matters. It was captured from whatever byte the
     * browser happened to want, and replaying it on a manifest request returns a
     * slice of the playlist — a corrupt stream that looks like a parsing bug.
     * The receiver's own `Range` is forwarded instead, per request.
     */
    private static final String[] NOT_REPLAYED = {
        "range", "host", "connection", "content-length", "accept-encoding"
    };

    private ServerSocket socket;
    private ExecutorService workers;
    private volatile int port = -1;

    /** id -> rewritten playlist body, served from memory. */
    private final Map<String, String> playlists = new ConcurrentHashMap<>();

    /** id -> upstream URL. The only URLs this server will ever fetch. */
    private final Map<String, String> targets = new ConcurrentHashMap<>();

    /** Headers to replay upstream, already filtered. */
    private final Map<String, String> upstreamHeaders = new ConcurrentHashMap<>();

    /** Start listening, returning the bound port. Idempotent. */
    public synchronized int start() throws IOException {
        if (socket != null && !socket.isClosed()) return port;

        socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(0));
        port = socket.getLocalPort();

        // Bounded: a Chromecast opens a handful of connections at a time, and an
        // unbounded pool would turn a misbehaving receiver into an OOM.
        workers = Executors.newFixedThreadPool(8);

        Thread accept = new Thread(this::acceptLoop, "cast-proxy-accept");
        accept.setDaemon(true);
        accept.start();

        Log.i(TAG, "listening on " + port);
        return port;
    }

    public synchronized void stop() {
        playlists.clear();
        targets.clear();
        upstreamHeaders.clear();
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // Already closed, or never opened. Either way there is nothing to do.
        }
        socket = null;
        if (workers != null) workers.shutdownNow();
        workers = null;
        port = -1;
    }

    public boolean isRunning() {
        return socket != null && !socket.isClosed();
    }

    public int getPort() {
        return port;
    }

    /** Replace everything this server is willing to serve. */
    public void load(Map<String, String> newPlaylists, Map<String, String> newTargets, Map<String, String> headers) {
        playlists.clear();
        playlists.putAll(newPlaylists);
        targets.clear();
        targets.putAll(newTargets);

        upstreamHeaders.clear();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (!isNotReplayed(entry.getKey())) upstreamHeaders.put(entry.getKey(), entry.getValue());
        }
    }

    private static boolean isNotReplayed(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String blocked : NOT_REPLAYED) {
            if (blocked.equals(lower)) return true;
        }
        return false;
    }

    /**
     * The address a Chromecast can reach this phone at.
     *
     * Returns null when there is no non-loopback IPv4 address, which is the
     * honest answer when the phone is on mobile data: casting is impossible and
     * the caller must say so rather than hand out an address that will time out.
     */
    public static String lanAddress() {
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface network : interfaces) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address.isLoopbackAddress()) continue;
                    // IPv4 only: a Chromecast is reachable over v4 on every home
                    // network, and a link-local v6 address would need a scope id
                    // the receiver has no way to use.
                    if (address.getHostAddress() != null && address.getHostAddress().indexOf(':') < 0) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "no LAN address: " + error);
        }
        return null;
    }

    /* ── The server ─────────────────────────────────────────────────────── */

    private void acceptLoop() {
        while (socket != null && !socket.isClosed()) {
            try {
                Socket client = socket.accept();
                ExecutorService pool = workers;
                if (pool != null) pool.execute(() -> serve(client));
            } catch (IOException error) {
                // `stop()` closes the socket out from under accept(); that is the
                // normal way this loop ends, not a fault worth logging loudly.
                if (socket != null && !socket.isClosed()) Log.w(TAG, "accept failed: " + error);
                return;
            }
        }
    }

    private void serve(Socket client) {
        try (Socket open = client) {
            open.setSoTimeout(UPSTREAM_TIMEOUT_MS);
            PushbackInputStream in = new PushbackInputStream(open.getInputStream(), 1);
            OutputStream out = new BufferedOutputStream(open.getOutputStream(), BUFFER_BYTES);

            String requestLine = readLine(in);
            if (requestLine == null) return;

            Map<String, String> requestHeaders = new HashMap<>();
            String header;
            while ((header = readLine(in)) != null && !header.isEmpty()) {
                int colon = header.indexOf(':');
                if (colon > 0) {
                    requestHeaders.put(
                        header.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                        header.substring(colon + 1).trim()
                    );
                }
            }

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                writeStatus(out, 400, "bad request");
                return;
            }
            String method = parts[0];
            String id = idFromPath(parts[1]);

            String playlist = playlists.get(id);
            if (playlist != null) {
                byte[] body = playlist.getBytes(StandardCharsets.UTF_8);
                writeHead(out, 200, "OK", "application/vnd.apple.mpegurl", body.length, null);
                if (!"HEAD".equalsIgnoreCase(method)) out.write(body);
                out.flush();
                return;
            }

            String upstream = targets.get(id);
            if (upstream == null) {
                writeStatus(out, 404, "unknown id");
                return;
            }

            proxy(upstream, requestHeaders.get("range"), method, out);
        } catch (IOException error) {
            // A receiver that seeks or stops closes the connection mid-write.
            // That is routine, not a failure.
            Log.d(TAG, "client gone: " + error);
        }
    }

    /**
     * `/p3.m3u8` -> `p3`, `/s41` -> `s41`.
     *
     * The `.m3u8` suffix exists only so the receiver's own content sniffing sees
     * a playlist where it expects one; the id is what this server keys on.
     */
    private static String idFromPath(String rawPath) {
        String path = rawPath;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        if (path.startsWith("/")) path = path.substring(1);
        if (path.endsWith(".m3u8")) path = path.substring(0, path.length() - ".m3u8".length());
        return path;
    }

    private void proxy(String upstream, String range, String method, OutputStream out) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(upstream).openConnection();
            connection.setConnectTimeout(UPSTREAM_TIMEOUT_MS);
            connection.setReadTimeout(UPSTREAM_TIMEOUT_MS);
            connection.setRequestMethod("HEAD".equalsIgnoreCase(method) ? "HEAD" : "GET");
            connection.setInstanceFollowRedirects(true);

            for (Map.Entry<String, String> entry : upstreamHeaders.entrySet()) {
                connection.setRequestProperty(entry.getKey(), entry.getValue());
            }
            // The receiver's range, not the captured one — see NOT_REPLAYED.
            if (range != null) connection.setRequestProperty("Range", range);

            /*
             * Refuse compression, and mean it.
             *
             * Left alone, HttpURLConnection adds `Accept-Encoding: gzip` on its
             * own and transparently decompresses the body — while
             * getContentLengthLong() keeps reporting the *compressed* length.
             * The response would then advertise fewer bytes than it sends, and
             * the receiver would read a truncated segment: a stream that plays
             * for a few seconds and then stutters or stops, with nothing in any
             * log to say why.
             */
            connection.setRequestProperty("Accept-Encoding", "identity");

            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            long length = connection.getContentLengthLong();
            String contentRange = connection.getHeaderField("Content-Range");

            writeHead(
                out,
                status,
                status == 206 ? "Partial Content" : "OK",
                contentType != null ? contentType : "application/octet-stream",
                length,
                contentRange
            );

            if (!"HEAD".equalsIgnoreCase(method)) {
                InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (body != null) {
                    byte[] buffer = new byte[BUFFER_BYTES];
                    int read;
                    while ((read = body.read(buffer)) != -1) out.write(buffer, 0, read);
                }
            }
            out.flush();
        } catch (IOException error) {
            Log.w(TAG, "upstream failed: " + error);
            writeStatus(out, 502, "upstream failed");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /* ── Wire format ────────────────────────────────────────────────────── */

    private static void writeHead(
        OutputStream out,
        int status,
        String reason,
        String contentType,
        long length,
        String contentRange
    ) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        if (length >= 0) head.append("Content-Length: ").append(length).append("\r\n");
        if (contentRange != null) head.append("Content-Range: ").append(contentRange).append("\r\n");
        // The Cast receiver is a web app fetching cross-origin; without this its
        // own JavaScript cannot read the response and playback never starts.
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void writeStatus(OutputStream out, int status, String message) throws IOException {
        byte[] body = message.getBytes(StandardCharsets.UTF_8);
        writeHead(out, status, message, "text/plain; charset=utf-8", body.length, null);
        out.write(body);
        out.flush();
    }

    /** Read one CRLF-terminated line, tolerating a bare LF. */
    private static String readLine(PushbackInputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        int character;
        while ((character = in.read()) != -1) {
            if (character == '\r') {
                int next = in.read();
                if (next != '\n' && next != -1) in.unread(next);
                return line.toString();
            }
            if (character == '\n') return line.toString();
            line.append((char) character);
            // A request line this long is not a client we want to serve.
            if (line.length() > 8192) return line.toString();
        }
        return line.length() > 0 ? line.toString() : null;
    }
}
