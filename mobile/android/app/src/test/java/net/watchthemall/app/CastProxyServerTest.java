package net.watchthemall.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

/**
 * The cast proxy, run for real on the JVM: a fake provider on one loopback
 * port, the proxy on another, and the television's requests made by hand.
 *
 * The proxy is the one part of casting that has to be Java, so nothing in the
 * TypeScript suite reaches it. Each test here pins a defect it shipped with.
 */
public class CastProxyServerTest {

    private final CastProxyServer proxy = new CastProxyServer();
    private final AtomicReference<Throwable> uncaught = new AtomicReference<>();
    private Thread.UncaughtExceptionHandler previousHandler;
    private FakeUpstream upstream;

    @Before
    public void setUp() throws IOException {
        // On Android an exception that escapes a worker thread kills the app;
        // here it would only be printed, so it is caught and asserted on.
        previousHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> uncaught.set(error));
        upstream = new FakeUpstream();
    }

    @After
    public void tearDown() throws IOException {
        proxy.stop();
        upstream.close();
        Thread.setDefaultUncaughtExceptionHandler(previousHandler);
    }

    @Test
    public void aBodyWithNoLengthPastTheBufferCapArrivesWhole() throws Exception {
        int size = 30 * 1024 * 1024;
        int port = startServing(Collections.singletonMap("s0", upstream.chunked(size)));

        Reply reply = get(port, "/s0");

        assertEquals(200, reply.status);
        assertEquals(size, reply.body.length);
        for (int i = 0; i < size; i += 4099) assertEquals("byte " + i, FakeUpstream.at(i), reply.body[i]);
        assertNull(uncaught.get());
    }

    @Test
    public void aBodyWithNoLengthUnderTheCapIsGivenOne() throws Exception {
        int size = 1024 * 1024;
        int port = startServing(Collections.singletonMap("s0", upstream.chunked(size)));

        Reply reply = get(port, "/s0");

        assertEquals(String.valueOf(size), reply.headers.get("content-length"));
        assertEquals(size, reply.body.length);
    }

    @Test
    public void aTargetThatIsNotAWebAddressAnswers502AndTheProxyCarriesOn() throws Exception {
        Map<String, String> targets = new HashMap<>();
        targets.put("s0", "file:///etc/hostname");
        targets.put("s1", upstream.chunked(1000));
        int port = startServing(targets);

        Reply refused = get(port, "/s0");
        Reply served = get(port, "/s1");

        assertEquals(502, refused.status);
        assertEquals(200, served.status);
        assertEquals(1000, served.body.length);
        assertNull(uncaught.get());
    }

    @Test
    public void aHeadThatNeverEndsIsRefusedRatherThanKept() throws Exception {
        int port = startServing(Collections.singletonMap("s0", upstream.chunked(1000)));
        StringBuilder flood = new StringBuilder("GET /s0 HTTP/1.1\r\n");
        while (flood.length() < 20_000) flood.append("X-Padding: ").append(flood.length()).append("\r\n");

        // Never the blank line that ends a head: the old proxy kept every header.
        Reply refused = send(port, flood.toString());

        assertEquals(431, refused.status);
        assertEquals(200, get(port, "/s0").status);
        assertNull(uncaught.get());
    }

    @Test
    public void aClientTricklingItsHeadIsHungUpOnAtTheDeadline() throws Exception {
        CastProxyServer quick = new CastProxyServer(300);
        try {
            int port = quick.start(InetAddress.getLoopbackAddress());
            quick.load(new HashMap<>(), new HashMap<>(Collections.singletonMap("s0", upstream.chunked(1000))), new HashMap<>());
            try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
                socket.setSoTimeout(5_000);
                long started = System.currentTimeMillis();
                // A byte every 100 ms: no single read ever waits long enough to time out.
                Thread trickle = new Thread(() -> {
                    try {
                        OutputStream out = socket.getOutputStream();
                        for (byte b : "GET /s0 HTTP/1.1\r\nHost: receiver\r\n".getBytes(StandardCharsets.ISO_8859_1)) {
                            out.write(b);
                            out.flush();
                            Thread.sleep(100);
                        }
                    } catch (IOException | InterruptedException hungUp) {
                        // The proxy closed on us, which is what is being tested.
                    }
                });
                trickle.setDaemon(true);
                trickle.start();

                Reply reply = parse(readAll(socket.getInputStream()));

                assertEquals(408, reply.status);
                assertTrue(System.currentTimeMillis() - started < 3_000);
            }
        } finally {
            quick.stop();
        }
        assertNull(uncaught.get());
    }

    @Test
    public void theAddressOfferedIsTheOneThatRoutesToTheReceiver() throws Exception {
        InetAddress receiver = someNetworkAddress();
        Assume.assumeNotNull(receiver);

        // A receiver on this machine's own network address: the route to it
        // leaves from that address, whatever else is up.
        assertEquals(receiver, CastProxyServer.lanAddress(receiver));
    }

    @Test
    public void theProxyListensOnTheAddressItWasGivenOnly() throws Exception {
        InetAddress elsewhere = someNetworkAddress();
        Assume.assumeNotNull(elsewhere);
        int port = proxy.start(InetAddress.getLoopbackAddress());

        boolean reachedElsewhere;
        try (Socket socket = new Socket(elsewhere, port)) {
            reachedElsewhere = true;
        } catch (IOException refused) {
            reachedElsewhere = false;
        }

        assertEquals(false, reachedElsewhere);
    }

    /** One of this machine's non-loopback IPv4 addresses, or null with none. */
    private static InetAddress someNetworkAddress() throws IOException {
        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!network.isUp() || network.isLoopback()) continue;
            for (InetAddress address : Collections.list(network.getInetAddresses())) {
                if (address instanceof Inet4Address && !address.isLoopbackAddress()) return address;
            }
        }
        return null;
    }

    /* ── Helpers ─────────────────────────────────────────────────────────── */

    @Test
    public void aDownloadsFileIsServedWholeOrByRangeAndNothingElseIs() throws Exception {
        java.io.File file = java.io.File.createTempFile("s00000", ".ts");
        file.deleteOnExit();
        byte[] content = new byte[300_000];
        for (int i = 0; i < content.length; i++) content[i] = (byte) (i * 31);
        java.nio.file.Files.write(file.toPath(), content);
        int port = proxy.start(InetAddress.getLoopbackAddress());
        proxy.load(new HashMap<>(), new HashMap<>(), new HashMap<>());
        proxy.serveFiles(Collections.singletonMap("f1", file));

        Reply whole = get(port, "/f1");
        assertEquals(200, whole.status);
        assertEquals("video/mp2t", whole.headers.get("content-type"));
        assertEquals(content.length, whole.body.length);
        assertEquals(content[123_456], whole.body[123_456]);

        Reply part = send(port, "GET /f1 HTTP/1.1\r\nHost: receiver\r\nRange: bytes=1000-1999\r\n\r\n");
        assertEquals(206, part.status);
        assertEquals("bytes 1000-1999/" + content.length, part.headers.get("content-range"));
        assertEquals(1000, part.body.length);
        assertEquals(content[1500], part.body[500]);

        assertEquals(404, get(port, "/f2").status);
        assertNull(uncaught.get());
    }

    /**
     * The two counts a cast's answer is filed by (`castOutcomeOf`): what the
     * receiver asked for, and what the source refused. A refused segment is
     * the source blocking the cast; without the count it was filed as the
     * television refusing the format.
     */
    @Test
    public void whatTheSourceRefusesIsCountedApartFromWhatWasServed() throws Exception {
        Map<String, String> targets = new HashMap<>();
        targets.put("s0", upstream.chunked(1000));
        targets.put("s1", upstream.refusing(403));
        // Nothing listens on port 1: the source never answers at all.
        targets.put("s2", "http://127.0.0.1:1/segment.ts");
        int port = startServing(targets);

        assertEquals(200, get(port, "/s0").status);
        assertEquals(403, get(port, "/s1").status);
        assertEquals(502, get(port, "/s2").status);
        // Not registered: not something the receiver was given, so not counted.
        assertEquals(404, get(port, "/s9").status);

        assertEquals(3, proxy.servedCount());
        assertEquals(2, proxy.upstreamFailureCount());

        // The next stream starts counting from nothing.
        proxy.load(new HashMap<>(), new HashMap<>(targets), new HashMap<>());
        assertEquals(0, proxy.servedCount());
        assertEquals(0, proxy.upstreamFailureCount());
        assertNull(uncaught.get());
    }

    private int startServing(Map<String, String> targets) throws IOException {
        int port = proxy.start(InetAddress.getLoopbackAddress());
        proxy.load(new HashMap<>(), new HashMap<>(targets), new HashMap<>());
        return port;
    }

    /** One response from the proxy: status, headers (lower-cased names) and body. */
    static final class Reply {
        final int status;
        final Map<String, String> headers;
        final byte[] body;

        Reply(int status, Map<String, String> headers, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }
    }

    /** A GET as a receiver sends it, read to the end: the proxy closes every connection. */
    static Reply get(int port, String path) throws IOException {
        return send(port, "GET " + path + " HTTP/1.1\r\nHost: receiver\r\n\r\n");
    }

    static Reply send(int port, String request) throws IOException {
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
            socket.setSoTimeout(20_000);
            socket.getOutputStream().write(request.getBytes(StandardCharsets.ISO_8859_1));
            return parse(readAll(socket.getInputStream()));
        }
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        for (int read; (read = in.read(buffer)) != -1; ) all.write(buffer, 0, read);
        return all.toByteArray();
    }

    static Reply parse(byte[] raw) {
        String text = new String(raw, 0, Math.min(raw.length, 8192), StandardCharsets.ISO_8859_1);
        int end = text.indexOf("\r\n\r\n");
        if (end < 0) return new Reply(0, Collections.emptyMap(), new byte[0]);
        String[] lines = text.substring(0, end).split("\r\n");
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) headers.put(lines[i].substring(0, colon).trim().toLowerCase(), lines[i].substring(colon + 1).trim());
        }
        byte[] body = new byte[raw.length - end - 4];
        System.arraycopy(raw, end + 4, body, 0, body.length);
        return new Reply(Integer.parseInt(lines[0].split(" ")[1]), headers, body);
    }

    /**
     * A provider's server: answers `/bytes/N` with N bytes of a known pattern,
     * chunked, so the response carries no length, as some providers' do; and
     * `/status/N` with that error status.
     */
    static final class FakeUpstream implements AutoCloseable {
        private final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());

        FakeUpstream() throws IOException {
            Thread accept = new Thread(this::acceptLoop, "fake-upstream");
            accept.setDaemon(true);
            accept.start();
        }

        /** Byte `i` of every body served. Not periodic over any short span, so an offset shows. */
        static byte at(long i) {
            return (byte) ((i * 2654435761L) >>> 13);
        }

        String chunked(int size) {
            return "http://127.0.0.1:" + server.getLocalPort() + "/bytes/" + size;
        }

        /** A URL this server refuses with `status`, as a source refuses a request without its headers. */
        String refusing(int status) {
            return "http://127.0.0.1:" + server.getLocalPort() + "/status/" + status;
        }

        private void acceptLoop() {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    Thread serve = new Thread(() -> serve(client), "fake-upstream-serve");
                    serve.setDaemon(true);
                    serve.start();
                } catch (IOException closed) {
                    return;
                }
            }
        }

        private void serve(Socket client) {
            try (Socket open = client) {
                InputStream in = open.getInputStream();
                StringBuilder head = new StringBuilder();
                while (!head.toString().endsWith("\r\n\r\n")) {
                    int c = in.read();
                    if (c == -1) return;
                    head.append((char) c);
                }
                String path = head.toString().split(" ")[1];
                int size = Integer.parseInt(path.substring(path.lastIndexOf('/') + 1));
                OutputStream out = open.getOutputStream();
                if (path.startsWith("/status/")) {
                    out.write(("HTTP/1.1 " + size + " Refused\r\nContent-Length: 7\r\nConnection: close\r\n\r\nrefused")
                        .getBytes(StandardCharsets.ISO_8859_1));
                    out.flush();
                    return;
                }
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nTransfer-Encoding: chunked\r\n"
                    + "Connection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                byte[] chunk = new byte[64 * 1024];
                for (int sent = 0; sent < size; ) {
                    int length = Math.min(chunk.length, size - sent);
                    for (int i = 0; i < length; i++) chunk[i] = at(sent + i);
                    out.write((Integer.toHexString(length) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
                    out.write(chunk, 0, length);
                    out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    sent += length;
                }
                out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            } catch (IOException ignored) {
                // The proxy hung up; nothing to assert from this side.
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
