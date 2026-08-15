// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Forcing software WebKit compositing (an earlier attempt at this same
    // fix) did not resolve the symptoms below and is a much heavier
    // hammer than the actual problem calls for, so it's gone. What's
    // actually breaking — tooltips not closing on pointer-leave,
    // dropdowns not closing on outside click, and mouse-wheel/touchpad
    // scroll not registering at all in some scroll containers — is
    // consistent with GTK's native-Wayland input backend (not WebKit's
    // renderer) mishandling event delivery to this webview, a
    // long-documented rough edge for WebKitGTK apps under wlroots
    // compositors (Hyprland here). Forcing GDK onto XWayland routes
    // pointer/wheel/focus events through X11's much more mature event
    // pipeline instead, which is the standard workaround. Must be set
    // before GTK initializes, i.e. before `run()`.
    //
    // Unconditional, not "only if unset": this desktop's default session
    // environment already exports `GDK_BACKEND=wayland,x11` (Hyprland's
    // own default, not something the user set for this app specifically),
    // and GDK tries entries left-to-right — so a "respect an existing
    // value" guard here silently kept picking native Wayland anyway and
    // made this fix a no-op. Forcing it to plain `x11` is what actually
    // changes the backend Maestro's window uses.
    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11")
    };

    maestro_lib::run()
}
