package net.watchthemall.app;

import android.content.Context;

import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;

import java.util.List;

/**
 * How the Cast SDK is configured. Found by name from the manifest, never
 * constructed by us.
 *
 * ## Why the Default Media Receiver
 *
 * Casting can either launch a *custom receiver* — a web app of ours running on
 * the Chromecast — or Google's Default Media Receiver, which plays a URL it is
 * handed. A custom receiver would mean registering an application with the Cast
 * Developer Console, paying its fee, hosting the receiver page, and keeping
 * both in step with the app.
 *
 * None of that buys anything here. The usual reason to write a custom receiver
 * is to attach credentials or headers to the media request, and this app solves
 * that a layer lower: `CastProxyServer` puts the provider's headers on the
 * request before it ever leaves the phone, so what the receiver fetches is an
 * ordinary, open HLS stream. The default receiver plays HLS natively.
 *
 * `CC1AD845` is Google's published id for it and needs no registration.
 */
public final class CastOptionsProvider implements OptionsProvider {

    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
            .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
            /*
             * Do not hand the session back to whoever was casting before.
             *
             * Resumption replays the *previous* media description, and these
             * stream URLs are short-lived — the manifests captured at 09:56 on
             * 2026-09-13 answered 401 by 17:50 the same day. A resumed session
             * would reliably reconnect to a stream that no longer exists, which
             * is a worse outcome than simply not resuming.
             */
            .setResumeSavedSession(false)
            .setEnableReconnectionService(false)
            .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
