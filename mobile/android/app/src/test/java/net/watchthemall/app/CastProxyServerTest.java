package net.watchthemall.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.After;
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

    /* ── Helpers ─────────────────────────────────────────────────────────── */

    private int startServing(Map<String, String> targets) throws IOException {
        int port = proxy.start();
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
     * chunked, so the response carries no length, as some providers' do.
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
