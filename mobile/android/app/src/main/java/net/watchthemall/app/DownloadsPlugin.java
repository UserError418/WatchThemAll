package net.watchthemall.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The phone's hands for downloads (`mobile/src/bridge/downloads.ts`, on the
 * shared core in `src/shared/downloads/`).
 *
 * The queue, the plan, the retries and every judgement about a segment run in
 * TypeScript, the same code the desktop runs. This class only moves bytes:
 * it fetches a segment with the source's headers, decrypts it when the
 * stream is AES-128, and stages it in the download's folder as `<name>.part`.
 * Only the first 8 KB in the clear go back to the WebView, which is all the
 * core looks at; a film's gigabytes never cross the bridge.
 *
 * Everything lives under the app's files directory, `downloads/`: not the
 * cache, which Android empties when storage runs low (a download is meant to
 * still be there on a plane), and left out of backup (data_extraction_rules).
 */
@CapacitorPlugin(name = "Downloads")
public class DownloadsPlugin extends Plugin {

    /** Matches `HEAD_BYTES` in `src/shared/downloads/staging.ts`. */
    private static final int HEAD_BYTES = 8192;
    private static final String PART = ".part";

    /**
     * Three, for the core's three lanes (`LANES` in `transfer.ts`). Its own
     * pool rather than Capacitor's one plugin thread, which the library's
     * writes and every other plugin call share.
     */
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    private File root() {
        return new File(getContext().getFilesDir(), "downloads");
    }

    /** `path` under `downloads/`, or null when it would leave it. */
    private File resolve(String path) {
        if (path == null) return null;
        try {
            File file = new File(root(), path);
            return file.getCanonicalPath().startsWith(root().getCanonicalPath() + File.separator) ? file : null;
        } catch (IOException error) {
            return null;
        }
    }

    private void offThread(PluginCall call, Runnable work) {
        try {
            pool.execute(work);
        } catch (RejectedExecutionException closed) {
            call.reject("the app was closed");
        }
    }

    /**
     * Fetch a segment into `<path>.part`, decrypted when `key` and `iv`
     * (base64, 16 bytes each) are given. Resolves with the status, the size in
     * the clear (0 when the status was not a success or it did not decrypt)
     * and the head, base64.
     */
    @PluginMethod
    public void stageSegment(PluginCall call) {
        String url = call.getString("url");
        File target = resolve(call.getString("path"));
        if (url == null || target == null) {
            call.reject("url and a path under downloads/ are required");
            return;
        }
        JSObject headers = call.getObject("headers", new JSObject());
        String key = call.getString("key");
        String iv = call.getString("iv");
        offThread(call, () -> stageNow(call, url, headers, key, iv, target));
    }

    private static void stageNow(PluginCall call, String url, JSObject headers, String key, String iv, File target) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(true);
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                connection.setRequestProperty(name, headers.getString(name));
            }
            int status = connection.getResponseCode();
            byte[] clear = new byte[0];
            if (status == 200 || status == 206) {
                // Whole in memory: a segment is a few megabytes, and decrypting
                // needs the end (the padding) before any of it is trustworthy.
                byte[] body = readAll(connection.getInputStream());
                clear = key == null ? body : decrypt(body, key, iv);
            }
            File part = new File(target.getPath() + PART);
            File parent = part.getParentFile();
            if (parent != null) parent.mkdirs();
            try (OutputStream out = new FileOutputStream(part)) {
                out.write(clear);
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("bytes", clear.length);
            result.put("head", Base64.encodeToString(clear, 0, Math.min(clear.length, HEAD_BYTES), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("stage failed: " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** HLS AES-128: CBC with PKCS#7 padding (Java calls it PKCS5). Empty when it does not decrypt. */
    private static byte[] decrypt(byte[] body, String key, String iv) {
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(Base64.decode(key, Base64.NO_WRAP), "AES"),
                new IvParameterSpec(Base64.decode(iv, Base64.NO_WRAP))
            );
            return cipher.doFinal(body);
        } catch (Exception wrongKeyOrNotEncrypted) {
            return new byte[0];
        }
    }

    private static byte[] readAll(InputStream stream) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(2 * 1024 * 1024);
        try (InputStream in = stream) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) bytes.write(buffer, 0, read);
        }
        return bytes.toByteArray();
    }

    /**
     * Put `<path>.part` under `path`, without its first `skip` bytes (a
     * disguise in front of the stream). A rename when there is nothing to
     * skip, so the name only ever holds a whole segment. Resolves with its size.
     */
    @PluginMethod
    public void commitSegment(PluginCall call) {
        File target = resolve(call.getString("path"));
        int skip = call.getInt("skip", 0);
        if (target == null) {
            call.reject("a path under downloads/ is required");
            return;
        }
        offThread(call, () -> {
            File part = new File(target.getPath() + PART);
            try {
                if (skip > 0) {
                    File trimmed = new File(target.getPath() + ".trim" + PART);
                    try (InputStream in = new FileInputStream(part); OutputStream out = new FileOutputStream(trimmed)) {
                        long skipped = 0;
                        while (skipped < skip) {
                            long step = in.skip(skip - skipped);
                            if (step <= 0) break;
                            skipped += step;
                        }
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                    }
                    part.delete();
                    part = trimmed;
                }
                if (!part.renameTo(target)) throw new IOException("rename failed");
                JSObject result = new JSObject();
                result.put("bytes", target.length());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("commit failed: " + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void discardSegment(PluginCall call) {
        File target = resolve(call.getString("path"));
        if (target != null) new File(target.getPath() + PART).delete();
        call.resolve();
    }

    /** Bytes free where downloads are kept. */
    @PluginMethod
    public void freeBytes(PluginCall call) {
        JSObject result = new JSObject();
        result.put("bytes", getContext().getFilesDir().getUsableSpace());
        call.resolve(result);
    }

    /**
     * The notification that keeps the app alive while downloads are under
     * way (`DownloadKeepAliveService`): shown or updated with `title` and
     * `text` while `active`, gone otherwise.
     */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        try {
            if (active) {
                DownloadKeepAliveService.show(getContext(), call.getString("title", "Downloading"), call.getString("text", ""), call.getInt("percent", -1));
            } else {
                DownloadKeepAliveService.stop(getContext());
            }
            call.resolve();
        } catch (Exception refused) {
            // Android refuses a foreground service started from the background;
            // the download carries on for as long as the app is left alive.
            call.reject("keep-alive refused: " + refused.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
    }
}
