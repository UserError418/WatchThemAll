package net.watchthemall.app;

import com.getcapacitor.BridgeActivity;

/**
 * Deliberately empty.
 *
 * An earlier version of this file forced the window edge to edge itself, which
 * was the wrong layer: Capacitor 8 already owns that decision in its built-in
 * `SystemBars` handler, and the two fought. What the app needs from the window
 * is expressed where the framework reads it — `capacitor.config.ts` for the
 * bar style, `styles.xml` for the background behind the bars, and
 * `mobile.css` for the insets. See the comment in `styles.xml`.
 */
public class MainActivity extends BridgeActivity {}
