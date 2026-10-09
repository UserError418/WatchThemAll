package net.watchthemall.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.Collections;
import org.junit.After;
import org.junit.Test;

/** The phone's cast capture keeps a load's manifest through a flood of segments, as the desktop's does. */
public class MediaCaptureTest {
    private static MediaCapture.Candidate request(int n, String path) {
        return new MediaCapture.Candidate("https://cdn.test/" + path, Collections.emptyMap(), n);
    }

    @After
    public void forget() {
        MediaCapture.clear();
    }

    @Test
    public void keepsTheManifestThroughExtensionlessSegments() {
        // Measured 2026-10-09 on MoviesAPI: the forty newest requests were all segments.
        MediaCapture.record(request(0, "api/resolve"));
        MediaCapture.record(request(1, "hls/master"));
        for (int n = 2; n < 300; n++) MediaCapture.record(request(n, "seg/" + n));
        MediaCapture.Candidate[] candidates = MediaCapture.candidates();
        int at = -1;
        for (int i = 0; i < candidates.length; i++) {
            if (candidates[i].url.endsWith("hls/master")) at = i;
        }
        assertTrue("the manifest is kept", at >= 0);
        assertTrue("within the first two dozen", at < 24);
    }

    @Test
    public void listsEachOnceFirstOnesThenTheRestNewestFirst() {
        for (int n = 0; n < 25; n++) MediaCapture.record(request(n, "seg/" + n));
        MediaCapture.Candidate[] candidates = MediaCapture.candidates();
        assertEquals(25, candidates.length);
        assertEquals(19, candidates[0].atMs);
        assertEquals(0, candidates[19].atMs);
        assertEquals(24, candidates[20].atMs);
        assertEquals(20, candidates[24].atMs);
    }

    @Test
    public void clearForgetsTheFirstOnesToo() {
        MediaCapture.record(request(0, "hls/master"));
        MediaCapture.clear();
        MediaCapture.record(request(1, "seg/1"));
        assertEquals(1, MediaCapture.candidates().length);
    }
}
