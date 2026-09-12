/**
 * Does this device have a pointer that can hover?
 *
 * The renderer is shared verbatim between the Electron app and the Android
 * one, and it deliberately has no platform branch — no user-agent test, no
 * build flag. This is not one either: `(hover: hover)` is a question about the
 * *input device*, which is the thing the answer actually depends on. A desktop
 * with a touchscreen and a phone with a mouse both get the right answer, and
 * neither the desktop build nor the phone build has to be told which it is.
 *
 * It matters because a touch device fires a synthetic `mouseenter` on tap and
 * then never fires `mouseleave`. Anything that treats "the pointer arrived" as
 * a state to be undone later therefore latches: `TitleCard` started a trailer
 * 560 ms after a tap, behind the detail overlay that same tap had opened, and
 * kept it playing — with the audio — until the user happened to tap somewhere
 * else.
 *
 * Read at call time rather than cached, like `motion.ts`'s reduced-motion
 * check: a phone with a mouse attached mid-session should get the mouse
 * behaviour without a reload.
 */
export function canHover(): boolean {
  return window.matchMedia('(hover: hover)').matches
}
