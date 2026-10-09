package net.watchthemall.app;

import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;

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
 * ## Why it binds a network address when the desktop's server does not
 *
 * `localserver.ts` binds 127.0.0.1 precisely so nothing off the machine can
 * reach it. This one is useless under that rule: the whole point is that
 * another device fetches from it. It binds the one address the receiver
 * reaches it at (`lanAddress`), not every interface, so a VPN or mobile data
 * is never offered it. The mitigations are the ones above — no URL route,
 * unguessable ids valid only for the session that registered them, and the
 * server stopped the moment casting stops.
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
     * Largest response held in memory to measure it. See `proxy`.
     *
     * Sized for a segment, which is what this ever applies to: a six-second
     * chunk of 1080p is single-digit megabytes. Anything past this is streamed
     * instead, because a progressive MP4 of a whole film would arrive here as
     * one response and must never be buffered.
     */
    private static final int BUFFERABLE_BYTES = 24 * 1024 * 1024;

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

    /** Longest request head served. A receiver's is a few hundred bytes. */
    private static final int MAX_HEAD_BYTES = 16 * 1024;

    /** Most headers kept from one request. A receiver sends under a dozen. */
    private static final int MAX_HEADERS = 64;

    /** How long a client has to send its whole request head, however it paces it. */
    private static final int HEAD_DEADLINE_MS = 10_000;

    private final int headDeadlineMs;

    private volatile ServerSocket socket;
    private ExecutorService workers;
    private volatile int port = -1;

    public CastProxyServer() {
        this(HEAD_DEADLINE_MS);
    }

    /** With a shorter head deadline, for the tests. */
    CastProxyServer(int headDeadlineMs) {
        this.headDeadlineMs = headDeadlineMs;
    }

    /** id -> rewritten playlist body, served from memory. */
    private final Map<String, String> playlists = new ConcurrentHashMap<>();

    /** id -> upstream URL. The only URLs this server will ever fetch. */
    private final Map<String, String> targets = new ConcurrentHashMap<>();

    /** Headers to replay upstream, already filtered. */
    private final Map<String, String> upstreamHeaders = new ConcurrentHashMap<>();

    /**
     * id -> a download's file on this phone (`shared/downloads/castbundle.ts`).
     * The only files this server will read; set by `serveFiles` after `load`.
     */
    private final Map<String, java.io.File> files = new ConcurrentHashMap<>();

    /**
     * What the receiver asked for since `load`, and how much of it the
     * source's servers refused or never answered. The same two counts as the
     * desktop's `castproxy.ts`, for the same rule (`castOutcomeOf` in
     * `shared/castanswer.ts`): a refusal counts against a source only if the
     * receiver reached this phone, and is the source's block, not the
     * television's, when the source refused the proxy.
     */
    private final AtomicInteger served = new AtomicInteger();
    private final AtomicInteger upstreamFailures = new AtomicInteger();
    /**
     * Which `load` the counts belong to: a fetch for the previous stream can
     * still be in flight when the next one is loaded, and its failure must
     * not make the new stream look blocked.
     */
    private final AtomicInteger generation = new AtomicInteger();

    /**
     * Start listening on `address`, returning the bound port. Idempotent for
     * the same address; a new one means the phone changed networks, where the
     * old address reaches nobody, so the server moves to it.
     */
    public synchronized int start(InetAddress address) throws IOException {
        if (socket != null && !socket.isClosed()) {
            if (address.equals(socket.getInetAddress())) return port;
            stop();
        }

        ServerSocket listening = new ServerSocket();
        listening.setReuseAddress(true);
        listening.bind(new InetSocketAddress(address, 0));

        // Bounded: a Chromecast opens a handful of connections at a time, and an
        // unbounded pool would turn a misbehaving receiver into an OOM.
        ExecutorService pool = Executors.newFixedThreadPool(8);

        socket = listening;
        workers = pool;
        port = listening.getLocalPort();

        Thread accept = new Thread(() -> acceptLoop(listening, pool), "cast-proxy-accept");
        accept.setDaemon(true);
        accept.start();

        Log.i(TAG, "listening on " + port);
        return port;
    }

    public synchronized void stop() {
        playlists.clear();
        targets.clear();
        files.clear();
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

    /** The files a download's cast reads, replacing any earlier; call after `load`. */
    public void serveFiles(Map<String, java.io.File> newFiles) {
        files.clear();
        files.putAll(newFiles);
    }

    /** Requests the receiver made for anything registered, since `load`. */
    public int servedCount() {
        return served.get();
    }

    /** Of those, the ones the source answered with an error status, or not at all. */
    public int upstreamFailureCount() {
        return upstreamFailures.get();
    }

    /** Replace everything this server is willing to serve. */
    public void load(Map<String, String> newPlaylists, Map<String, String> newTargets, Map<String, String> headers) {
        generation.incrementAndGet();
        served.set(0);
        upstreamFailures.set(0);
        files.clear();
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

    /** The port a Cast receiver listens on; only ever used to find a route, nothing is sent. */
    private static final int CAST_PORT = 8009;

    /**
     * The address the receiver can reach this phone at.
     *
     * With the receiver's own address known, the local end of the route to it:
     * that is the interface its requests will arrive on. This used to take the
     * first IPv4 address of any interface, and a VPN's, or mobile data's when
     * Android keeps it up beside Wi-Fi, could come first; the receiver was
     * then handed an address it cannot reach and the cast timed out with
     * nothing to say why. Without the receiver's address, a Wi-Fi interface's,
     * then any.
     *
     * IPv4 only: a Chromecast is reachable over v4 on every home network, and a
     * link-local v6 address would need a scope id the receiver has no way to
     * use. Null when there is none, which is the honest answer on mobile data:
     * the caller says so rather than hand out an address that will time out.
     */
    public static InetAddress lanAddress(InetAddress receiver) {
        InetAddress routed = routeTo(receiver);
        if (routed != null) return routed;
        InetAddress any = null;
        try {
            List<NetworkInterface> interfaces = Collections.list(NetworkInterface.getNetworkInterfaces());
            for (NetworkInterface network : interfaces) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                    if (network.getName().startsWith("wlan")) return address;
                    if (any == null) any = address;
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "no LAN address: " + error);
        }
        return any;
    }

    /**
     * The local address a packet to `receiver` would leave from, or null.
     * Connecting a datagram socket only asks the routing table; nothing is sent.
     */
    static InetAddress routeTo(InetAddress receiver) {
        if (receiver == null) return null;
        try (DatagramSocket probe = new DatagramSocket()) {
            probe.connect(receiver, CAST_PORT);
            InetAddress local = probe.getLocalAddress();
            if (local instanceof Inet4Address && !local.isAnyLocalAddress() && !local.isLoopbackAddress()) return local;
        } catch (Exception error) {
            Log.w(TAG, "no route to the receiver: " + error);
        }
        return null;
    }

    /* ── The server ─────────────────────────────────────────────────────── */

    /**
     * Hand each connection to a worker until `stop` closes the socket.
     *
     * Handed the socket and the pool rather than reading the fields, which
     * `stop` clears from another thread. Read in between, they could be null,
     * or the pool already shut down; either exception is not an IOException,
     * and one escaping this thread kills the app.
     */
    private void acceptLoop(ServerSocket listening, ExecutorService pool) {
        while (!listening.isClosed()) {
            Socket client;
            try {
                client = listening.accept();
            } catch (IOException error) {
                // `stop()` closes the socket out from under accept(); that is the
                // normal way this loop ends, not a fault worth logging loudly.
                if (!listening.isClosed()) Log.w(TAG, "accept failed: " + error);
                return;
            }
            try {
                pool.execute(() -> serve(client));
            } catch (RejectedExecutionException stopped) {
                closeQuietly(client);
                return;
            }
        }
    }

    private static void closeQuietly(Socket client) {
        try {
            client.close();
        } catch (IOException ignored) {
            // Closing is all that was wanted.
        }
    }

    private void serve(Socket client) {
        try (Socket open = client) {
            OutputStream out = new BufferedOutputStream(open.getOutputStream(), BUFFER_BYTES);

            RequestHead request;
            try {
                request = readHead(open);
            } catch (RefusedRequest refused) {
                writeStatus(out, refused.status, refused.getMessage());
                drainBriefly(open);
                return;
            }
            if (request == null) return;
            open.setSoTimeout(UPSTREAM_TIMEOUT_MS);

            Map<String, String> requestHeaders = request.headers;
            String method = request.method;
            String id = idFromPath(request.path);
            if (playlists.containsKey(id) || targets.containsKey(id) || files.containsKey(id)) served.incrementAndGet();

            String playlist = playlists.get(id);
            if (playlist != null) {
                byte[] body = playlist.getBytes(StandardCharsets.UTF_8);
                writeHead(out, 200, "OK", "application/vnd.apple.mpegurl", body.length, null);
                if (!"HEAD".equalsIgnoreCase(method)) out.write(body);
                out.flush();
                return;
            }

            java.io.File file = files.get(id);
            if (file != null) {
                serveFile(file, requestHeaders.get("range"), method, out);
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
        } catch (RuntimeException error) {
            // Never past here: on Android an exception that escapes a worker
            // thread kills the app, and with it the film on the television.
            Log.w(TAG, "request failed: " + error);
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
        int askedFor = generation.get();
        // Once the receiver is being answered, a failure may be its own: it
        // closes connections when it seeks or stops. Only one before that is
        // the source's for certain.
        boolean answering = false;
        HttpURLConnection connection = null;
        try {
            URLConnection opened = new URL(upstream).openConnection();
            // Only web addresses are registered (`buildCastBundle`). This is the
            // backstop: anything else opens as a different kind of connection,
            // and the cast below would throw.
            if (!(opened instanceof HttpURLConnection)) {
                writeStatus(out, 502, "not a web address");
                return;
            }
            connection = (HttpURLConnection) opened;
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
            if ((status < 200 || status >= 300) && askedFor == generation.get()) upstreamFailures.incrementAndGet();
            long length = connection.getContentLengthLong();
            String contentRange = connection.getHeaderField("Content-Range");
            String contentType = mediaContentType(connection.getContentType(), upstream);

            InputStream body = null;
            if (!"HEAD".equalsIgnoreCase(method)) {
                body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            }

            /*
             * Give the receiver a length even when the provider does not.
             *
             * A chunked upstream leaves getContentLengthLong() at -1, and the
             * response then has to be terminated by closing the socket. mpv
             * tolerates that and says so loudly ("Stream ends prematurely");
             * whether a given Cast receiver tolerates it is not knowable from
             * here, and a receiver that does not would stall on every segment.
             *
             * Buffering one segment to measure it is cheap — they run a few
             * megabytes — so below the cap this trades a little memory for a
             * well-formed response. Above it, streaming is still the only
             * option and the old behaviour stands.
             */
            Buffered buffered = null;
            if (body != null && length < 0) {
                buffered = readAtMost(body, BUFFERABLE_BYTES);
                if (buffered.complete) length = buffered.bytes.size();
            }

            answering = true;
            writeHead(out, status, status == 206 ? "Partial Content" : "OK", contentType, length, contentRange);

            if (buffered != null) buffered.bytes.writeTo(out);
            if (body != null && (buffered == null || !buffered.complete)) {
                byte[] buffer = new byte[BUFFER_BYTES];
                int read;
                while ((read = body.read(buffer)) != -1) out.write(buffer, 0, read);
            }
            out.flush();
        } catch (IOException | RuntimeException error) {
            Log.w(TAG, "upstream failed: " + error);
            if (!answering && askedFor == generation.get()) upstreamFailures.incrementAndGet();
            writeStatus(out, 502, "upstream failed");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** What `readAtMost` read, and whether that was the whole body. */
    private static final class Buffered {
        final java.io.ByteArrayOutputStream bytes;
        final boolean complete;

        Buffered(java.io.ByteArrayOutputStream bytes, boolean complete) {
            this.bytes = bytes;
            this.complete = complete;
        }
    }

    /**
     * Read a whole response, or as much of it as the cap allows.
     *
     * Past the cap the body is still arriving, and what was read is its start:
     * the caller sends that first and streams the rest after it. In practice
     * the cap is only reached by a progressive file. Until this kept the
     * prefix, a whole film served without a length reached the receiver as a
     * 200 with its first 24 MB missing.
     */
    private static Buffered readAtMost(InputStream body, int cap) throws IOException {
        java.io.ByteArrayOutputStream collected = new java.io.ByteArrayOutputStream(BUFFER_BYTES);
        byte[] buffer = new byte[BUFFER_BYTES];
        int read;
        while ((read = body.read(buffer)) != -1) {
            collected.write(buffer, 0, read);
            if (collected.size() > cap) return new Buffered(collected, false);
        }
        return new Buffered(collected, true);
    }

    /**
     * What to tell the receiver this is.
     *
     * Providers are careless here: VidSrc serves its transport-stream segments
     * as `text/html`, measured on 2026-09-13. mpv ignores the header and plays
     * them; a Cast receiver that sniffs it could decide the segment is a web
     * page and refuse the stream. So a text/* answer on binary media is
     * replaced — by the type the URL implies where it implies one, and
     * otherwise by `application/octet-stream`, which claims nothing.
     *
     * Anything that is not text/* is passed through untouched: a provider that
     * bothered to be accurate should be believed.
     */
    private static String mediaContentType(String upstreamType, String url) {
        if (upstreamType == null || upstreamType.isEmpty()) return "application/octet-stream";
        if (!upstreamType.toLowerCase(Locale.ROOT).startsWith("text/")) return upstreamType;

        String path = url.toLowerCase(Locale.ROOT);
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);

        if (path.endsWith(".ts")) return "video/mp2t";
        if (path.endsWith(".m4s") || path.endsWith(".mp4")) return "video/mp4";
        if (path.endsWith(".aac")) return "audio/aac";
        if (path.endsWith(".webm")) return "video/webm";
        return "application/octet-stream";
    }

    /**
     * One of a download's files, honouring a `bytes=a-b` range: a receiver may
     * ask for part of a segment. A range it cannot serve gets the whole file.
     */
    private static void serveFile(java.io.File file, String range, String method, OutputStream out) throws IOException {
        if (!file.isFile()) {
            writeStatus(out, 404, "gone");
            return;
        }
        long size = file.length();
        long start = 0;
        long end = size - 1;
        boolean partial = false;
        if (range != null) {
            java.util.regex.Matcher match = java.util.regex.Pattern.compile("^bytes=(\\d*)-(\\d*)$").matcher(range.trim());
            if (match.matches() && !(match.group(1).isEmpty() && match.group(2).isEmpty())) {
                long a;
                long b;
                if (match.group(1).isEmpty()) {
                    a = Math.max(0, size - Long.parseLong(match.group(2)));
                    b = size - 1;
                } else {
                    a = Long.parseLong(match.group(1));
                    b = match.group(2).isEmpty() ? size - 1 : Math.min(Long.parseLong(match.group(2)), size - 1);
                }
                if (a <= b && a < size) {
                    start = a;
                    end = b;
                    partial = true;
                }
            }
        }
        String name = file.getName();
        String type = name.endsWith(".ts") ? "video/mp2t" : (name.endsWith(".m4s") || name.endsWith(".mp4")) ? "video/mp4" : "application/octet-stream";
        writeHead(out, partial ? 206 : 200, partial ? "Partial Content" : "OK", type, end - start + 1,
            partial ? "bytes " + start + "-" + end + "/" + size : null);
        if (!"HEAD".equalsIgnoreCase(method) && size > 0) {
            try (java.io.RandomAccessFile in = new java.io.RandomAccessFile(file, "r")) {
                in.seek(start);
                byte[] buffer = new byte[BUFFER_BYTES];
                long left = end - start + 1;
                while (left > 0) {
                    int read = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                    if (read < 0) break;
                    out.write(buffer, 0, read);
                    left -= read;
                }
            }
        }
        out.flush();
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

    /** A request's line and headers, header names lower-cased. */
    private static final class RequestHead {
        final String method;
        final String path;
        final Map<String, String> headers;

        RequestHead(String method, String path, Map<String, String> headers) {
            this.method = method;
            this.path = path;
            this.headers = headers;
        }
    }

    /** A request answered with an error status before anything is fetched. */
    private static final class RefusedRequest extends IOException {
        final int status;

        RefusedRequest(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    /**
     * The request line and headers, against one deadline for the lot.
     *
     * The proxy listens on the whole local network, and it used to read
     * headers a byte at a time with a fresh timeout per read and no limit. A
     * client sending one byte every nineteen seconds held a worker for ever, and
     * eight of them, one per worker, stalled the television's next segment. A
     * head that never ended grew the header map until memory ran out, which on
     * Android takes the app down. Null when the client hung up first.
     */
    private RequestHead readHead(Socket socket) throws IOException {
        InputStream in = socket.getInputStream();
        java.io.ByteArrayOutputStream raw = new java.io.ByteArrayOutputStream(1024);
        byte[] buffer = new byte[1024];
        long deadline = System.currentTimeMillis() + headDeadlineMs;
        int end;
        while ((end = endOfHead(raw)) < 0) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) throw new RefusedRequest(408, "request timeout");
            socket.setSoTimeout((int) left);
            int read;
            try {
                read = in.read(buffer);
            } catch (SocketTimeoutException slow) {
                throw new RefusedRequest(408, "request timeout");
            }
            if (read == -1) return null;
            raw.write(buffer, 0, read);
            if (raw.size() > MAX_HEAD_BYTES) throw new RefusedRequest(431, "request header fields too large");
        }

        String[] lines = raw.toString("ISO-8859-1").substring(0, end).split("\r?\n");
        String[] parts = lines[0].split(" ");
        if (parts.length < 2) throw new RefusedRequest(400, "bad request");
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length && headers.size() < MAX_HEADERS; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) {
                headers.put(
                    lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT),
                    lines[i].substring(colon + 1).trim()
                );
            }
        }
        return new RequestHead(parts[0], parts[1], headers);
    }

    /** Where the blank line that ends a request head starts, or -1 before it has arrived. */
    private static int endOfHead(java.io.ByteArrayOutputStream raw) throws IOException {
        String text = raw.toString("ISO-8859-1");
        int crlf = text.indexOf("\r\n\r\n");
        int lf = text.indexOf("\n\n");
        if (crlf < 0) return lf;
        return lf < 0 ? crlf : Math.min(crlf, lf);
    }

    /**
     * Let a refused client read its answer before the connection goes.
     *
     * Closed with the client's bytes still unread, the socket resets, and the
     * reset can overtake the status line. Bounded in time and bytes, because
     * the client being refused is the one not to wait on.
     */
    private static void drainBriefly(Socket socket) {
        try {
            socket.shutdownOutput();
            socket.setSoTimeout(500);
            InputStream in = socket.getInputStream();
            byte[] discard = new byte[4096];
            for (int total = 0; total < 64 * 1024; ) {
                int read = in.read(discard);
                if (read == -1) break;
                total += read;
            }
        } catch (IOException ignored) {
            // Timed out or reset: the answer has gone, which is all this was for.
        }
    }
}
