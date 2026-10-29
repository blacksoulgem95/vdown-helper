"""Ask the X11 windows titled argv[1] to close, as a window manager's close button does (WM_DELETE_WINDOW).

The desktop app's E2E uses it to check that closing the window keeps the app in the tray: WebDriver's own "close
window" ends the session instead. Needs only libX11 (no xdotool, no window manager). Prints how many windows it asked.
"""

import ctypes
import ctypes.util
import sys

x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XQueryTree.argtypes = [
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
    ctypes.POINTER(ctypes.c_uint),
]
x11.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]


class ClientMessage(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


class XEvent(ctypes.Union):
    _fields_ = [("client", ClientMessage), ("pad", ctypes.c_long * 24)]


CLIENT_MESSAGE = 33


def windows(display, w):
    root, parent = ctypes.c_ulong(), ctypes.c_ulong()
    children, n = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    if not x11.XQueryTree(display, w, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(n)):
        return
    kids = [children[i] for i in range(n.value)]
    if children:
        x11.XFree(children)
    for k in kids:
        yield k
        yield from windows(display, k)


def main():
    title = sys.argv[1].encode()
    display = x11.XOpenDisplay(None)
    if not display:
        sys.exit("no X display")
    protocols = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
    delete = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
    asked = 0
    for w in windows(display, x11.XDefaultRootWindow(display)):
        name = ctypes.c_char_p()
        if x11.XFetchName(display, w, ctypes.byref(name)) and name.value is not None:
            matches = name.value == title
            x11.XFree(name)
            if matches:
                ev = XEvent()
                ev.client.type = CLIENT_MESSAGE
                ev.client.window = w
                ev.client.message_type = protocols
                ev.client.format = 32
                ev.client.data[0] = delete
                x11.XSendEvent(display, w, 0, 0, ctypes.byref(ev))
                asked += 1
    x11.XFlush(display)
    x11.XCloseDisplay(display)
    print(asked)


main()
