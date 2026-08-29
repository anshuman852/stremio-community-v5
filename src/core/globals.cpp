#include "globals.h"

// Window & instance
TCHAR  szWindowClass[]   = APP_NAME;
TCHAR  szTitle[]         = APP_TITLE;

HINSTANCE g_hInst   = nullptr;
HWND      g_hWnd    = nullptr;
HBRUSH    g_darkBrush = nullptr;
HANDLE    g_hMutex  = nullptr;
HHOOK     g_hMouseHook = nullptr;

std::vector<std::wstring> g_webuiUrls = {
    L"https://stremio.zarg.me/",
    L"https://zaarrg.github.io/stremio-web-shell-fixes/",
    L"https://web.stremio.com/"
};
std::vector<std::wstring> g_domainWhitelist;
std::string  g_updateUrl= "https://raw.githubusercontent.com/anshuman852/stremio-community-v5/refs/heads/webview-windows/version/version.json";
std::wstring  g_extensionsDetailsUrl= L"https://raw.githubusercontent.com/Zaarrg/stremio-desktop-v5/refs/heads/webview-windows/extensions/extensions.json";
std::wstring  g_webuiUrl;

// Command-line args
bool g_streamingServer      = true;
bool g_autoupdaterForceFull = false;

// mpv
mpv_handle* g_mpv = nullptr;
std::set<std::string> g_observedProps;
bool g_initialSet = false;
std::string g_initialVO = "gpu-next";
int g_currentVolume = 50;
const std::vector<std::wstring> g_subtitleExtensions = {
    L".srt", L".ass", L".ssa", L".sub", L".vtt", L".ttml",
    L".dfxp", L".smi", L".sami", L".sup", L".scc",
    L".xml", L".lrc", L".pjs", L".mpl", L".usf",
    L".qtvr"
};
// Security: default-deny allow-lists (populated in LoadSettings)
std::unordered_set<std::string> g_mpvCommandAllowlist;
std::unordered_set<std::string> g_mpvSetPropAllowlist;

// Node
std::atomic_bool g_nodeRunning = false;
std::thread      g_nodeThread;
HANDLE           g_nodeProcess = nullptr;
HANDLE           g_nodeOutPipe = nullptr;
HANDLE           g_nodeInPipe  = nullptr;

// WebView2
wil::com_ptr<ICoreWebView2Controller4> g_webviewController;
wil::com_ptr<ICoreWebView2Profile8>    g_webviewProfile;
wil::com_ptr<ICoreWebView2_21>         g_webview;

// Tray
std::vector<MenuItem> g_menuItems;
NOTIFYICONDATA  g_nid        = {0};
bool            g_showWindow = true;
bool            g_alwaysOnTop= false;
bool            g_isFullscreen = false;
bool            g_closeOnExit = false;
bool            g_useDarkTheme = false;
bool            g_isPipMode = false;
int             g_thumbFastHeight = 0;
int             g_hoverIndex = -1;
HFONT           g_hMenuFont = nullptr;
HANDLE          g_serverJob  = nullptr;
HWND            g_trayHwnd   = nullptr;

// Ini Settings
bool g_pauseOnMinimize   = true;
bool g_pauseOnLostFocus  = false;
bool g_allowZoom         = false;
bool g_isRpcOn = true;

// Tray sizes
int g_tray_itemH = 31;
int g_tray_sepH  = 8;
int g_tray_w     = 200;
int g_font_height    = 12;

// Splash
HWND       g_hSplash      = nullptr;
HBITMAP    g_hSplashImage = nullptr;
float      g_splashOpacity= 1.0f;
int        g_pulseDirection = -1;
ULONG_PTR  g_gdiplusToken = 0;

// Pending messages
std::vector<nlohmann::json> g_outboundMessages;
std::wstring g_launchProtocol;
std::atomic<bool>  g_isAppReady   = false;
std::atomic<bool>  g_waitStarted(false);

// Extensions
std::map<std::wstring, std::wstring> g_extensionMap;
std::vector<std::wstring> g_scriptQueue;

// Updater
std::atomic_bool       g_updaterRunning = false;
std::filesystem::path  g_installerPath;
std::thread            g_updaterThread;
const char* public_key_pem = R"(-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2zOOE5XpcoLRGpSjoYs8
RiNsiKMbfCu7PclTQd4RuBXsI1ds5L5ovikZsvvuQsVK9hr0hXv4KSTJwdC5RbdJ
MCxel0t87eK03MFWNl36tkysYhtWwJQHAdkxMgST2NvILG/T8iYinQHF7CqEl/vc
MMMktVP1RJr3V/hulyZ9hsPZeflEY9PmeLOs1GXEZcFU6vhGRon8eto7yXiStlOU
f3u6EtFsOPn+5aOXzt5YZKMOZslvVXGWI1R/GVmiEhsqjgSmg1UYz2z2CMs8Xr02
wxLGDi/Ard0q/ocANq1SK/t0oNWseFdfHVtBZWeQeXwKDCm2VKVnIjxI3gA9JUqi
6QIDAQAB
-----END PUBLIC KEY-----)";

// ThumbFast
std::atomic<bool> g_ignoreHover(false);
std::chrono::steady_clock::time_point g_ignoreUntil;
