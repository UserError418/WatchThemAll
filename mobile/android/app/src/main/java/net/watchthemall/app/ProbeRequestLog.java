package net.watchthemall.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Every request one probe session's page made, in order, readable by cursor.
 *
 * ## Why this is not `MediaCapture`
 *
 * `MediaCapture` is one buffer for the whole app, fed by the app's own
 * WebView, and it cannot say which frame asked for what. That is why today's
 * scan runs providers one at a time and waits six seconds between them. A
 * probe session owns its WebView outright, so everything this log holds was
 * asked for by exactly one provider. Attribution comes from the ownership,
 * not from any cleverness here.
 *
 * It also keeps what `MediaCapture` deliberately drops. Casting wants the
 * manifest and throws segments away so a flood cannot evict it; a scan wants
 * the segments, because a playlist that was fetched and never followed by a
 * segment is a player that resolved a stream and then failed to play it.
 *
 * ## Why a cursor rather than "everything since the last clear"
 *
 * The reader polls. With a sequence number on every entry it can ask for
 * "everything after 57" and get each request exactly once, without the log
 * having to know who is reading or when it last did. When the log has
 * overflowed past the reader's cursor, `since` says how many were lost, so a
 * missed request is a counted fact rather than a silent gap.
 *
 * ## Threading
 *
 * `add` is called from `shouldInterceptRequest`, on the WebView's network
 * threads, several at once; `since` from a Capacitor worker. Both are
 * synchronised and do no I/O, so neither can stall a page load.
 */
final class ProbeRequestLog {

    /** One request, as the page made it. */
    static final class Entry {
        final long seq;
        final String url;
        final String method;
        final Map<String, String> headers;
        final boolean mainFrame;
        final long atMs;

        Entry(long seq, String url, String method, Map<String, String> headers, boolean mainFrame, long atMs) {
            this.seq = seq;
            this.url = url;
            this.method = method;
            this.headers = headers;
            this.mainFrame = mainFrame;
            this.atMs = atMs;
        }
    }

    /** What a reader gets back: the new entries, the cursor to pass next time, and what it missed. */
    static final class Slice {
        final List<Entry> entries;
        final long cursor;
        final long missed;

        Slice(List<Entry> entries, long cursor, long missed) {
            this.entries = entries;
            this.cursor = cursor;
            this.missed = missed;
        }
    }

    private final int capacity;
    private final ArrayDeque<Entry> entries = new ArrayDeque<>();
    /** The sequence number the next entry gets. Starts at 1 so a fresh reader's cursor of 0 means "from the start". */
    private long nextSeq = 1;

    ProbeRequestLog(int capacity) {
        this.capacity = capacity;
    }

    synchronized void add(String url, String method, Map<String, String> headers, boolean mainFrame, long atMs) {
        entries.addLast(new Entry(nextSeq++, url, method, headers, mainFrame, atMs));
        while (entries.size() > capacity) entries.removeFirst();
    }

    /** Everything recorded after `cursor`, oldest first. */
    synchronized Slice since(long cursor) {
        List<Entry> out = new ArrayList<>();
        long oldest = entries.isEmpty() ? nextSeq : entries.peekFirst().seq;
        // Entries between the reader's cursor and the oldest one still held
        // were evicted before the reader got to them.
        long missed = Math.max(0, oldest - cursor - 1);
        for (Entry entry : entries) {
            if (entry.seq > cursor) out.add(entry);
        }
        return new Slice(out, nextSeq - 1, missed);
    }
}
